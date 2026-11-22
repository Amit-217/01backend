const mongoose = require('mongoose');
const { AppError } = require('./errors');

const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{1,128}$/;

const applyStockChange = async (model, filter, adjustment, session) => {
  const balance = { $toDecimal: { $ifNull: ['$currentStock', 0] } };
  const delta = mongoose.Types.Decimal128.fromString(String(adjustment));
  const nextStock = { $add: [balance, delta] };
  const query = adjustment < 0 ? { ...filter, $expr: { $gte: [nextStock, 0] } } : filter;
  const update = [{ $set: { currentStock: { $toDouble: nextStock } } }];
  const before = await model.findOneAndUpdate(query, update, {
    session, projection: 'currentStock unit', returnDocument: 'before',
  });
  if (!before) return null;
  const after = await model.findOne({ _id: before._id, tenantId: filter.tenantId })
    .select('currentStock').session(session);
  return { stockBefore: before.currentStock ?? 0, stockAfter: after.currentStock, stockUnit: before.unit };
};

const withStockTransaction = async (work, findDuplicate, session) => {
  if (session) return work(session);
  try {
    return await mongoose.connection.transaction(work);
  } catch (error) {
    if (error.code === 11000 && findDuplicate) {
      const existing = await findDuplicate();
      if (existing) return existing;
    }
    if (error.code === 20 && /Transaction numbers are only allowed/i.test(error.message)) {
      throw new AppError(503, 'Stock writes require a MongoDB replica set or sharded cluster.');
    }
    throw error;
  }
};

module.exports = { applyStockChange, withStockTransaction, idempotencyKeyPattern };
