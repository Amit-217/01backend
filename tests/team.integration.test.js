const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');

const mongoUri = process.env.TEST_MONGO_URI;

test('team invitations, subscription seats, administrator protection, and sign-in recovery', {
  skip: !mongoUri && 'Set TEST_MONGO_URI to run this test against a MongoDB replica set.',
  timeout: 60_000,
}, async (t) => {
  process.env.NODE_ENV = 'test';
  process.env.EMAIL_HOST = 'mock-smtp.example';
  process.env.EMAIL_PORT = '587';
  process.env.EMAIL_USER = 'no-reply@example.test';
  process.env.EMAIL_PASS = 'test-only';
  process.env.EMAIL_FROM = 'no-reply@example.test';
  process.env.JWT_ACCESS_SECRET = randomUUID();
  process.env.PLATFORM_TOTP_KEY = randomBytes(32).toString('base64');

  const mongoose = require('mongoose');
  const nodemailer = require('nodemailer');
  const request = require('supertest');
  const mail = [];
  t.mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async (message) => { mail.push(message); },
  }));

  const app = require('../src/app');
  const User = require('../src/modules/tenant/users/user.model');
  const Tenant = require('../src/modules/tenant/tenant/tenant.model');
  const { PlatformStaff } = require('../src/modules/platform/platform.model');
  const { seal, totpCode } = require('../src/modules/platform/platform.totp');
  const { hashPassword } = require('../src/common/utils/helpers');
  const dbName = `viplora_team_test_${randomUUID().replaceAll('-', '')}`;
  const getCode = (email, purpose) => {
    const message = mail.findLast((item) => item.to === email && item.subject.endsWith(purpose));
    assert.ok(message, `No ${purpose} message captured for ${email}`);
    return message.text.match(/\b\d{6}\b/)[0];
  };
  const mailTo = (email) => mail.filter((item) => item.to === email).length;

  try {
    await mongoose.connect(mongoUri, { dbName, serverSelectionTimeoutMS: 5_000 });
    assert.equal(mongoose.connection.name, dbName, 'Expected the isolated test database');
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));

    const api = request(app);
    const auth = (path, payload) => api.post('/api/auth/' + path).send(payload);
    const password = 'AdminPassword1324!';
    const as = (token) => ({
      get: (path) => api.get(path).auth(token, { type: 'bearer' }),
      post: (path, body) => api.post(path).auth(token, { type: 'bearer' }).send(body),
      patch: (path, body) => api.patch(path).auth(token, { type: 'bearer' }).send(body),
      delete: (path) => api.delete(path).auth(token, { type: 'bearer' }),
    });

    // Company whose admin uses the verified company email.
    const companyEmail = 'owner@example.test';
    await auth('register', { name: 'Team Test Co', email: companyEmail }).expect(201);
    const verified = await auth('verify-email', { email: companyEmail, otp: getCode(companyEmail, 'company email verification') }).expect(200);
    await auth('register-admin', {
      firstName: 'Owner', password, confirmPassword: password, companyEmail, adminEmail: companyEmail,
      onboardingToken: verified.body.data.onboardingToken,
    }).expect(201);
    const ownerLogin = await auth('login', { email: companyEmail, password }).expect(200);
    const owner = as(ownerLogin.body.data.accessToken);
    const { userId: ownerId, tenantId } = ownerLogin.body.data.user;

    const platformLogin = async (role) => {
      const secret = randomBytes(20);
      const email = role + '@example.test';
      await PlatformStaff.create({ name: role, email, role, passwordHash: await hashPassword(password), totpSecret: seal(secret) });
      const result = await api.post('/api/platform/auth/login').send({
        email, password, code: totpCode(secret, Math.floor(Date.now() / 30_000)),
      }).expect(200);
      return as(result.body.data.token);
    };
    const operator = await platformLogin('operator');
    const reader = await platformLogin('support');
    const company = '/api/platform/tenants/' + tenantId;
    const context = { caseReference: 'TKT-123', reason: 'Configure company subscription' };
    const billing = { ...context, paidUntil: '2028-02-29', teamLimits: { admin: 2, employee: 2 } };

    const capacity = async (actor = owner, path = '/api/users/capacity') => (await actor.get(path).expect(200)).body.data;
    assert.deepEqual(await capacity(), { limits: { admin: null, employee: null }, usage: { admin: 1, employee: 0 } });
    await owner.post('/api/users', { firstName: 'Blocked', email: 'blocked@example.test' }).expect(409);
    await owner.post(company + '/billing', billing).expect(401);
    await reader.post(company + '/billing', billing).expect(403);
    await operator.post(company + '/billing', { ...billing, teamLimits: { admin: 0, employee: 2 } }).expect(400);
    await operator.post(company + '/billing', { ...billing, teamLimits: { admin: 1, employee: -1 } }).expect(400);
    await operator.post(company + '/billing', { ...billing, paidUntil: '2027-02-29' }).expect(400);
    await operator.post(company + '/billing', { ...billing, paidUntil: '2028-02-30' }).expect(400);
    await operator.post(company + '/billing', { ...billing, teamLimits: { admin: 1, employee: 0 } }).expect(200);
    await owner.post('/api/users', { firstName: 'Blocked', email: 'blocked@example.test' }).expect(409);
    const updatedBilling = await operator.post(company + '/billing', billing).expect(200);
    assert.equal(updatedBilling.body.data.paidUntil, '2028-02-29T00:00:00.000Z');
    assert.deepEqual(await capacity(reader, company + '/team-capacity'), {
      limits: billing.teamLimits, usage: { admin: 1, employee: 0 },
    });
    await operator.post(company + '/users/' + ownerId + '/status', { ...context, status: 'inactive' }).expect(409);

    await Tenant.create({ tenantId: 'other-team', name: 'Other company', email: 'other@example.test', status: 'active' });
    await User.create({
      tenantId: 'other-team', userId: 'other-owner', firstName: 'Other Owner', role: 'admin',
      email: 'other@example.test', password: await hashPassword(password), emailVerified: true,
    });
    await owner.get('/api/users/other-owner').expect(404);
    await owner.patch('/api/users/other-owner', { firstName: 'Other name' }).expect(404);
    await operator.post(company + '/users/other-owner/status', { ...context, status: 'inactive' }).expect(404);
    await reader.get('/api/platform/tenants/unknown-team/team-capacity').expect(404);

    // Invite without a password: the employee chooses it while verifying.
    const staffEmail = 'staff@example.test';
    const invite = await owner.post('/api/users', { firstName: 'Stock', lastName: 'Keeper', email: staffEmail }).expect(201);
    const staffId = invite.body.data.userId;
    const staffCode = getCode(staffEmail, 'employee email verification');
    const verify = { email: staffEmail, purpose: 'employee_email_verification', otp: staffCode };
    const staffPassword = 'ChosenByStaff1324!';
    await auth('verify-email', verify).expect(400);
    await auth('verify-email', { ...verify, newPassword: staffPassword, confirmPassword: 'Different1324!' }).expect(400);
    await auth('verify-email', { ...verify, newPassword: staffPassword, confirmPassword: staffPassword }).expect(200);
    const staffLogin = await auth('login', { email: staffEmail, password: staffPassword }).expect(200);
    const staff = as(staffLogin.body.data.accessToken);

    // Team reads are admin-only.
    await staff.get('/api/users').expect(403);
    await staff.get('/api/users/capacity').expect(403);
    await staff.get('/api/users/' + ownerId).expect(403);
    const team = await owner.get('/api/users').expect(200);
    assert.deepEqual(team.body.data.map((user) => user.role).sort(), ['admin', 'employee']);

    // Resends inside a minute reuse the live code instead of mailing another.
    const pendingEmail = 'pending@example.test';
    const pending = await owner.post('/api/users', { firstName: 'Pending', email: pendingEmail }).expect(201);
    assert.equal((await capacity()).usage.employee, 2, 'Pending invites reserve a seat');
    await owner.post('/api/users', { firstName: 'Blocked', email: 'blocked@example.test' }).expect(409);
    await operator.post(company + '/billing', { ...billing, teamLimits: { admin: 2, employee: 1 } }).expect(409);
    const sentBefore = mailTo(pendingEmail);
    await auth('resend-otp', { email: pendingEmail, purpose: 'employee_email_verification' }).expect(200);
    assert.equal(mailTo(pendingEmail), sentBefore, 'A resend inside the cooldown must not send another email');
    await auth('forgot-password', { email: staffEmail }).expect(200);
    const resetMails = mailTo(staffEmail);
    await auth('forgot-password', { email: staffEmail }).expect(200);
    assert.equal(mailTo(staffEmail), resetMails, 'A second reset request inside the cooldown must not send another email');

    // A verified reset code gives a fresh window to choose the password.
    await auth('verify-reset-otp', { email: staffEmail, otp: getCode(staffEmail, 'password reset') }).expect(200);
    const afterVerify = await User.findOne({ email: staffEmail }).lean();
    assert.ok(afterVerify.otpExpiresAt.getTime() > Date.now() + 9 * 60_000, 'Expected the reset window to restart');

    // Admin role rules.
    await owner.patch('/api/users/' + ownerId, { role: 'employee' }).expect(409);
    await owner.patch('/api/users/' + pending.body.data.userId, { role: 'admin' }).expect(409);
    await owner.patch('/api/users/' + staffId, { role: 'admin' }).expect(200);
    await staff.get('/api/tenants/me').expect(401);
    const promotedLogin = await auth('login', { email: staffEmail, password: staffPassword }).expect(200);
    assert.equal(promotedLogin.body.data.user.role, 'admin');
    await owner.patch('/api/users/' + staffId, { firstName: 'Renamed' }).expect(409);
    await owner.delete('/api/users/' + staffId).expect(404);
    await owner.patch('/api/users/' + staffId, { role: 'employee' }).expect(200);

    // Deactivate, find in the deactivated list, block re-adding, then reactivate.
    await owner.delete('/api/users/' + staffId).expect(200);
    const active = await owner.get('/api/users').expect(200);
    assert.ok(!active.body.data.some((user) => user.userId === staffId));
    const inactive = await owner.get('/api/users?status=inactive').expect(200);
    assert.deepEqual(inactive.body.data.map((user) => user.userId), [staffId]);
    const readd = await owner.post('/api/users', { firstName: 'Stock', email: staffEmail }).expect(409);
    assert.match(readd.body.message, /deactivated employee/);
    await auth('login', { email: staffEmail, password: staffPassword }).expect(403);
    await owner.patch('/api/users/' + staffId, { status: 'active' }).expect(200);
    await auth('login', { email: staffEmail, password: staffPassword }).expect(200);

    // Two simultaneous invitations cannot both fill one vacancy.
    const pendingId = pending.body.data.userId;
    await owner.delete('/api/users/' + pendingId).expect(200);
    assert.equal((await capacity()).usage.employee, 1);
    const race = await Promise.all(['first', 'second'].map((name) => owner.post('/api/users', {
      firstName: name, email: name + '@example.test',
    })));
    assert.deepEqual(race.map((res) => res.status).sort(), [201, 409]);
    assert.equal((await capacity()).usage.employee, 2);
    await owner.patch('/api/users/' + pendingId, { status: 'active' }).expect(409);
    await operator.post(company + '/users/' + pendingId + '/status', { ...context, status: 'active' }).expect(409);
    await owner.delete('/api/users/' + race.find((res) => res.status === 201).body.data.userId).expect(200);
    const stillPending = await owner.patch('/api/users/' + pendingId, { status: 'active' }).expect(200);
    assert.equal(stillPending.body.data.emailVerified, false);
    assert.equal((await capacity()).usage.employee, 2);

    // Per-account lock: the tenth wrong password locks sign-in, even with the right password; a reset unlocks.
    for (let attempt = 1; attempt < 10; attempt += 1) {
      await auth('login', { email: staffEmail, password: 'WrongPassword1324!' }).expect(401);
    }
    await auth('login', { email: staffEmail, password: 'WrongPassword1324!' }).expect(429);
    await auth('login', { email: staffEmail, password: staffPassword }).expect(429);
    await User.updateOne({ email: staffEmail }, { $set: { otpSentAt: null } });
    await auth('forgot-password', { email: staffEmail }).expect(200);
    const unlockCode = getCode(staffEmail, 'password reset');
    await auth('verify-reset-otp', { email: staffEmail, otp: unlockCode }).expect(200);
    const unlocked = 'AfterLockout1324!';
    await auth('reset-password', { email: staffEmail, otp: unlockCode, newPassword: unlocked, confirmPassword: unlocked }).expect(200);
    await auth('login', { email: staffEmail, password: unlocked }).expect(200);

    // A platform promotion respects the admin cap. The plan can then allow the promotion.
    await operator.post(company + '/billing', { ...billing, teamLimits: { admin: 1, employee: 2 } }).expect(200);
    await owner.patch('/api/users/' + staffId, { role: 'admin' }).expect(409);
    await operator.post(company + '/users/' + staffId + '/role', { ...context, role: 'admin' }).expect(409);
    await operator.post(company + '/billing', billing).expect(200);
    await operator.post(company + '/users/' + staffId + '/role', { ...context, role: 'admin' }).expect(200);
    const secondAdmin = as((await auth('login', { email: staffEmail, password: unlocked }).expect(200)).body.data.accessToken);
    await operator.post(company + '/billing', { ...billing, teamLimits: { admin: 1, employee: 2 } }).expect(409);
    await operator.post(company + '/billing', { ...billing, teamLimits: { admin: 2, employee: 1 } }).expect(200);
    await owner.patch('/api/users/' + staffId, { role: 'employee' }).expect(409);
    await operator.post(company + '/users/' + staffId + '/role', { ...context, role: 'employee' }).expect(409);
    await operator.post(company + '/billing', billing).expect(200);
    const demotions = await Promise.all([
      owner.patch('/api/users/' + staffId, { role: 'employee' }),
      secondAdmin.patch('/api/users/' + ownerId, { role: 'employee' }),
    ]);
    assert.equal(demotions.filter((res) => res.status === 200).length, 1);
    assert.ok(demotions.some((res) => [401, 403, 409].includes(res.status)));
    assert.equal((await capacity(operator, company + '/team-capacity')).usage.admin, 1);
    const remainingAdmin = await User.findOne({ tenantId, role: 'admin', status: 'active' });
    await operator.post(company + '/users/' + remainingAdmin.userId + '/role', { ...context, role: 'employee' }).expect(409);
    await operator.post(company + '/users/' + remainingAdmin.userId + '/status', { ...context, status: 'inactive' }).expect(409);
    const audit = (await operator.get(company + '/audit').expect(200)).body.data.items;
    assert.ok(audit.some((event) => event.action === 'tenant.billing' && event.outcome === 'succeeded'
      && event.caseReference === context.caseReference && /2 administrators and 2 employees/.test(event.details)));
  } finally {
    try {
      if (mongoose.connection.readyState === 1 && mongoose.connection.name === dbName) {
        await mongoose.connection.dropDatabase();
      }
    } finally {
      await mongoose.disconnect();
    }
  }
});
