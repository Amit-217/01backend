const { z } = require('zod');
const MaterialTransaction = require('./material.transaction.model');
const RawMaterial = require('../raw_material/raw.material.model');
const Vendor = require('../vendor/vendor.model');
const { AppError } = require('../../../common/utils/errors');
const { movementFilters, movementFilter, movementPage } = require('./movement.query');

const historyQuery = movementFilters.extend({ search: z.string().trim().min(1).max(120).optional() });

const searchMovements = async (tenantId, search) => {
  const phrase = new RegExp(search.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'), 'i');
  const [materials, vendors] = await Promise.all([
    RawMaterial.find({ tenantId, $or: [{ code: phrase }, { name: phrase }] }).select('_id').lean(),
    Vendor.find({ tenantId, name: phrase }).select('_id').lean(),
  ]);
  return { $or: [
    { reference: phrase }, { notes: phrase }, { reason: phrase },
    { rawMaterialId: { $in: materials.map((material) => material._id) } },
    { vendorId: { $in: vendors.map((vendor) => vendor._id) } },
  ] };
};

const listMovementHistory = async (tenantId, input) => {
  const parsed = historyQuery.safeParse(input);
  if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message);
  const { search, limit = 25 } = parsed.data;
  const query = { ...movementFilter(parsed.data), tenantId };
  if (search) query.$and = [await searchMovements(tenantId, search)];

  const rows = await MaterialTransaction.find(query)
    .sort({ date: -1, _id: -1 }).limit(limit + 1).select('+stockUnit')
    .populate({ path: 'rawMaterialId', select: 'code name unit currentStock isActive', match: { tenantId } })
    .populate({ path: 'vendorId', select: 'name', match: { tenantId } }).lean();
  const page = movementPage(rows, limit);
  const reversals = await MaterialTransaction.find({
    tenantId, reversalOf: { $in: page.items.map((entry) => entry._id) },
  }).select('reversalOf').lean();
  const reversedBy = new Map(reversals.map((entry) => [String(entry.reversalOf), entry._id]));
  return {
    ...page,
    items: page.items.map((entry) => ({ ...entry, reversedBy: reversedBy.get(String(entry._id)) })),
  };
};

module.exports = { listMovementHistory };
