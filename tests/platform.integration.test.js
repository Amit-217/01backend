const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { test } = require('node:test');

const testUri = process.env.TEST_MONGO_URI;

test('tenant transaction audit and staff TOTP support workflows enforce scope and preserve stock', {
  skip: !testUri && 'Set TEST_MONGO_URI to a disposable replica set or sharded cluster.',
  timeout: 60_000,
}, async (t) => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET = randomUUID();
  process.env.PLATFORM_TOTP_KEY = randomBytes(32).toString('base64');
  process.env.EMAIL_HOST = 'mock-smtp.example';
  process.env.EMAIL_PORT = '587';
  process.env.EMAIL_USER = 'support@example.test';
  process.env.EMAIL_PASS = 'fixture-only';
  process.env.EMAIL_FROM = process.env.EMAIL_USER;

  const mongoose = require('mongoose');
  const request = require('supertest');
  const nodemailer = require('nodemailer');
  const messages = [];
  t.mock.method(nodemailer, 'createTransport', () => ({ sendMail: async (message) => { messages.push(message); } }));
  const app = require('../src/app');
  const Tenant = require('../src/modules/tenant/tenant/tenant.model');
  const User = require('../src/modules/tenant/users/user.model');
  const RawMaterial = require('../src/modules/raw_material/raw_material/raw.material.model');
  const Category = require('../src/modules/raw_material/category/category.model');
  const Movement = require('../src/modules/raw_material/material_transaction/material.transaction.model');
  const { PlatformStaff, PlatformAudit, PlatformSession, PlatformChange } = require('../src/modules/platform/platform.model');
  const { hashPassword } = require('../src/common/utils/helpers');
  const { seal, totpCode } = require('../src/modules/platform/platform.totp');

  const dbName = 'viplora_platform_test_' + randomUUID().replaceAll('-', '');
  const tenantId = 'tenant-a';
  const otherTenantId = 'tenant-b';
  const materials = '/api/v1/material-transactions';
  const platform = '/api/platform';
  const company = platform + '/tenants/' + tenantId;
  const otherCompany = platform + '/tenants/' + otherTenantId;
  const context = { caseReference: 'CASE-001', reason: 'Verify and correct the duplicate stock entry.' };
  const password = 'FixturePassword-8453';
  const authorized = (method, path, token) => request(app)[method](path).set('Authorization', 'Bearer ' + token);
  const login = async (email) => (await request(app).post('/api/auth/login').send({ email, password }).expect(200)).body.data;

  try {
    await mongoose.connect(testUri, { dbName, serverSelectionTimeoutMS: 5000 });
    assert.equal(mongoose.connection.name, dbName);
    const topology = await mongoose.connection.db.command({ hello: 1 });
    assert.ok(topology.setName || topology.msg === 'isdbgrid');
    await Promise.all([Movement, User, PlatformStaff, PlatformAudit, PlatformSession, PlatformChange]
      .map((model) => model.init()));

    await Tenant.create([
      { tenantId, name: 'Test Company A', email: 'company-a@example.test', status: 'active' },
      { tenantId: otherTenantId, name: 'Test Company B', email: 'company-b@example.test', status: 'active' },
    ]);
    const passwordHash = await hashPassword(password);
    const actorEmail = 'stock-clerk@example.test';
    await User.create([
      { tenantId, userId: 'admin-a', firstName: 'Asha', email: 'admin-a@example.test', role: 'admin', password: passwordHash, emailVerified: true },
      { tenantId, userId: 'stock-clerk', firstName: 'Dev', lastName: 'Patel', email: actorEmail, role: 'employee', password: passwordHash, emailVerified: true },
      { tenantId: otherTenantId, userId: 'admin-b', firstName: 'Bela', email: 'admin-b@example.test', role: 'admin', password: passwordHash, emailVerified: true },
    ]);
    const category = await Category.create({ tenantId, name: 'Materials' });
    const otherCategory = await Category.create({ tenantId: otherTenantId, name: 'Materials' });
    const [steel, copper, foreign] = await RawMaterial.create([
      { tenantId, name: 'Steel', code: 'STEEL', unit: 'kg', categoryId: category._id },
      { tenantId, name: 'Copper', code: 'CU', unit: 'kg', categoryId: category._id },
      { tenantId: otherTenantId, name: 'Foreign stock', code: 'FOREIGN', unit: 'kg', categoryId: otherCategory._id },
    ]);
    const [admin, employee, otherAdmin] = await Promise.all([
      login('admin-a@example.test'), login(actorEmail), login('admin-b@example.test'),
    ]);
    const receipt = (token, material, quantity) => authorized('post', materials, token).send({
      rawMaterialId: material._id, type: 'IN', direction: 'IN', quantity, referenceType: 'PURCHASE',
      date: '2026-11-19T02:00:00.000Z', tenantId: otherTenantId, createdBy: 'forged-actor',
    }).expect(201);
    const original = (await receipt(employee.accessToken, steel, 10)).body.data;
    assert.equal(original.createdBy, 'stock-clerk');
    assert.equal(original.stockBefore, undefined);
    assert.equal(original.actorName, undefined);
    const foreignEntry = (await receipt(otherAdmin.accessToken, foreign, 100)).body.data;
    await authorized('get', materials + '/audit', employee.accessToken).expect(403);
    await authorized('get', materials + '/audit/' + foreignEntry._id, admin.accessToken).expect(404);
    await authorized('get', materials + '/audit', admin.accessToken).query({ 'rawMaterialId[$ne]': 'x' }).expect(400);
    await User.updateOne({ tenantId, userId: 'stock-clerk' }, { $set: { firstName: 'Renamed' } });
    const movement = (await authorized('get', materials + '/audit/' + original._id, admin.accessToken).expect(200)).body.data;
    assert.deepEqual(movement.actor, { label: 'Dev Patel', role: 'employee' });
    assert.deepEqual([movement.stockBefore, movement.stockAfter, movement.stockUnit], [0, 10, 'kg']);

    const legacy = await Movement.create({
      tenantId, rawMaterialId: steel._id, createdBy: 'stock-clerk', type: 'IN',
      direction: 'IN', quantity: 1, referenceType: 'PURCHASE', date: new Date('2026-11-18'),
    });
    const page = (await authorized('get', materials + '/audit', admin.accessToken)
      .query({ actorId: 'stock-clerk', rawMaterialId: String(steel._id), type: 'IN', limit: 1 }).expect(200)).body.data;
    assert.equal(page.items[0]._id, original._id);
    const older = (await authorized('get', materials + '/audit', admin.accessToken)
      .query({ cursor: page.nextCursor, limit: 1 }).expect(200)).body.data;
    assert.equal(older.items[0]._id, String(legacy._id));
    assert.equal(older.items[0].stockBefore, undefined);
    assert.equal(older.items[0].actor.label, 'Renamed Patel');

    const staffLogin = async (name, role) => {
      const email = name.toLowerCase() + '@example.test';
      const secret = randomBytes(20);
      await PlatformStaff.create({ name, email, role, passwordHash, totpSecret: seal(secret) });
      const body = { email, password, code: totpCode(secret, Math.floor(Date.now() / 30_000)) };
      const { data } = (await request(app).post(platform + '/auth/login').send(body).expect(200)).body;
      await request(app).post(platform + '/auth/login').send(body).expect(401);
      return data;
    };
    const support = await staffLogin('Reader', 'support');
    const operator = await staffLogin('Operator', 'operator');
    const approver = await staffLogin('Approver', 'operator');
    const doOp = (path, body, token = operator.token) => authorized('post', path, token).send(body);
    await authorized('get', platform + '/tenants', admin.accessToken).expect(401);
    await authorized('get', materials, operator.token).expect(401);
    await authorized('get', company + '/stock', support.token).expect(200);
    await doOp(company + '/stock/' + original._id + '/reverse', context, support.token).expect(403);
    await doOp(company + '/stock/' + original._id + '/reverse', {}).expect(400);
    await doOp(otherCompany + '/stock/' + original._id + '/reverse', context).expect(404);
    const reversal = (await doOp(company + '/stock/' + original._id + '/reverse', context).expect(200)).body.data;
    const repeated = (await doOp(company + '/stock/' + original._id + '/reverse', context).expect(200)).body.data;
    assert.equal(repeated._id, reversal._id);
    const reversalAudit = (await authorized('get', materials + '/audit/' + reversal._id, admin.accessToken).expect(200)).body.data;
    assert.equal(reversalAudit.actor.label, 'Viplora Support');
    assert.deepEqual([reversalAudit.stockBefore, reversalAudit.stockAfter], [10, 0]);

    const correction = { ...context, rawMaterialId: String(steel._id), correctionOf: original._id, direction: 'IN', quantity: 5 };
    const adjust = (body) => doOp(company + '/stock/adjustment', body).set('Idempotency-Key', 'correct-stock');
    const adjusted = (await adjust(correction).expect(200)).body.data;
    assert.equal((await adjust(correction).expect(200)).body.data._id, adjusted._id);
    await adjust({ ...correction, quantity: 3 }).expect(409);
    const previewStock = () => doOp(company + '/changes/stock', {
      ...context, lines: [
        { rawMaterialId: String(steel._id), direction: 'IN', quantity: 2 },
        { rawMaterialId: String(copper._id), direction: 'IN', quantity: 3 },
      ],
    }).expect(200);
    const approve = (id, token) => doOp(company + '/changes/' + id + '/approve', context, token);
    const repair = (await previewStock()).body.data;
    assert.deepEqual(repair.lines.map((line) => line.stockBefore), [5, 0]);
    await approve(repair._id, operator.token).expect(403);
    const completed = (await approve(repair._id, approver.token).expect(200)).body.data;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.movementIds.length, 2);
    await approve(repair._id, approver.token).expect(409);
    const stale = (await previewStock()).body.data;
    await receipt(employee.accessToken, copper, 1);
    await approve(stale._id, approver.token).expect(409);
    assert.equal((await RawMaterial.findById(steel._id)).currentStock, 7);
    assert.equal((await RawMaterial.findById(copper._id)).currentStock, 4);
    assert.equal(await Movement.countDocuments({ tenantId, referenceId: stale._id }), 0);

    const recovery = (await doOp(company + '/changes/recovery', {
      ...context, snapshotReference: 'snapshot-check-42', impactPreview: 'Staged CSV contains three scoped rows.',
    }).expect(200)).body.data;
    const outcomePath = company + '/changes/' + recovery._id + '/complete';
    const outcome = { ...context, evidenceReference: 'restore-record-100', outcome: 'completed' };
    await doOp(outcomePath, outcome).expect(409);
    assert.equal((await approve(recovery._id, approver.token).expect(200)).body.data.status, 'approved');
    assert.equal((await doOp(outcomePath, outcome).expect(200)).body.data.status, 'completed');

    await doOp(otherCompany + '/users/stock-clerk/revoke-sessions', context).expect(404);
    await doOp(company + '/users/stock-clerk/request-recovery', context).expect(200);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, actorEmail);
    await doOp(company + '/users/stock-clerk/status', { ...context, status: 'inactive' }).expect(200);
    await authorized('get', materials, employee.accessToken).expect(401);
    await doOp(company + '/users/stock-clerk/status', { ...context, status: 'active' }).expect(200);
    await authorized('get', materials, employee.accessToken).expect(401);
    await login(actorEmail);
    await doOp(company + '/status', { ...context, status: 'inactive' }).expect(200);
    await authorized('get', materials, admin.accessToken).expect(401);
    await request(app).post('/api/auth/login').send({ email: 'admin-a@example.test', password }).expect(403);
    await doOp(company + '/status', { ...context, status: 'active' }).expect(200);
    await request(app).post('/api/auth/refresh-token').send({ refreshToken: admin.refreshToken }).expect(401);
    await login('admin-a@example.test');
    await authorized('get', materials, otherAdmin.accessToken).expect(200);

    const reversalEvent = await PlatformAudit.findOne({ tenantId, action: 'stock.reverse', outcome: 'succeeded' }).lean();
    assert.equal(String(reversalEvent.staffId), operator.staff.id);
    assert.equal(reversalEvent.caseReference, context.caseReference);
    assert.equal(reversalEvent.resultId, reversal._id);
    assert.ok(await PlatformAudit.exists({ tenantId, action: 'tenant.status', details: 'Requested status inactive' }));
    assert.ok(await PlatformAudit.exists({ tenantId, action: 'change.approve', outcome: 'failed', status: 409 }));
    await doOp(platform + '/auth/logout', {}, support.token).expect(200);
    await authorized('get', company + '/stock', support.token).expect(401);
  } finally {
    try {
      if (mongoose.connection.name === dbName && mongoose.connection.readyState === 1) {
        await mongoose.connection.dropDatabase();
      }
    } finally {
      await mongoose.disconnect();
    }
  }
});
