const { createHash } = require('node:crypto');
const { AppError } = require('../../common/utils/errors');
const { PlatformAudit, PlatformChange } = require('./platform.model');
const Tenant = require('../tenant/tenant/tenant.model');
const User = require('../tenant/users/user.model');
const AuthSession = require('../tenant/auth/session.model');
const { preparePasswordReset, deliverPasswordReset } = require('../tenant/auth/auth.service');
const { sanitizeUser } = require('../tenant/users/user.util');
const RawMaterial = require('../raw_material/raw_material/raw.material.model');
const {
  createMaterialTransaction, reverseMaterialTransactionById,
} = require('../raw_material/material_transaction/material.transaction.service');
const { PLATFORM_ACTOR, objectId } = require('../raw_material/material_transaction/movement.audit');

const pageSize = 25;
const toPage = async (query, cursor) => {
  if (cursor) query.where('_id').lt(cursor);
  const rows = await query.sort({ _id: -1 }).limit(pageSize + 1).lean();
  const items = rows.slice(0, pageSize);
  return { items, nextCursor: rows.length > pageSize ? String(items.at(-1)._id) : null };
};

const readTenant = async (tenantId, session) => {
  const tenant = await Tenant.findOne({ tenantId }).select('tenantId name status').session(session || null);
  if (!tenant) throw new AppError(404, 'Company workspace not found.');
  return tenant;
};

const listTenants = ({ lookup, cursor }) => toPage(Tenant.find(lookup
  ? { $or: [{ tenantId: lookup }, { name: lookup }] } : {}).select('tenantId name status'), cursor);
const listUsers = (tenantId, { cursor }) => toPage(User.find({ tenantId })
  .select('userId firstName lastName role status emailVerified'), cursor);
const listMaterials = (tenantId) => RawMaterial.find({ tenantId }).select('code name unit currentStock isActive')
  .sort({ name: 1, _id: 1 }).lean();
const listAudit = (tenantId, { cursor }) => toPage(PlatformAudit.find({ tenantId: tenantId ?? { $exists: false } }), cursor);
const listChanges = (tenantId, { cursor }) => toPage(PlatformChange.find({ tenantId }), cursor);

const setTenantStatus = async (tenantId, status, session) => {
  const tenant = await readTenant(tenantId, session);
  if (tenant.status === 'pending') throw new AppError(409, 'This company must finish verification before access can be managed.');
  if (tenant.status !== status) {
    tenant.status = status;
    tenant.$inc('accessVersion', 1);
    await tenant.save({ session });
    await AuthSession.deleteMany({ tenantId }, { session });
  }
  return { tenantId, name: tenant.name, status: tenant.status };
};

const loadUser = async (tenantId, userId, session) => {
  const user = await User.findOne({ tenantId, userId }).session(session);
  if (!user) throw new AppError(404, 'User not found in this company.');
  return user;
};

const invalidateSessions = async (user, session) => {
  user.$inc('credentialVersion', 1);
  await user.save({ session });
  await AuthSession.deleteMany({ tenantId: user.tenantId, userId: user.userId }, { session });
  return sanitizeUser(user);
};

const changeUser = async ({ tenantId, userId, status, session }) => {
  const user = await loadUser(tenantId, userId, session);
  if (user.status === status) return sanitizeUser(user);
  if (status) user.status = status;
  return invalidateSessions(user, session);
};

const requestRecovery = async (tenantId, userId, session) => {
  const user = await loadUser(tenantId, userId, session);
  if (!user.emailVerified || user.status !== 'active') {
    throw new AppError(409, 'Account recovery requires an active account with a verified inbox.');
  }
  const otp = await preparePasswordReset(user, session);
  return { data: { userId }, deliver: () => deliverPasswordReset(user.email, otp) };
};

const recordAdjustment = async (req, session) => {
  const { rawMaterialId, direction, quantity, correctionOf, reason } = req.body;
  const key = req.get('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
    throw new AppError(400, 'A valid Idempotency-Key is required for support adjustments.');
  }
  const idempotencyKey = createHash('sha256').update(JSON.stringify([String(req.platform.staff._id), key])).digest('hex');
  return createMaterialTransaction({
    tenantId: req.params.tenantId, rawMaterialId, direction, quantity, correctionOf,
    type: 'ADJUSTMENT', referenceType: 'ADJUSTMENT', reason, createdBy: PLATFORM_ACTOR, idempotencyKey,
    notes: 'Support case ' + req.body.caseReference,
  }, session);
};

