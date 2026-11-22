const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const rules = require('../src/modules/finished_goods/finished.validation');

test('finished-goods input normalizes SKU codes and validates movement intent', () => {
  const skuId = '111111111111111111111111';
  assert.equal(rules.createSku.parse({ productId: skuId, code: ' tsh-blk-m ' }).code, 'TSH-BLK-M');
  assert.equal(rules.movement.safeParse({ type: 'RECEIPT', skuId, quantity: 1, currentStock: 90 }).success, false);
  assert.equal(rules.movement.safeParse({ type: 'ADJUSTMENT', skuId, quantity: 1, direction: 'OUT', reason: ' ' }).success, false);
  assert.equal(rules.movement.safeParse({ type: 'DISPATCH', skuId, quantity: 0 }).success, false);
});

const testUri = process.env.TEST_MONGO_URI;
test('finished goods keep independent SKU balances, scope audit access and support atomic corrections', {
  skip: !testUri && 'Set TEST_MONGO_URI to a disposable replica set or sharded cluster.',
  timeout: 60_000,
}, async (t) => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET = randomUUID();
  process.env.PLATFORM_TOTP_KEY = randomBytes(32).toString('base64');

  const mongoose = require('mongoose');
  const request = require('supertest');
  const app = require('../src/app');
  const Tenant = require('../src/modules/tenant/tenant/tenant.model');
  const User = require('../src/modules/tenant/users/user.model');
  const { FinishedProduct, FinishedSku, FinishedMovement } = require('../src/modules/finished_goods/finished.model');
  const { PlatformAudit, PlatformStaff } = require('../src/modules/platform/platform.model');
  const { AppError } = require('../src/common/utils/errors');
  const { hashPassword } = require('../src/common/utils/helpers');
  const { seal, totpCode } = require('../src/modules/platform/platform.totp');

  const dbName = 'viplora_finished_test_' + randomUUID().replaceAll('-', '');
  const base = '/api/v1/finished-goods';
  const operations = '/api/platform/tenants/tenant-a/finished-goods';
  const password = 'Fixture-Finished-3525';
  const context = { caseReference: 'CASE-FG', reason: 'Correct the confirmed stock discrepancy.' };
  const http = (token, method, path) => request(app)[method](path).set('Authorization', 'Bearer ' + token);
  const tenant = (token, method, rest) => http(token, method, base + rest);

  try {
    await mongoose.connect(testUri, { dbName, serverSelectionTimeoutMS: 5000 });
    assert.equal(mongoose.connection.name, dbName);
    const topology = await mongoose.connection.db.command({ hello: 1 });
    assert.ok(topology.setName || topology.msg === 'isdbgrid');
    await Promise.all([FinishedProduct, FinishedSku, FinishedMovement, User, PlatformStaff].map((model) => model.init()));
    await Tenant.create([
      { tenantId: 'tenant-a', name: 'Shirt Company', email: 'company-a@example.test', status: 'active' },
      { tenantId: 'tenant-b', name: 'Other Company', email: 'company-b@example.test', status: 'active' },
    ]);
    const passwordHash = await hashPassword(password);
    await User.create([
      { tenantId: 'tenant-a', userId: 'admin-a', firstName: 'Shop Admin', email: 'admin-a@example.test', role: 'admin', password: passwordHash, emailVerified: true },
      { tenantId: 'tenant-a', userId: 'employee-a', firstName: 'Stock Clerk', email: 'employee-a@example.test', role: 'employee', password: passwordHash, emailVerified: true },
      { tenantId: 'tenant-b', userId: 'admin-b', firstName: 'Other Admin', email: 'admin-b@example.test', role: 'admin', password: passwordHash, emailVerified: true },
    ]);
    const login = async (email) => (await request(app).post('/api/auth/login').send({ email, password }).expect(200)).body.data.accessToken;
    const [admin, employee, other] = await Promise.all([
      login('admin-a@example.test'), login('employee-a@example.test'), login('admin-b@example.test'),
    ]);
    const product = { name: 'Classic T-Shirt', unit: 'pcs' };
    await tenant(employee, 'post', '/products').send(product).expect(403);
    const created = (await tenant(admin, 'post', '/products').send(product).expect(201)).body.data;
    const productId = created._id;
    const otherProduct = (await tenant(other, 'post', '/products').send(product).expect(201)).body.data;
    await tenant(other, 'get', '/products/' + productId).expect(404);
    await tenant(admin, 'post', '/skus').send({ productId: otherProduct._id, code: 'OTHER' }).expect(404);
    await tenant(admin, 'patch', '/products/' + productId).send({ unit: 'kg' }).expect(400);
    assert.equal((await tenant(employee, 'get', '/products').expect(200)).body.data[0]._id, productId);

    const sku = { productId, code: 'tsh-blk-m', size: 'M', colour: 'Black' };
    const medium = (await tenant(admin, 'post', '/skus').send(sku).expect(201)).body.data;
    assert.equal(medium.code, 'TSH-BLK-M');
    assert.equal(medium.currentStock, 0);
    await tenant(admin, 'post', '/skus').send({ ...sku, code: '  TSH-BLK-M  ' }).expect(409);
    await tenant(other, 'post', '/skus').send({ ...sku, productId: otherProduct._id }).expect(201);
    await tenant(other, 'get', '/skus/' + medium._id).expect(404);
    const large = (await tenant(admin, 'post', '/skus').send({ ...sku, code: 'TSH-BLK-L', size: 'L' }).expect(201)).body.data;

    const post = (token, key, body) => tenant(token, 'post', '/movements').set('Idempotency-Key', key).send(body);
    const receipt = { skuId: medium._id, type: 'RECEIPT', quantity: 30, date: '2026-11-19' };
    await tenant(employee, 'post', '/movements').send(receipt).expect(400);
    const received = (await post(employee, 'receipt', receipt).expect(201)).body.data;
    assert.equal(received.stockBefore, undefined);
    assert.equal(received.actor, undefined);
    assert.equal((await post(employee, 'receipt', receipt).expect(201)).body.data._id, received._id);
    await post(employee, 'receipt', { ...receipt, quantity: 31 }).expect(409);
    const opening = { skuId: large._id, type: 'OPENING', quantity: 20, reason: 'Verified first count' };
    await post(employee, 'opening', opening).expect(403);
    await post(admin, 'opening', opening).expect(201);
    await post(admin, 'second-opening', opening).expect(409);
    await post(admin, 'missing-reason', { skuId: medium._id, type: 'ADJUSTMENT', quantity: 1, direction: 'OUT' }).expect(400);
    await post(other, 'foreign', receipt).expect(404);
    const dispatch = { skuId: medium._id, type: 'DISPATCH', quantity: 10, date: '2026-11-19' };
    const dispatched = (await post(employee, 'dispatch', dispatch).expect(201)).body.data;
    const balance = async (id) => (await tenant(admin, 'get', '/skus/' + id).expect(200)).body.data.currentStock;
    assert.deepEqual([await balance(medium._id), await balance(large._id)], [20, 20]);
    await tenant(admin, 'patch', '/skus/' + medium._id).send({ isActive: false }).expect(409);
    await tenant(admin, 'patch', '/products/' + productId).send({ isActive: false }).expect(409);
    await post(employee, 'return', { skuId: medium._id, type: 'RETURN', quantity: 1 }).expect(201);

    const failure = t.mock.method(FinishedMovement, 'create', async () => { throw new AppError(400, 'Fixture insert failure.'); });
    try {
      await post(employee, 'interrupted', { ...receipt, quantity: 2 }).expect(400);
    } finally { failure.mock.restore(); }
    assert.equal(await balance(medium._id), 21);
    const parallel = await Promise.all(['dispatch-a', 'dispatch-b'].map((key) =>
      post(employee, key, { ...dispatch, quantity: 15 })));
    assert.deepEqual(parallel.map((item) => item.status).sort(), [201, 400]);
    assert.equal(await balance(medium._id), 6);

    await tenant(employee, 'get', '/movements/audit').expect(403);
    await tenant(other, 'get', '/movements/audit/' + received._id).expect(404);
    await tenant(admin, 'get', '/movements/audit').query({ 'skuId[$ne]': 'x' }).expect(400);
    await tenant(admin, 'patch', '/skus/' + medium._id).send({ code: 'TSH-BLK-M-V2', colour: 'Jet Black' }).expect(200);
    await User.updateOne({ tenantId: 'tenant-a', userId: 'employee-a' }, { $set: { firstName: 'Renamed' } });
    const audit = (await tenant(admin, 'get', '/movements/audit/' + dispatched._id).expect(200)).body.data;
    assert.deepEqual([audit.skuCode, audit.actor.label, audit.stockBefore, audit.stockAfter], ['TSH-BLK-M', 'Stock Clerk', 30, 20]);
    const listQuery = { actorId: 'employee-a', productId, skuId: medium._id, from: '2026-11-19', to: '2026-11-19', limit: 1 };
    const page = (await tenant(admin, 'get', '/movements/audit').query(listQuery).expect(200)).body.data;
    assert.equal(page.items.length, 1);
    const older = (await tenant(admin, 'get', '/movements/audit').query({ ...listQuery, cursor: page.nextCursor }).expect(200)).body.data;
    assert.notEqual(older.items[0]._id, page.items[0]._id);

    const staffLogin = async (name, role) => {
      const secret = randomBytes(20);
      const email = name + '@example.test';
      await PlatformStaff.create({ name, email, role, passwordHash, totpSecret: seal(secret) });
      return (await request(app).post('/api/platform/auth/login').send({
        email, password, code: totpCode(secret, Math.floor(Date.now() / 30_000)),
      }).expect(200)).body.data;
    };
    const [support, operator] = await Promise.all([staffLogin('reader', 'support'), staffLogin('operator', 'operator')]);
    const reverse = operations + '/movements/' + dispatched._id + '/reverse';
    await http(support.token, 'get', operations + '/skus').expect(200);
    await http(support.token, 'post', reverse).send(context).expect(403);
    await http(operator.token, 'post', reverse.replace('tenant-a', 'tenant-b')).send(context).expect(404);
    const reversed = (await http(operator.token, 'post', reverse).send(context).expect(200)).body.data;
    assert.equal(reversed.actor.label, 'Viplora Support');
    assert.equal(reversed.stockAfter, 16);
    assert.equal((await http(operator.token, 'post', reverse).send(context).expect(200)).body.data._id, reversed._id);
    await tenant(admin, 'post', '/movements/' + reversed._id + '/reverse').send({ reason: 'Second reversal' }).expect(409);
    const correction = { ...context, skuId: medium._id, correctionOf: dispatched._id, direction: 'OUT', quantity: 1 };
    const adjust = (body) => http(operator.token, 'post', operations + '/movements/adjustment').set('Idempotency-Key', 'repair').send(body);
    const corrected = (await adjust(correction).expect(200)).body.data;
    assert.equal(corrected.correctionOf, dispatched._id);
    assert.equal((await adjust(correction).expect(200)).body.data._id, corrected._id);
    assert.equal(await balance(medium._id), 15);
    assert.ok(await PlatformAudit.exists({
      tenantId: 'tenant-a', staffId: operator.staff.id, action: 'finished.movements.adjust',
      caseReference: context.caseReference, resultId: corrected._id, outcome: 'succeeded',
    }));

    await post(admin, 'clear', { skuId: large._id, type: 'ADJUSTMENT', direction: 'OUT', quantity: 20, reason: 'Verified stock reconciliation' }).expect(201);
    await tenant(admin, 'patch', '/skus/' + large._id).send({ isActive: false }).expect(200);
    await tenant(employee, 'get', '/skus/' + large._id).expect(404);
    await tenant(admin, 'get', '/movements/audit').query({ skuId: large._id }).expect(200);
    await post(employee, 'archived', { ...receipt, skuId: large._id }).expect(409);
    await tenant(admin, 'patch', '/skus/' + large._id).send({ isActive: true }).expect(200);
  } finally {
    try {
      if (mongoose.connection.name === dbName && mongoose.connection.readyState === 1) {
        await mongoose.connection.dropDatabase();
      }
    } finally { await mongoose.disconnect(); }
  }
});
