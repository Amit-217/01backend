const mongoose = require('mongoose');
const User = require('./user.model');
const Tenant = require('../tenant/tenant.model');
const { AppError } = require('../../../common/utils/errors');
const { READ_ONLY_CODE, readOnlyMessage } = require('../../../common/utils/workspaceAccess');

const limitsFor = (tenant) => ({
  admin: tenant.teamLimits?.admin ?? null,
  employee: tenant.teamLimits?.employee ?? null,
});

const activeUsers = (tenantId, role) => ({ tenantId, role, status: 'active' });

const readTeamCapacity = async (tenantId) => {
  const [tenant, counts] = await Promise.all([
    Tenant.findOne({ tenantId }).select('teamLimits').lean(),
    User.aggregate([{ $match: { tenantId, status: 'active' } }, { $group: { _id: '$role', count: { $sum: 1 } } }]),
  ]);
  if (!tenant) throw new AppError(404, 'Company workspace not found.');
  const usage = { admin: 0, employee: 0 };
  for (const { _id, count } of counts) usage[_id] = count;
  return { limits: limitsFor(tenant), usage };
};

// Every seat change writes the same tenant document first. Concurrent transactions retry
// against fresh member counts and permissions, including changes made by platform staff.
const withTeamChange = (tenantId, work, { session, actorId, allowReadOnly = false } = {}) => {
  const run = async (activeSession) => {
    const tenant = await Tenant.findOneAndUpdate({ tenantId }, { $inc: { teamRevision: 1 } }, {
      new: true, session: activeSession, timestamps: false,
    });
    if (!tenant) throw new AppError(404, 'Company workspace not found.');
    if (actorId) {
      if (tenant.status !== 'active' || !await User.exists({
        ...activeUsers(tenantId, 'admin'), userId: actorId, emailVerified: true,
      }).session(activeSession)) {
        throw new AppError(403, 'Administrator permission is required.');
      }
      if (tenant.accessMode === 'read_only' && !allowReadOnly) {
        throw new AppError(403, readOnlyMessage(), { code: READ_ONLY_CODE });
      }
    }
    return work(tenant, activeSession);
  };
  return session ? run(session) : mongoose.connection.transaction(run);
};

const assertSeatAvailable = async (tenant, role, session) => {
  const limit = limitsFor(tenant)[role];
  if (limit === null) throw new AppError(409, 'Ask Viplora Support to set the team limits for this subscription.');
  const used = await User.countDocuments(activeUsers(tenant.tenantId, role)).session(session);
  if (used >= limit) throw new AppError(409,
    `All ${role === 'admin' ? 'administrator' : 'employee'} seats are in use. Free a seat or contact Viplora Support to change the limit.`);
};

const assertMemberChange = async (tenant, user, { role = user.role, status = user.status } = {}, session) => {
  if (user.status === 'active' && user.role === 'admin' && (status !== 'active' || role !== 'admin')
      && !await User.exists({
        ...activeUsers(tenant.tenantId, 'admin'), emailVerified: true, userId: { $ne: user.userId },
      }).session(session)) {
    throw new AppError(409, 'This company must keep at least one active administrator.');
  }
  if (status === 'active' && (user.status !== 'active' || user.role !== role)) {
    await assertSeatAvailable(tenant, role, session);
  }
};

const setTeamLimits = async (tenant, limits, session) => {
  for (const role of ['admin', 'employee']) {
    const used = await User.countDocuments(activeUsers(tenant.tenantId, role)).session(session);
    if (limits[role] < used) throw new AppError(409,
      `The ${role === 'admin' ? 'administrator' : 'employee'} limit cannot be below the ${used} seats in use.`);
  }
  tenant.teamLimits = limits;
};

module.exports = { limitsFor, readTeamCapacity, withTeamChange, assertSeatAvailable, assertMemberChange, setTeamLimits };
