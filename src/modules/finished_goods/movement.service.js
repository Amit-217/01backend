const { createHash } = require('node:crypto');
const { Types } = require('mongoose');
const { AppError } = require('../../common/utils/errors');
const { applyStockChange, withStockTransaction, idempotencyKeyPattern } = require('../../common/utils/stock');
const { PLATFORM_ACTOR } = require('../raw_material/material_transaction/movement.audit');
const { FinishedMovement, FinishedProduct, FinishedSku } = require('./finished.model');

const hash = (value) => createHash('sha256').update(value).digest('hex');
const movementMissing = () => new AppError(404, 'Finished-goods movement not found.');
const requireKey = (key) => {
  if (typeof key !== 'string' || !idempotencyKeyPattern.test(key)) {
    throw new AppError(400, 'A valid Idempotency-Key is required.');
  }
  return key;
};

function movementView(row, audit, reversedBy) {
  const {
    _id, productId, skuId, productName, skuCode, size, colour, type, direction, quantity, date, createdAt,
    reference, notes, reason, stockUnit, reversalOf, correctionOf, dispatchId,
    createdBy, actorName, actorRole, stockBefore, stockAfter,
  } = row;
  const movement = {
    _id, productId, skuId, productName, skuCode, size, colour, type, direction, quantity, date, createdAt,
    reference, notes, reason, stockUnit, reversalOf, correctionOf, reversedBy, dispatchId,
  };
  if (!audit) return movement;
  return {
    ...movement, createdBy, stockBefore, stockAfter,
    actor: { label: createdBy === PLATFORM_ACTOR ? 'Viplora Support' : actorName || createdBy, role: actorRole },
  };
}

// The matching dispatch, its linked returns, and their reversals all write the
// same SKU balance. A concurrent conflicting movement retries these checks.
const openReturns = (tenantId, dispatchId, session, stages) => FinishedMovement.aggregate([
  { $match: { tenantId, dispatchId, type: 'RETURN' } },
  { $lookup: {
    from: FinishedMovement.collection.name,
    localField: '_id',
    foreignField: 'reversalOf',
    pipeline: [{ $match: { tenantId } }, { $project: { _id: 1 } }],
    as: 'reversals',
  } },
  { $match: { 'reversals.0': { $exists: false } } },
  ...stages,
]).session(session);

async function assertReturnAllowed(tenantId, input, session) {
  if (!input.dispatchId) {
    if (!input.reference) throw new AppError(400, 'Select an original dispatch or enter an external dispatch reference.');
    return;
  }
  const dispatch = await FinishedMovement.findOne({
    tenantId, skuId: input.skuId, _id: input.dispatchId, type: 'DISPATCH',
  }).select('quantity').session(session);
  if (!dispatch) throw new AppError(404, 'Original dispatch not found for this SKU.');
  if (await FinishedMovement.exists({ tenantId, reversalOf: dispatch._id }).session(session)) {
    throw new AppError(409, 'This dispatch has been reversed.');
  }
  const quantityConflict = () => new AppError(409, 'Return quantity exceeds the remaining quantity on this dispatch.');
  if (input.quantity > dispatch.quantity) throw quantityConflict();
  const decimal = (quantity) => Types.Decimal128.fromString(String(quantity));
  const excess = await openReturns(tenantId, dispatch._id, session, [
    { $group: { _id: null, total: { $sum: { $toDecimal: '$quantity' } } } },
    { $match: { $expr: { $gt: [{ $add: ['$total', decimal(input.quantity)] }, decimal(dispatch.quantity)] } } },
  ]);
  if (excess.length) throw quantityConflict();
}

async function insertMovement(tenantId, input, actor, session) {
  const { skuId, direction, quantity } = input;
  const sku = await FinishedSku.findOne({ tenantId, _id: skuId }).session(session);
  if (!sku) throw new AppError(404, 'SKU not found.');
  const product = await FinishedProduct.findOne({ tenantId, _id: sku.productId }).session(session);
  if (!sku.isActive || !product?.isActive) throw new AppError(409, 'Restore the archived product and SKU before changing stock.');
  // Historical fractional entries remain reversible, including entries created before whole-piece validation.
  if (sku.unit === 'pcs' && input.type !== 'REVERSAL' && !Number.isInteger(quantity)) {
    throw new AppError(400, 'Enter a whole quantity for pieces.');
  }

  if (input.type === 'OPENING' && await FinishedMovement.exists({ tenantId, skuId }).session(session)) {
    throw new AppError(409, 'Opening stock can only be recorded before the first movement.');
  }
  if (input.correctionOf && !await FinishedMovement.exists({
    tenantId, skuId, _id: input.correctionOf,
  }).session(session)) throw movementMissing();
  if (input.type === 'RETURN') await assertReturnAllowed(tenantId, input, session);

  const balance = await applyStockChange(FinishedSku, { tenantId, _id: skuId, isActive: true },
    direction === 'IN' ? quantity : -quantity, session);
  if (!balance) throw new AppError(400, 'Insufficient finished stock for this movement.');
  const [entry] = await FinishedMovement.create([{
    ...input, ...actor, ...balance, tenantId,
    productId: product._id, productName: product.name, skuCode: sku.code, size: sku.size, colour: sku.colour,
  }], { session });
  return entry;
}

