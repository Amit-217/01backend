const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const mongoUri = process.env.TEST_MONGO_URI;

test('team invitations, admin-only reads, reactivation, admin roles, and code cooldowns', {
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

  const mongoose = require('mongoose');
  const nodemailer = require('nodemailer');
  const request = require('supertest');
  const mail = [];
  t.mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async (message) => { mail.push(message); },
  }));

  const app = require('../src/app');
  const User = require('../src/modules/tenant/users/user.model');
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
    const ownerId = ownerLogin.body.data.user.userId;

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
    await staff.get('/api/users/' + ownerId).expect(403);
    const team = await owner.get('/api/users').expect(200);
    assert.deepEqual(team.body.data.map((user) => user.role).sort(), ['admin', 'employee']);

    // Resends inside a minute reuse the live code instead of mailing another.
    const pendingEmail = 'pending@example.test';
    const pending = await owner.post('/api/users', { firstName: 'Pending', email: pendingEmail }).expect(201);
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
