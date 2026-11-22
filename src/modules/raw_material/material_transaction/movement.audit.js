const { z } = require('zod');
const MaterialTransaction = require('./material.transaction.model');
const User = require('../../tenant/users/user.model');
const { AppError } = require('../../../common/utils/errors');
const { objectId, movementFilters, movementFilter, movementPage } = require('./movement.query');

const PLATFORM_ACTOR = 'platform-support';
const auditQuery = movementFilters.extend({
  actorId: z.string().trim().min(1).max(128).optional(),
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
  const { actorId, limit = 25 } = parsed.data;
  const query = movementFilter(parsed.data);
  if (actorId) query.createdBy = actorId;
  const rows = await readAuditRows(tenantId, query, limit + 1);
  return movementPage(rows, limit);
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