function createMovement(tenantId, input, actor, key, callerSession) {
  const idempotencyKey = requireKey(key);
  const lookup = { tenantId, createdBy: actor.createdBy, idempotencyKey };
  const direction = input.type === 'ADJUSTMENT' ? input.direction : input.type === 'DISPATCH' ? 'OUT' : 'IN';
  const payload = { ...input, direction };
  const fingerprint = hash(JSON.stringify(payload));
  const date = input.date ? new Date(input.date + 'T00:00:00.000Z') : new Date();
  const replay = async (session = null) => {
    const entry = await FinishedMovement.findOne(lookup).select('+fingerprint').session(session);
    if (entry && entry.fingerprint !== fingerprint) {
      throw new AppError(409, 'This idempotency key belongs to a different movement.');
    }
    return entry;
  };
  return withStockTransaction(async (session) => {
    const prior = await replay(session);
    if (prior) return prior;
    return insertMovement(tenantId, { ...payload, date, idempotencyKey, fingerprint }, actor, session);
  }, replay, callerSession);
}

function reverseMovement(tenantId, id, reason, actor, callerSession) {
  const reversalFilter = { tenantId, reversalOf: id };
  const date = new Date();
  return withStockTransaction(async (session) => {
    const existing = await FinishedMovement.findOne(reversalFilter).session(session);
    if (existing) return existing;
    const original = await FinishedMovement.findOne({ tenantId, _id: id }).session(session);
    if (!original) throw movementMissing();
    if (original.type === 'REVERSAL') throw new AppError(409, 'A reversal cannot be reversed.');
    if (original.type === 'DISPATCH' && (await openReturns(tenantId, original._id, session, [{ $limit: 1 }])).length) {
      throw new AppError(409, 'Reverse the linked returns before reversing this dispatch.');
    }
    return insertMovement(tenantId, {
      skuId: original.skuId, reversalOf: original._id, type: 'REVERSAL', quantity: original.quantity,
      direction: original.direction === 'IN' ? 'OUT' : 'IN', reason, date,
    }, actor, session);
  }, () => FinishedMovement.findOne(reversalFilter), callerSession);
}

async function withReversalLinks(tenantId, rows, audit) {
  if (!rows.length) return [];
  const links = await FinishedMovement.find({ tenantId, reversalOf: { $in: rows.map(({ _id }) => _id) } })
    .select('reversalOf').lean();
  const byOriginal = new Map(links.map((link) => [String(link.reversalOf), link._id]));
  return rows.map((row) => movementView(row, audit, byOriginal.get(String(row._id))));
}

async function listMovements(tenantId, { productId, skuId, type, actorId, from, to, search, order, cursor, limit = 25 }, audit) {
  const filter = { tenantId };
  const sortField = order === 'posted' ? 'createdAt' : 'date';
  if (productId) filter.productId = productId;
  if (skuId) filter.skuId = skuId;
  if (type) filter.type = type;
  if (actorId) filter.createdBy = actorId;
  if (search) {
    const phrase = new RegExp(search.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'), 'i');
    filter.$and = [{ $or: [{ reference: phrase }, { skuCode: phrase }, { productName: phrase }, { notes: phrase }] }];
  }
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = new Date(from + 'T00:00:00.000Z');
    if (to) filter.date.$lte = new Date(to + 'T23:59:59.999Z');
  }
  if (cursor) {
    const [iso, id] = cursor.split('_');
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso) throw new AppError(400, 'Invalid movement cursor.');
    filter.$or = [{ [sortField]: { $lt: date } }, { [sortField]: date, _id: { $lt: id } }];
  }
  const rows = await FinishedMovement.find(filter).sort({ [sortField]: -1, _id: -1 }).limit(limit + 1).lean();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: await withReversalLinks(tenantId, page, audit),
    nextCursor: rows.length > limit ? last[sortField].toISOString() + '_' + last._id : null,
  };
}

async function getSubmission(tenantId, createdBy, key, audit) {
  const row = await FinishedMovement.findOne({ tenantId, createdBy, idempotencyKey: requireKey(key) }).lean();
  if (!row) throw movementMissing();
  return movementView(row, audit);
}

async function getMovement(tenantId, id, audit) {
  const row = await FinishedMovement.findOne({ tenantId, _id: id }).lean();
  if (!row) throw movementMissing();
  const [entry] = await withReversalLinks(tenantId, [row], audit);
  return entry;
}

async function listActors(tenantId) {
  const rows = await FinishedMovement.aggregate([
    { $match: { tenantId } },
    { $sort: { _id: -1 } },
    { $group: { _id: '$createdBy', name: { $first: '$actorName' } } },
  ]);
  return rows.map(({ _id, name }) => ({ id: _id, label: _id === PLATFORM_ACTOR ? 'Viplora Support' : name || _id }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

module.exports = { createMovement, reverseMovement, getMovement, getSubmission, listMovements, listActors, movementView, requireKey, hash };
