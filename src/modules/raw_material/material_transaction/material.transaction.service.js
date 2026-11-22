const { createHash } = require('node:crypto');
const mongoose = require('mongoose');
const MaterialTransaction = require('./material.transaction.model');
const RawMaterial = require('../raw_material/raw.material.model');
const Vendor = require('../vendor/vendor.model');
const { AppError } = require('../../../common/utils/errors');
const { applyStockChange, withStockTransaction, idempotencyKeyPattern } = require('../../../common/utils/stock');
const { movementDate, referencesByType } = require('./material.transaction.validation');

const normalizeDirection = (type, direction) => {
  if (type === 'IN' && direction === 'IN') return 'IN';
  if (type === 'OPENING' && direction === 'IN') return 'IN';
  if (type === 'CONSUMPTION' && direction === 'OUT') return 'OUT';
  if (type === 'ADJUSTMENT' && ['IN', 'OUT'].includes(direction)) return direction;
  return null;
};

const normalizeId = (value, label) => {
  if (!mongoose.isObjectIdOrHexString(value)) {
    throw new AppError(400, `${label} must be a valid ID.`);
  }
  return value.toString().toLowerCase();
};

const insertTransaction = async (fields, session) => {
  const transaction = new MaterialTransaction(fields);
  try {
    return await transaction.save({ session });
  } catch (error) {
    if (error instanceof mongoose.Error.ValidationError) {
      throw new AppError(400, 'Invalid transaction details.');
    }
    throw error;
  }
};

const listMaterialTransactions = async (tenantId, filters = {}) => {
  const query = { tenantId };

  if (filters.rawMaterialId !== undefined && filters.rawMaterialId !== '') {
    query.rawMaterialId = normalizeId(filters.rawMaterialId, 'Raw material');
  }

  return MaterialTransaction.find(query)
    .select('+stockUnit')
    .populate({ path: 'rawMaterialId', select: 'code name unit currentStock isActive', match: { tenantId } })
    .populate({ path: 'vendorId', select: 'name', match: { tenantId } })
    .sort({ date: -1, createdAt: -1 });
};

const createMaterialTransaction = async ({
  tenantId,
  rawMaterialId,
  type,
  direction,
  quantity,
  rate,
  vendorId,
  referenceType,
  referenceId,
  reference,
  reason,
  date,
  notes,
  createdBy,
  idempotencyKey,
  actorName,
  actorRole,
  correctionOf,
  expectedStock,
  expectedUnit,
}, callerSession) => {
  const normalizedDirection = normalizeDirection(type, direction);
  if (!normalizedDirection) {
    throw new AppError(400, 'Invalid direction for this transaction type.');
  }
  if (!referencesByType[type]?.includes(referenceType)) {
    throw new AppError(400, 'Reference type does not match this stock movement.');
  }

  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty < 0.0001) {
    throw new AppError(400, 'Quantity must be at least 0.0001.');
  }

  if (type !== 'IN' && (vendorId || (rate !== undefined && rate !== null))) {
    throw new AppError(400, 'Vendor and rate apply only to stock receipts.');
  }
  if (type === 'ADJUSTMENT' && !String(reason ?? '').trim()) {
    throw new AppError(400, 'A reason is required for stock adjustments.');
  }

  const normalizedRate = rate === undefined ? undefined : Number(rate);
  if (normalizedRate !== undefined && (!Number.isFinite(normalizedRate) || normalizedRate < 0)) {
    throw new AppError(400, 'Rate must be a nonnegative number.');
  }
  if (date !== undefined && !(date instanceof Date) && !movementDate.safeParse(date).success) {
    throw new AppError(400, 'Enter a real movement date.');
  }
  const requestedDate = date === undefined ? undefined : new Date(date);
  if (requestedDate && Number.isNaN(requestedDate.getTime())) {
    throw new AppError(400, 'Date must be valid.');
  }

  if (idempotencyKey !== undefined && (
    typeof idempotencyKey !== 'string' || !idempotencyKeyPattern.test(idempotencyKey)
  )) {
    throw new AppError(400, 'Idempotency-Key must be 1 to 128 letters, digits or . _ : - characters.');
  }

  const payload = {
    rawMaterialId: normalizeId(rawMaterialId, 'Raw material'),
    type,
    direction: normalizedDirection,
    quantity: qty,
    rate: normalizedRate,
    vendorId: vendorId ? normalizeId(vendorId, 'Vendor') : undefined,
    referenceType,
    referenceId: referenceId ? normalizeId(referenceId, 'Reference') : undefined,
    reference: reference?.trim() || undefined,
    reason: reason ? String(reason).trim() || undefined : undefined,
    date: requestedDate,
    notes: notes ? String(notes).trim() || undefined : undefined,
    correctionOf: correctionOf ? normalizeId(correctionOf, 'Original movement') : undefined,
  };
  const actor = createdBy || 'system';
  const keyQuery = idempotencyKey ? { tenantId, createdBy: actor, idempotencyKey } : null;
  const requestFingerprint = keyQuery
    ? createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    : undefined;
  const findReplay = async (session = null) => {
    const existing = await MaterialTransaction.findOne(keyQuery).select('+requestFingerprint').session(session);
    if (existing && existing.requestFingerprint !== requestFingerprint) {
      throw new AppError(409, 'This idempotency key belongs to a different stock movement.');
    }
    return existing;
  };

  const transactionDate = requestedDate || new Date();
  return withStockTransaction(async (session) => {
    if (keyQuery) {
      const existing = await findReplay(session);
      if (existing) return existing;
    }
    if (payload.vendorId) {
      const vendor = await Vendor.findOne({ _id: payload.vendorId, tenantId }).select('isActive').session(session);
      if (!vendor) throw new AppError(404, 'Vendor not found.');
      if (vendor.isActive === false) throw new AppError(400, 'Vendor is inactive.');
    }

    if (payload.correctionOf && !await MaterialTransaction.exists({
      _id: payload.correctionOf, tenantId, rawMaterialId: payload.rawMaterialId,
    }).session(session)) throw new AppError(404, 'Original movement not found for this material.');
    const materialQuery = { _id: payload.rawMaterialId, tenantId, isActive: { $ne: false } };
    if (expectedStock !== undefined) materialQuery.currentStock = expectedStock === 0 ? { $in: [0, null] } : expectedStock;
    if (expectedUnit !== undefined) materialQuery.unit = expectedUnit;
    // The balance write serializes this check with every other movement for the material.
    if (type === 'OPENING') {
      if (await MaterialTransaction.exists({ tenantId, rawMaterialId: payload.rawMaterialId }).session(session)) {
        throw new AppError(409, 'Opening stock is only available before the first movement.');
      }
      materialQuery.currentStock = { $in: [0, null] };
    }
    const adjustment = normalizedDirection === 'IN' ? qty : -qty;
    const balance = await applyStockChange(RawMaterial, materialQuery, adjustment, session);
    if (!balance) {
      const material = await RawMaterial.findOne({ _id: payload.rawMaterialId, tenantId })
        .select('isActive currentStock unit').session(session);
      if (!material) throw new AppError(404, 'Raw material not found.');
      if (material.isActive === false) throw new AppError(400, 'Raw material is inactive.');
      if (expectedUnit !== undefined && material.unit !== expectedUnit) {
        throw new AppError(409, 'The material unit changed. Refresh the material and check the quantity.');
      }
      if (type === 'OPENING') throw new AppError(409, 'Opening stock requires a material with no stock or movements.');
      if (expectedStock !== undefined && (material.currentStock ?? 0) !== expectedStock) {
        throw new AppError(409, 'Stock changed since preview. Create a new preview.');
      }
      throw new AppError(400, 'Insufficient stock for this transaction.');
    }

    return insertTransaction({
      ...payload,
      tenantId,
      date: transactionDate,
      createdBy: actor,
      actorName,
      actorRole,
      ...balance,
      idempotencyKey,
      requestFingerprint,
    }, session);
  }, keyQuery ? findReplay : undefined, callerSession);
};

