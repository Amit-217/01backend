const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const mongoUri = process.env.TEST_MONGO_URI;
const webOrigin = 'http://localhost:8081';
const browser = (request, origin = webOrigin) => request
  .set('Origin', origin)
  .set('X-Viplora-Client', 'web');

const refreshCookie = (response) => {
  const cookie = response.headers['set-cookie']?.find((value) => value.startsWith('viplora_refresh='));
  assert.ok(cookie, 'Expected a browser refresh cookie');
  assert.match(cookie, /; HttpOnly(?:;|$)/i);
  assert.match(cookie, /; SameSite=Lax(?:;|$)/i);
  assert.match(cookie, /; Path=\/api\/auth(?:;|$)/i);
  return cookie.split(';')[0];
};

test('phone and browser sessions rotate independently and logout is scoped', {
  skip: !mongoUri && 'Set TEST_MONGO_URI to run the MongoDB session integration test.',
  timeout: 30_000,
}, async () => {
  process.env.NODE_ENV = 'test';
  process.env.EMAIL_HOST = '';
  process.env.WEB_ORIGINS = webOrigin;
  process.env.JWT_ACCESS_SECRET = randomUUID();

  const mongoose = require('mongoose');
  const request = require('supertest');
  const app = require('../src/app');
  const { hashPassword } = require('../src/common/utils/helpers');
  const Tenant = require('../src/modules/tenant/tenant/tenant.model');
  const User = require('../src/modules/tenant/users/user.model');
  const dbName = `viplora_session_test_${randomUUID().replaceAll('-', '')}`;

  try {
    await mongoose.connect(mongoUri, { dbName, serverSelectionTimeoutMS: 5_000 });
    assert.equal(mongoose.connection.name, dbName, 'Expected the isolated test database');
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));

    const email = 'admin@viplora-session.example';
    const password = 'SessionTest1324!';
    const tenantId = 'TEN-SESSION';
    await Tenant.create({
      tenantId, name: 'Session Test Company', email, emailVerified: true, status: 'active',
      otp: 'test-company-code-hash', adminOtpHash: 'test-admin-code-hash', onboardingTokenHash: 'test-grant-hash',
    });
    await User.create({
      userId: 'USR-SESSION', tenantId, firstName: 'Test', email, password: await hashPassword(password),
      emailVerified: true, status: 'active', role: 'admin',
    });

    const api = request(app);
    const credentials = { email, password };
    const phone = await api.post('/api/auth/login').send(credentials).expect(200);
    assert.equal(phone.headers['set-cookie'], undefined);
    assert.equal(typeof phone.body.data.refreshToken, 'string');

    const web = await browser(api.post('/api/auth/login')).send(credentials).expect(200);
    assert.equal(web.headers['access-control-allow-origin'], webOrigin);
    assert.equal(web.headers['access-control-allow-credentials'], 'true');
    assert.equal(web.body.data.refreshToken, undefined);
    assert.notEqual(web.body.data.accessToken, phone.body.data.accessToken);
    const initialWebCookie = refreshCookie(web);

    const tenant = await api.get('/api/tenants/me').auth(phone.body.data.accessToken, { type: 'bearer' }).expect(200);
    assert.equal(tenant.body.data.tenantId, tenantId);
    assert.equal(tenant.body.data.name, 'Session Test Company');
    assert.deepEqual(Object.keys(tenant.body.data).sort(), [
      'createdAt', 'email', 'emailVerified', 'name', 'status', 'tenantId', 'updatedAt',
    ]);

    const rejected = await browser(api.post('/api/auth/refresh-token'), 'https://unapproved.example')
      .set('Cookie', initialWebCookie).send({}).expect(403);
    assert.equal(rejected.headers['access-control-allow-origin'], undefined);
    await browser(api.post('/api/auth/refresh-token')).send({}).expect(401);

    const rotatedWeb = await browser(api.post('/api/auth/refresh-token'))
      .set('Cookie', initialWebCookie).send({}).expect(200);
    assert.equal(rotatedWeb.body.data.refreshToken, undefined);
    const currentWebCookie = refreshCookie(rotatedWeb);
    assert.notEqual(currentWebCookie, initialWebCookie);
    const replay = await browser(api.post('/api/auth/refresh-token'))
      .set('Cookie', initialWebCookie).send({}).expect(401);
    assert.equal(replay.headers['set-cookie'], undefined, 'A stale refresh must preserve the current cookie');

    const refreshPhone = (refreshToken) => api.post('/api/auth/refresh-token').send({ refreshToken });
    const racingPhone = await Promise.all([
      refreshPhone(phone.body.data.refreshToken),
      refreshPhone(phone.body.data.refreshToken),
    ]);
    assert.deepEqual(racingPhone.map((response) => response.status).sort(), [200, 401]);
    const currentPhone = racingPhone.find((response) => response.status === 200).body.data;
    assert.notEqual(currentPhone.refreshToken, phone.body.data.refreshToken);

    const logout = await browser(api.post('/api/auth/logout'))
      .auth(rotatedWeb.body.data.accessToken, { type: 'bearer' })
      .set('Cookie', currentWebCookie).expect(200);
    assert.equal(refreshCookie(logout), 'viplora_refresh=');
    await browser(api.post('/api/auth/refresh-token'))
      .set('Cookie', currentWebCookie).send({}).expect(401);
    await api.get('/api/tenants/me').auth(rotatedWeb.body.data.accessToken, { type: 'bearer' }).expect(401);
    await api.get('/api/tenants/me').auth(currentPhone.accessToken, { type: 'bearer' }).expect(200);
    await refreshPhone(currentPhone.refreshToken).expect(200);

    const oldTab = await browser(api.post('/api/auth/login')).send(credentials).expect(200);
    const newTab = await browser(api.post('/api/auth/login')).send(credentials).expect(200);
    const newTabCookie = refreshCookie(newTab);
    const oldTabLogout = await browser(api.post('/api/auth/logout'))
      .auth(oldTab.body.data.accessToken, { type: 'bearer' })
      .set('Cookie', newTabCookie).expect(200);
    assert.equal(oldTabLogout.headers['set-cookie'], undefined);
    await browser(api.post('/api/auth/refresh-token')).set('Cookie', newTabCookie).send({}).expect(200);
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