const recordReversal = async (req, session) => {
  // A replay returns the original reversal, retaining its original actor.
  const entry = await reverseMaterialTransactionById(req.params.id, req.params.tenantId, PLATFORM_ACTOR,
    { reason: req.body.reason }, session);
  if (!entry) throw new AppError(404, 'Stock movement not found.');
  return entry;
};

const newChange = (req, kind) => ({
  tenantId: req.params.tenantId, kind,
  caseReference: req.body.caseReference, reason: req.body.reason,
  requestedBy: req.platform.staff._id, requestedByName: req.platform.staff.name,
  expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
});

const previewStock = async (req, session) => {
  const lines = req.body.lines.map((line) => ({ ...line, rawMaterialId: line.rawMaterialId.toLowerCase() }));
  const ids = lines.map((line) => line.rawMaterialId);
  if (new Set(ids).size !== ids.length) throw new AppError(400, 'List each material once in a repair.');
  const materials = await RawMaterial.find({ tenantId: req.params.tenantId, _id: { $in: ids } })
    .select('name unit isActive currentStock').session(session);
  const byId = new Map(materials.map((material) => [String(material._id), material]));
  const preview = lines.map((line) => {
    const material = byId.get(line.rawMaterialId);
    if (!material) throw new AppError(404, 'A material was not found in this company.');
    if (material.isActive === false) throw new AppError(400, 'A material is inactive.');
    const stockBefore = material.currentStock ?? 0;
    if (line.direction === 'OUT' && line.quantity > stockBefore) throw new AppError(400, 'A repair line would make stock negative.');
    return { ...line, name: material.name, unit: material.unit, stockBefore };
  });
  const [change] = await PlatformChange.create([{ ...newChange(req, 'stock'), lines: preview }], { session });
  return change;
};

const previewRecovery = async (req, session) => {
  const { snapshotReference, impactPreview } = req.body;
  const [change] = await PlatformChange.create([{
    ...newChange(req, 'recovery'), snapshotReference, impactPreview,
  }], { session });
  return change;
};

const loadChange = async (req, session) => {
  if (!objectId.safeParse(req.params.id).success) throw new AppError(400, 'Invalid change ID.');
  const change = await PlatformChange.findOne({ _id: req.params.id, tenantId: req.params.tenantId }).session(session);
  if (!change) throw new AppError(404, 'Change request not found.');
  if (change.caseReference !== req.body.caseReference) throw new AppError(400, 'Use the change request case reference.');
  return change;
};

const approveChange = async (req, session) => {
  const change = await loadChange(req, session);
  const staff = req.platform.staff;
  if (change.requestedBy.equals(staff._id)) throw new AppError(403, 'A second operator must approve this change.');
  if (change.status !== 'pending' || change.expiresAt <= new Date()) {
    throw new AppError(409, 'This preview is no longer pending approval.');
  }
  change.approvedBy = staff._id;
  change.approvedByName = staff.name;
  change.approvedAt = new Date();
  change.status = 'approved';
  if (change.kind === 'stock') {
    const movementIds = [];
    for (const line of change.lines) {
      const movement = await createMaterialTransaction({
        tenantId: change.tenantId, rawMaterialId: line.rawMaterialId, direction: line.direction, quantity: line.quantity,
        type: 'ADJUSTMENT', referenceType: 'ADJUSTMENT', referenceId: change._id,
        reason: change.reason, notes: 'Support case ' + change.caseReference, createdBy: PLATFORM_ACTOR,
        expectedStock: line.stockBefore, expectedUnit: line.unit,
      }, session);
      movementIds.push(movement._id);
    }
    change.movementIds = movementIds;
    change.status = 'completed';
    change.completedAt = new Date();
    change.completedBy = staff._id;
  }
  await change.save({ session });
  return change;
};

const completeRecovery = async (req, session) => {
  const change = await loadChange(req, session);
  if (change.kind !== 'recovery' || change.status !== 'approved') {
    throw new AppError(409, 'This recovery must be approved before an outcome can be recorded.');
  }
  change.status = req.body.outcome;
  change.evidenceReference = req.body.evidenceReference;
  change.completedAt = new Date();
  change.completedBy = req.platform.staff._id;
  await change.save({ session });
  return change;
};

module.exports = {
  readTenant, listTenants, listUsers, listMaterials, listAudit, listChanges, setTenantStatus, changeUser, requestRecovery,
  recordAdjustment, recordReversal, previewStock, previewRecovery, approveChange, completeRecovery,
};
