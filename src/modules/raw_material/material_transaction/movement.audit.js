const { z } = require('zod');
const MaterialTransaction = require('./material.transaction.model');
const User = require('../../tenant/users/user.model');
const { AppError } = require('../../../common/utils/errors');

const PLATFORM_ACTOR = 'platform-support';
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Expected a MongoDB ObjectId.');
const auditQuery = z.strictObject({
  rawMaterialId: objectId.optional(),
  actorId: z.string().trim().min(1).max(128).optional(),
  type: z.enum(['IN', 'CONSUMPTION', 'ADJUSTMENT']).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  cursor: z.string().regex(/^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_[a-f\d]{24}$/).optional(),
  limit: z.string().regex(/^[1-9]\d?$/).transform(Number).pipe(z.number().max(50)).optional(),
});

const userName = (user) => [user.firstName, user.lastName].filter(Boolean).join(' ');
const tenantActorFields = (user) => ({ actorName: userName(user), actorRole: user.role });

const listMovementActors = async (tenantId) => {
  const ids = await MaterialTransaction.distinct('createdBy', { tenantId });
  const users = await User.find({ tenantId, userId: { $in: ids } }).select('userId firstName lastName').lean();
  const labels = new Map(users.map((user) => [user.userId, userName(user)]));
  labels.set(PLATFORM_ACTOR, 'Viplora Support');
  return ids.map((id) => ({ id, label: labels.get(id) || id })).sort((a, b) => a.label.localeCompare(b.label));
};

const readAuditRows = async (tenantId, query, limit) => {
  const movements = await MaterialTransaction.find({ ...query, tenantId })
    .sort({ date: -1, _id: -1 }).limit(limit)
    .select('+actorName +actorRole +stockBefore +stockAfter +stockUnit +correctionOf')
    .populate({ path: 'rawMaterialId', select: 'code name unit currentStock', match: { tenantId } })
    .populate({ path: 'vendorId', select: 'name', match: { tenantId } })
    .lean();
  const missingActors = movements.filter((entry) => !entry.actorName && entry.createdBy !== PLATFORM_ACTOR);
  const [users, reversals] = await Promise.all([
    missingActors.length ? User.find({ tenantId, userId: { $in: missingActors.map((entry) => entry.createdBy) } })
      .select('userId firstName lastName role').lean() : [],
    movements.length ? MaterialTransaction.find({ tenantId, reversalOf: { $in: movements.map((entry) => entry._id) } })
      .select('reversalOf').lean() : [],
  ]);
  const byUserId = new Map(users.map((user) => [user.userId, user]));
  const byOriginalId = new Map(reversals.map((entry) => [String(entry.reversalOf), entry._id]));
  return movements.map(({ actorName, actorRole, ...entry }) => {
    const user = byUserId.get(entry.createdBy);
    const label = entry.createdBy === PLATFORM_ACTOR ? 'Viplora Support' : actorName || (user && userName(user));
    return {
      ...entry,
      actor: { label: label || entry.createdBy, role: actorRole || user?.role },
      reversedBy: byOriginalId.get(String(entry._id)),
    };
  });
};

const listMovementAudit = async (tenantId, input) => {
  const parsed = auditQuery.safeParse(input);
  if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message);
  const { rawMaterialId, actorId, type, from, to, cursor, limit = 25 } = parsed.data;
  if (from && to && from > to) throw new AppError(400, 'Start date must be on or before end date.');
  const query = {};
  if (rawMaterialId) query.rawMaterialId = rawMaterialId;
  if (actorId) query.createdBy = actorId;
  if (type) query.type = type;
  if (from || to) {
    query.date = {};
    if (from) query.date.$gte = new Date(from + 'T00:00:00.000Z');
    if (to) query.date.$lte = new Date(to + 'T23:59:59.999Z');
  }
  if (cursor) {
    const [value, id] = cursor.split('_');
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
      throw new AppError(400, 'Invalid movement cursor.');
    }
    query.$or = [{ date: { $lt: date } }, { date, _id: { $lt: id } }];
  }
  const rows = await readAuditRows(tenantId, query, limit + 1);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit ? last.date.toISOString() + '_' + last._id : null };
};

const getMovementAudit = async (tenantId, id) => {
  if (!objectId.safeParse(id).success) throw new AppError(400, 'Invalid movement ID.');
  const [entry] = await readAuditRows(tenantId, { _id: id }, 1);
  if (!entry) throw new AppError(404, 'Stock movement not found.');
  return entry;
};

module.exports = {
  PLATFORM_ACTOR, objectId, tenantActorFields, listMovementAudit, getMovementAudit, listMovementActors,
};