const getMaterialTransactionById = async (id, tenantId) => {
  return MaterialTransaction.findOne({ _id: id, tenantId })
    .select('+stockUnit')
    .populate({ path: 'rawMaterialId', select: 'code name unit currentStock isActive', match: { tenantId } })
    .populate({ path: 'vendorId', select: 'name', match: { tenantId } });
};

const getMovementSubmission = async (tenantId, createdBy, idempotencyKey) => {
  if (!idempotencyKeyPattern.test(idempotencyKey)) throw new AppError(400, 'Invalid submission key.');
  return MaterialTransaction.findOne({ tenantId, createdBy, idempotencyKey }).select('+stockUnit');
};

const reverseMaterialTransactionById = async (id, tenantId, createdBy, actor = {}, callerSession) => {
  const transactionId = normalizeId(id, 'Transaction');
  const reversalQuery = { tenantId, reversalOf: transactionId };
  const date = new Date();

  return withStockTransaction(async (session) => {
    const existing = await MaterialTransaction.findOne(reversalQuery).session(session);
    if (existing) return existing;

    const original = await MaterialTransaction.findOne({ _id: transactionId, tenantId }).select('+stockUnit').session(session);
    if (!original) return null;
    if (original.reversalOf) throw new AppError(409, 'A reversal cannot be reversed.');

    const direction = original.direction === 'IN' ? 'OUT' : 'IN';
    const adjustment = direction === 'IN' ? original.quantity : -original.quantity;
    const materialQuery = { _id: original.rawMaterialId, tenantId, isActive: { $ne: false } };
    if (original.stockUnit) materialQuery.unit = original.stockUnit;
    const balance = await applyStockChange(RawMaterial, materialQuery, adjustment, session);
    if (!balance) {
      const material = await RawMaterial.findOne({ _id: original.rawMaterialId, tenantId }).select('isActive unit').session(session);
      if (!material) throw new AppError(404, 'Raw material not found.');
      if (material.isActive === false) throw new AppError(409, 'Restore the material before reversing this movement.');
      if (original.stockUnit && material.unit !== original.stockUnit) {
        throw new AppError(409, 'The recorded unit differs from the material’s current unit. Contact Viplora Support.');
      }
      throw new AppError(400, 'Cannot reverse this movement because it would produce a negative stock balance.');
    }

    return insertTransaction({
      ...reversalQuery,
      rawMaterialId: original.rawMaterialId,
      type: 'ADJUSTMENT',
      direction,
      quantity: original.quantity,
      referenceType: 'ADJUSTMENT',
      reason: actor.reason || 'Stock movement reversal',
      date,
      createdBy,
      actorName: actor.actorName,
      actorRole: actor.actorRole,
      ...balance,
    }, session);
  }, () => MaterialTransaction.findOne(reversalQuery), callerSession);
};

module.exports = {
  listMaterialTransactions,
  createMaterialTransaction,
  getMaterialTransactionById,
  getMovementSubmission,
  reverseMaterialTransactionById,
};
