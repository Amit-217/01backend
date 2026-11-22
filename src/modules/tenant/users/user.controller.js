const { asyncHandler } = require('../../../common/utils/errors');
const { sendSuccess, sendError } = require('../../../common/utils/response');
const { createEmployee, listUsersForTenant, getUserByIdForTenant, updateUserByIdForTenant, deleteUserByIdForTenant } = require('./user.service');
const { sanitizeUser } = require('./user.util');
const { readTeamCapacity } = require('./team-capacity');

const createUser = asyncHandler(async (req, res) => {
  const payload = await createEmployee({
    ...req.body,
    tenantId: req.user.tenantId,
    actorId: req.user.userId,
  });

  return sendSuccess(res, 201, payload.message, payload);
});

const listUsers = asyncHandler(async (req, res) => {
  const status = req.query.status === 'inactive' ? 'inactive' : 'active';
  const users = await listUsersForTenant(req.user.tenantId, status);
  return sendSuccess(res, 200, 'Users retrieved successfully.', users.map(sanitizeUser));
});

const getUserById = asyncHandler(async (req, res) => {
  const user = await getUserByIdForTenant(req.params.id, req.user.tenantId);
  if (!user) {
    return sendError(res, 404, 'User not found.');
  }

  return sendSuccess(res, 200, 'User retrieved successfully.', sanitizeUser(user));
});

const getTeamCapacity = asyncHandler(async (req, res) =>
  sendSuccess(res, 200, 'Team capacity retrieved successfully.', await readTeamCapacity(req.user.tenantId)));

const updateUser = asyncHandler(async (req, res) => {
  const user = await updateUserByIdForTenant(req.params.id, req.user.tenantId, req.body, req.user.userId);
  if (!user) {
    return sendError(res, 404, 'User not found.');
  }

  return sendSuccess(res, 200, 'User updated successfully.', sanitizeUser(user));
});

const deleteUser = asyncHandler(async (req, res) => {
  const user = await deleteUserByIdForTenant(req.params.id, req.user.tenantId, req.user.userId);
  if (!user) {
    return sendError(res, 404, 'User not found.');
  }

  return sendSuccess(res, 200, 'User deactivated successfully.', sanitizeUser(user));
});

module.exports = {
  createUser,
  listUsers,
  getUserById,
  getTeamCapacity,
  updateUser,
  deleteUser,
};
