const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const mongoose = require('mongoose');
const RawMaterialCategory = require('../src/modules/raw_material/category/category.model');
const RawMaterial = require('../src/modules/raw_material/raw_material/raw.material.model');
const MaterialTransaction = require('../src/modules/raw_material/material_transaction/material.transaction.model');
const Vendor = require('../src/modules/raw_material/vendor/vendor.model');
const { createRawMaterial, updateRawMaterialById } = require('../src/modules/raw_material/raw_material/raw.material.service');
const {
  createMaterialTransaction,
  listMaterialTransactions,
  reverseMaterialTransactionById,
} = require('../src/modules/raw_material/material_transaction/material.transaction.service');

const testUri = process.env.TEST_MONGO_URI;

test('inventory writes are atomic and tenant-scoped on MongoDB', {
  skip: !testUri && 'Set TEST_MONGO_URI to a test replica set or sharded cluster.',
  timeout: 60000,
}, async (t) => {
  const dbName = 'viplora_inventory_test_' + randomUUID().replaceAll('-', '');
  try {
    await mongoose.connect(testUri, { dbName, serverSelectionTimeoutMS: 5000 });
    assert.equal(mongoose.connection.db.databaseName, dbName);
    const topology = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.ok(topology.setName || topology.msg === 'isdbgrid', 'MongoDB must support transactions');
    await Promise.all([RawMaterialCategory.init(), RawMaterial.init(), MaterialTransaction.init(), Vendor.init()]);

    const tenantId = 'tenant-a';
    const createdBy = 'user-a';
    const category = await RawMaterialCategory.create({ tenantId, name: 'Metals' });
    const material = await RawMaterial.create({
      tenantId,
      categoryId: category._id,
      code: 'ALU',
      name: 'Aluminium',
      unit: 'kg',
    });
    const received = {
      tenantId, createdBy, rawMaterialId: material._id, type: 'IN',
      direction: 'IN', quantity: 10, referenceType: 'PURCHASE', idempotencyKey: 'receipt',
    };
    const consumed = {
      ...received, type: 'CONSUMPTION', direction: 'OUT', quantity: 3,
      referenceType: 'DIRECT_CONSUMPTION', idempotencyKey: 'consumption',
    };
    const currentStock = async () => (await RawMaterial.findById(material._id)).currentStock;
    const history = () => listMaterialTransactions(tenantId, { rawMaterialId: material._id });

    const receipt = await createMaterialTransaction(received);
    const consumption = await createMaterialTransaction(consumed);
    assert.equal(await currentStock(), 7);
    const replay = await createMaterialTransaction(received);
    assert.equal(String(replay._id), String(receipt._id));
    await assert.rejects(createMaterialTransaction({ ...received, quantity: 11 }), { statusCode: 409 });
    assert.equal(await currentStock(), 7);
    assert.equal((await history()).length, 2);

    const inactiveVendor = await Vendor.create({ tenantId, name: 'Closed Supplier', isActive: false });
    await assert.rejects(createMaterialTransaction({
      ...received, vendorId: inactiveVendor._id, idempotencyKey: 'inactive-vendor',
    }), { statusCode: 400, message: /vendor is inactive/i });
    await assert.rejects(updateRawMaterialById(material._id, tenantId, { unit: 'g' }), { statusCode: 409 });
    assert.equal((await RawMaterial.findById(material._id)).unit, 'kg');
    const closedCategory = await RawMaterialCategory.create({ tenantId, name: 'Retired', isActive: false });
    await assert.rejects(createRawMaterial({
      tenantId, categoryId: closedCategory._id, code: 'CU', name: 'Copper', unit: 'kg',
    }), { statusCode: 400, message: /category is inactive/i });
    assert.equal(await currentStock(), 7);
    assert.equal((await history()).length, 2);

    const insertionError = new Error('Test movement insertion failure');
    const saveMock = t.mock.method(MaterialTransaction.prototype, 'save', async function (options) {
      const changedMaterial = await RawMaterial.findById(material._id).session(options.session);
      assert.equal(changedMaterial.currentStock, 9);
      throw insertionError;
    });
    try {
      await assert.rejects(createMaterialTransaction({
        ...received, quantity: 2, idempotencyKey: 'failed-receipt',
      }), (error) => error === insertionError);
    } finally {
      saveMock.mock.restore();
    }
    assert.equal(await currentStock(), 7);
    assert.equal((await history()).length, 2);

    const attempts = await Promise.allSettled([
      createMaterialTransaction({ ...consumed, quantity: 5, idempotencyKey: 'concurrent-one' }),
      createMaterialTransaction({ ...consumed, quantity: 5, idempotencyKey: 'concurrent-two' }),
    ]);
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
    const failedAttempt = attempts.find((result) => result.status === 'rejected');
    assert.equal(failedAttempt?.reason.statusCode, 400);
    assert.match(failedAttempt.reason.message, /insufficient stock/i);
    assert.equal(await currentStock(), 2);

    const otherTenant = 'tenant-b';
    await assert.rejects(createMaterialTransaction({ ...received, tenantId: otherTenant }), { statusCode: 404 });
    assert.equal(await reverseMaterialTransactionById(consumption._id, otherTenant, createdBy), null);
    assert.deepEqual(await listMaterialTransactions(otherTenant), []);
    assert.equal(await currentStock(), 2);

    const reversal = await reverseMaterialTransactionById(consumption._id, tenantId, createdBy);
    const repeatedReversal = await reverseMaterialTransactionById(consumption._id, tenantId, createdBy);
    assert.equal(String(repeatedReversal._id), String(reversal._id));
    assert.equal(String(reversal.reversalOf), String(consumption._id));
    assert.equal(await currentStock(), 5);
    const finalHistory = await history();
    assert.equal(finalHistory.length, 4);
    const original = finalHistory.find((entry) => entry._id.equals(consumption._id));
    assert.equal(original.type, 'CONSUMPTION');
    assert.equal(original.direction, 'OUT');
    assert.equal(original.quantity, 3);
    assert.equal(original.reversalOf, undefined);

    await RawMaterial.updateOne({ _id: material._id }, { $set: { currentStock: 0.3 } });
    await createMaterialTransaction({ ...consumed, quantity: 0.1, idempotencyKey: 'fraction-one' });
    assert.equal(await currentStock(), 0.2);
    await createMaterialTransaction({ ...consumed, quantity: 0.2, idempotencyKey: 'fraction-two' });
    assert.equal(await currentStock(), 0);
  } finally {
    try {
      if (mongoose.connection.db?.databaseName === dbName) {
        await mongoose.connection.dropDatabase();
      }
    } finally {
      await mongoose.disconnect();
    }
  }
});
