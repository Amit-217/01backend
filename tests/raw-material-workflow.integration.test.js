const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const mongoose = require('mongoose');
const request = require('supertest');

const mongoUri = process.env.TEST_MONGO_URI;

test('raw opening stock, safe recovery, searchable history, unit writes and archives enforce their invariants', {
  skip: !mongoUri && 'Set TEST_MONGO_URI to use a disposable MongoDB replica set.',
  timeout: 60_000,
}, async (t) => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET = randomUUID();
  const app = require('../src/app');
  const Tenant = require('../src/modules/tenant/tenant/tenant.model');
  const User = require('../src/modules/tenant/users/user.model');
  const Category = require('../src/modules/raw_material/category/category.model');
  const RawMaterial = require('../src/modules/raw_material/raw_material/raw.material.model');
  const { updateRawMaterialById } = require('../src/modules/raw_material/raw_material/raw.material.service');
  const { createSession } = require('../src/modules/tenant/auth/session.service');
  const { signAccessToken } = require('../src/common/utils/helpers');
  const dbName = 'viplora_raw_flow_' + randomUUID().replaceAll('-', '');
  const api = request(app);
  const movements = '/api/v1/material-transactions';
  const materials = '/api/v1/raw-materials';
  const vendors = '/api/v1/vendors';

  try {
    await mongoose.connect(mongoUri, { dbName, serverSelectionTimeoutMS: 5_000 });
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    const tenantId = 'tenant-a';
    const company = await Tenant.create({ tenantId, name: 'Company A', email: 'a@example.test', status: 'active' });
    const foreign = await Tenant.create({ tenantId: 'tenant-b', name: 'Company B', email: 'b@example.test', status: 'active' });
    const as = async (tenant, role, userId) => {
      const user = await User.create({
        tenantId: tenant.tenantId, role, userId, firstName: userId, email: userId + '@example.test',
        password: 'fixture-hash', emailVerified: true,
      });
      const { sessionId } = await createSession(user, tenant);
      const token = signAccessToken({ sid: sessionId, tenantId: tenant.tenantId, userId, role });
      return (method, path) => api[method](path).auth(token, { type: 'bearer' });
    };
    const admin = await as(company, 'admin', 'owner-a');
    const employee = await as(company, 'employee', 'staff-a');
    const outsider = await as(foreign, 'admin', 'owner-b');
    const category = await Category.create({ tenantId, name: 'Materials' });
    const addMaterial = (code) => RawMaterial.create({
      tenantId, categoryId: category._id, unit: 'kg', name: code, code,
    });
    const material = await addMaterial('MATERIAL-A');
    const rawMaterialId = String(material._id);
    const materialPath = materials + '/' + rawMaterialId;
    const opening = {
      rawMaterialId, type: 'OPENING', direction: 'IN', referenceType: 'OPENING', expectedUnit: 'kg', quantity: 3,
      date: '2028-02-29',
    };
    const receipt = { ...opening, type: 'IN', referenceType: 'PURCHASE', quantity: 2, rate: 12.5, reference: 'PO[1]' };
    const post = (actor, body, key) => actor('post', movements).set('Idempotency-Key', key).send(body);

    await post(employee, opening, 'employee-opening').expect(403);
    await post(outsider, opening, 'foreign-opening').expect(404);
    const openingAttempts = await Promise.all([
      post(admin, opening, 'opening-first'), post(admin, opening, 'opening-second'),
    ]);
    assert.deepEqual(openingAttempts.map((res) => res.status).sort(), [201, 409]);
    assert.equal((await admin('get', materialPath).expect(200)).body.data.currentStock, 3);
    await post(employee, { ...receipt, referenceType: 'DIRECT_CONSUMPTION' }, 'bad-reference').expect(400);
    await post(employee, { ...receipt, date: '2028-02-30' }, 'bad-date').expect(400);
    await post(employee, { ...receipt, expectedUnit: 'g' }, 'bad-unit').expect(409);
    const saved = (await post(employee, receipt, 'receipt-1').expect(201)).body.data;
    assert.equal(saved.stockUnit, 'kg');
    assert.equal(saved.date, '2028-02-29T00:00:00.000Z');
    const getReceipt = movements + '/submissions/receipt-1';
    assert.equal((await employee('get', getReceipt).expect('Cache-Control', 'no-store').expect(200)).body.data._id, saved._id);
    await admin('get', getReceipt).expect(404);
    await outsider('get', getReceipt).expect(404);
    await employee('get', movements + '/submissions/bad%20key').expect(400);
    assert.equal((await post(employee, receipt, 'receipt-1').expect(201)).body.data._id, saved._id);
    assert.equal((await admin('get', materialPath).expect(200)).body.data.currentStock, 5);

    const history = movements + '/history';
    const first = (await employee('get', history).query({ limit: 1 }).expect(200)).body.data;
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0]._id, saved._id);
    assert.equal(first.items[0].stockUnit, 'kg');
    assert.equal(first.items[0].rate, 12.5);
    assert.ok(first.nextCursor);
    assert.equal('actorName' in first.items[0], false);
    assert.equal('idempotencyKey' in first.items[0], false);
    const older = (await employee('get', history).query({ limit: 1, cursor: first.nextCursor }).expect(200)).body.data;
    assert.equal(older.items[0].type, 'OPENING');
    assert.equal(older.nextCursor, null);
    const matching = (await employee('get', history).query({
      search: 'po[1]', rawMaterialId, type: 'IN', from: '2028-02-29', to: '2028-02-29',
    }).expect(200)).body.data;
    assert.deepEqual(matching.items.map((entry) => entry._id), [saved._id]);
    await employee('get', history).query({ cursor: 'invalid' }).expect(400);
    await employee('get', history).query({ from: '2028-03-01', to: '2028-02-29' }).expect(400);
    assert.deepEqual((await outsider('get', history).query({ rawMaterialId }).expect(200)).body.data.items, []);

    await admin('delete', materialPath).expect(409);
    await admin('patch', materialPath).send({ isActive: false }).expect(409);
    const use = (await post(employee, {
      rawMaterialId, type: 'CONSUMPTION', direction: 'OUT', referenceType: 'DIRECT_CONSUMPTION', expectedUnit: 'kg', quantity: 5,
    }, 'consume-to-zero').expect(201)).body.data;
    await admin('delete', materialPath).expect(200);
    await admin('post', movements + '/' + use._id + '/reverse').expect(409);
    await admin('patch', materialPath).send({ isActive: true }).expect(200);
    await admin('post', movements + '/' + use._id + '/reverse').expect(201);
    const reversal = (await admin('post', movements + '/' + saved._id + '/reverse').expect(201)).body.data;
    const reversed = (await employee('get', history).query({ search: 'PO[1]', limit: 1 }).expect(200)).body.data;
    assert.equal(reversed.items[0].reversedBy, reversal._id, 'Reversal is identified even if it is off the current page');

    const race = await addMaterial('RACE');
    let atSave;
    let releaseSave;
    const editReachedSave = new Promise((resolve) => { atSave = resolve; });
    const finishSave = new Promise((resolve) => { releaseSave = resolve; });
    const original = RawMaterial.prototype.save;
    const paused = t.mock.method(RawMaterial.prototype, 'save', async function (...args) {
      if (this._id.equals(race._id) && this.isModified('unit')) {
        atSave();
        await finishSave;
      }
      return original.apply(this, args);
    });
    const edit = assert.rejects(updateRawMaterialById(race._id, tenantId, { unit: 'g' }), { statusCode: 409 });
    try {
      await Promise.race([editReachedSave, edit.then(() => { throw new Error('Unit edit did not reach its save'); })]);
      await post(employee, { ...receipt, rawMaterialId: String(race._id) }, 'race-first-receipt').expect(201);
    } finally {
      releaseSave();
      paused.mock.restore();
    }
    await edit;
    assert.equal((await RawMaterial.findById(race._id)).unit, 'kg');
    const changed = await addMaterial('CHANGED-UNIT');
    await admin('patch', materials + '/' + changed._id).send({ unit: 'g' }).expect(200);
    await post(employee, { ...receipt, rawMaterialId: String(changed._id) }, 'stale-form').expect(409);

    const duplicates = await Promise.all([
      admin('post', vendors).send({ name: 'Supplier A', email: 'SUPPLIER@example.test' }),
      admin('post', vendors).send({ name: 'Supplier B', email: 'supplier@example.test' }),
    ]);
    assert.deepEqual(duplicates.map((res) => res.status).sort(), [201, 409]);
    const vendor = duplicates.find((res) => res.status === 201).body.data;
    assert.equal('emailKey' in vendor, false);
    await outsider('post', vendors).send({ name: 'Other company supplier', email: vendor.email }).expect(201);
    await admin('patch', vendors + '/' + vendor._id).send({ email: '' }).expect(200);
    await admin('post', vendors).send({ name: 'Replacement supplier', email: vendor.email }).expect(201);
  } finally {
    try {
      if (mongoose.connection.readyState === 1 && mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    } finally {
      await mongoose.disconnect();
    }
  }
});
