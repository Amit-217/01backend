const { createHash } = require('node:crypto');
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
    reference, notes, reason, stockUnit, reversalOf, correctionOf,
    createdBy, actorName, actorRole, stockBefore, stockAfter,
  } = row;
  const movement = {
    _id, productId, skuId, productName, skuCode, size, colour, type, direction, quantity, date, createdAt,
    reference, notes, reason, stockUnit, reversalOf, correctionOf, reversedBy,
  };
  if (!audit) return movement;
  return {
    ...movement, createdBy, stockBefore, stockAfter,
    actor: { label: createdBy === PLATFORM_ACTOR ? 'Viplora Support' : actorName || createdBy, role: actorRole },
  };
}

async function insertMovement(tenantId, input, actor, session) {
  const { skuId, direction, quantity } = input;
  const sku = await FinishedSku.findOne({ tenantId, _id: skuId }).session(session);
  if (!sku) throw new AppError(404, 'SKU not found.');
  const product = await FinishedProduct.findOne({ tenantId, _id: sku.productId }).session(session);
  if (!sku.isActive || !product?.isActive) throw new AppError(409, 'Restore the archived product and SKU before changing stock.');

  if (input.type === 'OPENING' && await FinishedMovement.exists({ tenantId, skuId }).session(session)) {
    throw new AppError(409, 'Opening stock can only be recorded before the first movement.');
  }
  if (input.correctionOf && !await FinishedMovement.exists({
    tenantId, skuId, _id: input.correctionOf,
  }).session(session)) throw movementMissing();

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

async function listMovements(tenantId, { productId, skuId, type, actorId, from, to, cursor, limit = 25 }, audit) {
  const filter = { tenantId };
  if (productId) filter.productId = productId;
  if (skuId) filter.skuId = skuId;
  if (type) filter.type = type;
  if (actorId) filter.createdBy = actorId;
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = new Date(from + 'T00:00:00.000Z');
    if (to) filter.date.$lte = new Date(to + 'T23:59:59.999Z');
  }
  if (cursor) {
    const [iso, id] = cursor.split('_');
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso) throw new AppError(400, 'Invalid movement cursor.');
    filter.$or = [{ date: { $lt: date } }, { date, _id: { $lt: id } }];
  }
  const rows = await FinishedMovement.find(filter).sort({ date: -1, _id: -1 }).limit(limit + 1).lean();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: await withReversalLinks(tenantId, page, audit),
    nextCursor: rows.length > limit ? last.date.toISOString() + '_' + last._id : null,
  };
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

module.exports = { createMovement, reverseMovement, getMovement, listMovements, listActors, movementView, requireKey, hash };
