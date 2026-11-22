const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const mongoUri = process.env.TEST_MONGO_URI;

test('company signup, employee verification, and password reset through the API', {
  skip: !mongoUri && 'Set TEST_MONGO_URI to run this test against a MongoDB replica set.',
  timeout: 45_000,
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
  const dbName = `viplora_onboarding_test_${randomUUID().replaceAll('-', '')}`;
  const getCode = (email, purpose) => {
    const message = mail.findLast((item) => item.to === email && item.subject.endsWith(purpose));
    assert.ok(message, `No ${purpose} message captured for ${email}`);
    const code = message.text.match(/\b\d{6}\b/)?.[0];
    assert.ok(code, `No six-digit code captured for ${email}`);
    return code;
  };

  try {
    await mongoose.connect(mongoUri, { dbName, serverSelectionTimeoutMS: 5_000 });
    assert.equal(mongoose.connection.name, dbName, 'Expected the isolated test database');
    const topology = await mongoose.connection.db.command({ hello: 1 });
    assert.ok(topology.setName || topology.msg === 'isdbgrid', 'TEST_MONGO_URI must support MongoDB transactions');
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));

    const api = request(app);
    const auth = (path, payload) => api.post('/api/auth/' + path).send(payload);
    const oldPassword = 'InitialPassword1324!';
    const createAdmin = { firstName: 'Company', lastName: 'Administrator', password: oldPassword, confirmPassword: oldPassword };
    const verifyCompany = async (name, email) => {
      await auth('register', { name, email }).expect(201);
      const code = getCode(email, 'company email verification');
      const response = await auth('verify-email', { email, otp: code }).expect(200);
      assert.equal(typeof response.body.data.onboardingToken, 'string');
      return { ...response.body.data, code };
    };

    const companyEmail = 'company@example.test';
    const adminEmail = 'manager@example.test';
    const { tenantId, onboardingToken, code } = await verifyCompany('Viplora Alternate Admin', companyEmail);
    await auth('verify-email', { email: companyEmail, otp: code }).expect(400);
    await auth('send-admin-email-verification', { companyEmail, adminEmail }).expect(400);

    const alternate = { companyEmail, adminEmail, onboardingToken };
    await auth('send-admin-email-verification', alternate).expect(200);
    const adminCode = getCode(adminEmail, 'admin email verification');
    await auth('verify-admin-email', { ...alternate, adminEmail: 'other@example.test', otp: adminCode }).expect(400);
    await auth('verify-admin-email', { ...alternate, otp: adminCode }).expect(200);
    await auth('finalize-registration', { ...createAdmin, companyEmail, adminEmail }).expect(400);
    await auth('finalize-registration', { ...createAdmin, ...alternate, adminEmail: 'other@example.test' }).expect(400);

    const finalization = { ...createAdmin, ...alternate, companyName: 'Do not replace the verified name' };
    const results = await Promise.all([
      auth('finalize-registration', finalization),
      auth('finalize-registration', finalization),
    ]);
    assert.equal(results.filter((response) => response.status === 201).length, 1);
    assert.ok(results.some((response) => [400, 409].includes(response.status)), 'The second finalization must be rejected');
    assert.equal(await User.countDocuments({ tenantId, role: 'admin' }), 1);

    const adminLogin = await auth('login', { email: adminEmail, password: oldPassword }).expect(200);
    const adminAccess = adminLogin.body.data.accessToken;
    const company = await api.get('/api/tenants/me').auth(adminAccess, { type: 'bearer' }).expect(200);
    assert.equal(company.body.data.tenantId, tenantId);
    assert.equal(company.body.data.name, 'Viplora Alternate Admin');

    const sameEmail = 'same-admin@example.test';
    const same = await verifyCompany('Viplora Same Admin', sameEmail);
    const mailCountBefore = mail.length;
    await auth('register-admin', {
      ...createAdmin, companyEmail: sameEmail, adminEmail: sameEmail, onboardingToken: same.onboardingToken,
    }).expect(201);
    assert.equal(mail.length, mailCountBefore, 'The verified company email needs no second OTP');
    assert.equal(await User.countDocuments({ tenantId: same.tenantId, role: 'admin' }), 1);

    const employeeEmail = 'employee@example.test';
    await api.post('/api/users').auth(adminAccess, { type: 'bearer' }).send({
      firstName: 'Stock', lastName: 'Operator', email: employeeEmail, password: oldPassword, confirmPassword: oldPassword,
    }).expect(201);
    await auth('login', { email: employeeEmail, password: oldPassword }).expect(403);
    const employeeCode = getCode(employeeEmail, 'employee email verification');
    await auth('verify-email', {
      email: employeeEmail, purpose: 'employee_email_verification', otp: employeeCode,
    }).expect(200);
    const employeeLogin = await auth('login', { email: employeeEmail, password: oldPassword }).expect(200);
    assert.equal(employeeLogin.body.data.user.role, 'employee');
    const employeeBearer = employeeLogin.body.data.accessToken;
    await api.get('/api/v1/raw-material-categories').auth(employeeBearer, { type: 'bearer' }).expect(200);
    await api.post('/api/v1/raw-material-categories').auth(employeeBearer, { type: 'bearer' })
      .send({ name: 'Restricted category' }).expect(403);

    await auth('forgot-password', { email: employeeEmail }).expect(200);
    const resetCode = getCode(employeeEmail, 'password reset');
    const reset = { email: employeeEmail, otp: resetCode, newPassword: 'ReplacementPassword1324!', confirmPassword: 'ReplacementPassword1324!' };
    await auth('reset-password', reset).expect(400);
    const verifiedReset = await auth('verify-reset-otp', { email: employeeEmail, otp: resetCode }).expect(200);
    assert.equal(verifiedReset.body.data.canReset, true);
    await auth('reset-password', reset).expect(200);
    await auth('login', { email: employeeEmail, password: oldPassword }).expect(401);
    await auth('login', { email: employeeEmail, password: reset.newPassword }).expect(200);
    await auth('refresh-token', { refreshToken: employeeLogin.body.data.refreshToken }).expect(401);
    await api.get('/api/tenants/me').auth(employeeLogin.body.data.accessToken, { type: 'bearer' }).expect(401);
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
