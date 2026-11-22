const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const mongoUri = process.env.TEST_MONGO_URI;

test('read-only companies keep reading and lose writes; suspended companies cannot sign in', {
  skip: !mongoUri && 'Set TEST_MONGO_URI to run this test against a MongoDB replica set.',
  timeout: 60_000,
}, async (t) => {
  Object.assign(process.env, {
    NODE_ENV: 'test', EMAIL_HOST: 'mock-smtp.example', EMAIL_PORT: '587', EMAIL_USER: 'no-reply@example.test',
    EMAIL_PASS: 'test-only', EMAIL_FROM: 'no-reply@example.test', JWT_ACCESS_SECRET: randomUUID(),
    SUPPORT_NAME: 'Viplora Billing', SUPPORT_PHONE: '+91 98765 43210', SUPPORT_EMAIL: 'billing@example.test',
  });
  const mongoose = require('mongoose');
  const nodemailer = require('nodemailer');
  const request = require('supertest');
  const mail = [];
  t.mock.method(nodemailer, 'createTransport', () => ({ sendMail: async (message) => { mail.push(message); } }));
  const app = require('../src/app');
  const Tenant = require('../src/modules/tenant/tenant/tenant.model');
  const { setAccess } = require('../src/modules/platform/platform.service');
  const dbName = `viplora_access_test_${randomUUID().replaceAll('-', '')}`;
  const getCode = (email, purpose) => mail.findLast((item) => item.to === email && item.subject.endsWith(purpose))
    .text.match(/\b\d{6}\b/)[0];

  try {
    await mongoose.connect(mongoUri, { dbName, serverSelectionTimeoutMS: 5_000 });
    assert.equal(mongoose.connection.name, dbName);
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    const api = request(app);
    const auth = (path, body) => api.post('/api/auth/' + path).send(body);
    const password = 'AdminPassword1324!';
    const email = 'owner@access.test';
    await auth('register', { name: 'Access Test Co', email }).expect(201);
    const verified = await auth('verify-email', { email, otp: getCode(email, 'company email verification') }).expect(200);
    const { tenantId, onboardingToken } = verified.body.data;
    await auth('register-admin', { firstName: 'Owner', password, confirmPassword: password, companyEmail: email, adminEmail: email, onboardingToken }).expect(201);
    const login = await auth('login', { email, password }).expect(200);
    const token = login.body.data.accessToken;
    const as = {
      get: (path) => api.get(path).auth(token, { type: 'bearer' }),
      send: (method, path, body) => api[method](path).auth(token, { type: 'bearer' }).send(body),
    };
    const invited = await as.send('post', '/api/users', { firstName: 'Leaver', email: 'leaver@access.test' }).expect(201);
    const transact = (session) => mongoose.connection.transaction((s) => setAccess(tenantId, session, s));

    // Read-only: sessions survive, reads work, writes are refused with the support contact.
    await transact('read_only');
    const me = await as.get('/api/tenants/me').expect(200);
    assert.equal(me.body.data.access, 'read_only');
    assert.equal(me.body.data.support.phone, '+91 98765 43210');
    assert.equal(me.body.data.paidUntil, undefined, 'Billing details stay internal');
    await as.get('/api/v1/raw-material-categories').expect(200);
    const refused = await as.send('post', '/api/v1/raw-material-categories', { name: 'Blocked' }).expect(403);
    assert.equal(refused.body.details.code, 'WORKSPACE_READ_ONLY');
    assert.match(refused.body.message, /billing@example\.test/);
    await as.send('post', '/api/users', { firstName: 'New', email: 'new@access.test' }).expect(403);
    await as.send('delete', '/api/users/' + invited.body.data.userId).expect(200);
    await auth('login', { email, password }).expect(200);

    // Full access restores writes.
    await transact('full');
    await as.send('post', '/api/v1/raw-material-categories', { name: 'Allowed' }).expect(201);

    // Suspended: sessions end and sign-in explains why.
    await transact('suspended');
    await as.get('/api/tenants/me').expect(401);
    const blocked = await auth('login', { email, password }).expect(403);
    assert.match(blocked.body.message, /paused.*Viplora Billing/);
    assert.equal((await Tenant.findOne({ tenantId })).status, 'inactive');

    // Restoring to read-only allows sign-in again but still no writes.
    await transact('read_only');
    const back = await auth('login', { email, password }).expect(200);
    await api.post('/api/v1/raw-material-categories').auth(back.body.data.accessToken, { type: 'bearer' }).send({ name: 'Still blocked' }).expect(403);
  } finally {
    try {
      if (mongoose.connection.readyState === 1 && mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    } finally {
      await mongoose.disconnect();
    }
  }
});
