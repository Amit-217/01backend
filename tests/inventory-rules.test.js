const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../src/app');
const { updateCategoryValidation } = require('../src/modules/raw_material/category/category.validation');
const { updateVendorValidation } = require('../src/modules/raw_material/vendor/vendor.validation');
const transactionRoutes = require('../src/modules/raw_material/material_transaction/material.transaction.route');
const {
  createMaterialTransaction,
  listMaterialTransactions,
} = require('../src/modules/raw_material/material_transaction/material.transaction.service');

// These rules reject before any database access, so they run without TEST_MONGO_URI.
const movement = {
  tenantId: 'tenant-a',
  createdBy: 'user-a',
  rawMaterialId: '66c2f2e2d9d87f1a12345678',
  quantity: 1,
};

test('category and vendor updates keep isActive so records can be reactivated', () => {
  assert.deepEqual(updateCategoryValidation.parse({ isActive: true }), { isActive: true });
  assert.deepEqual(updateVendorValidation.parse({ isActive: true }), { isActive: true });
});

test('stock adjustments require a reason', async () => {
  for (const reason of [undefined, '', '   ']) {
    await assert.rejects(createMaterialTransaction({
      ...movement, type: 'ADJUSTMENT', direction: 'IN', referenceType: 'ADJUSTMENT', reason,
    }), { statusCode: 400, message: /reason is required/i });
  }
});

test('vendor and rate are accepted only on receipts', async () => {
  const consumption = { ...movement, type: 'CONSUMPTION', direction: 'OUT', referenceType: 'DIRECT_CONSUMPTION' };
  await assert.rejects(createMaterialTransaction({ ...consumption, vendorId: '66c2f2e2d9d87f1a12345679' }),
    { statusCode: 400, message: /only to stock receipts/i });
  await assert.rejects(createMaterialTransaction({ ...consumption, rate: 0 }),
    { statusCode: 400, message: /only to stock receipts/i });
});

test('history filter rejects a non-ID rawMaterialId instead of passing it to MongoDB', async () => {
  await assert.rejects(listMaterialTransactions('tenant-a', { rawMaterialId: { $ne: null } }), { statusCode: 400 });
  await assert.rejects(listMaterialTransactions('tenant-a', { rawMaterialId: ['a', 'b'] }), { statusCode: 400 });
});

test('stock movements cannot be hard-deleted', () => {
  const deleteRoutes = transactionRoutes.stack.filter((layer) => layer.route?.methods?.delete);
  assert.equal(deleteRoutes.length, 0);
});

test('companies cannot be created outside the verified signup flow', async () => {
  await request(app).post('/api/tenants').send({ name: 'Squatter', email: 'owner@example.test' }).expect(404);
});
