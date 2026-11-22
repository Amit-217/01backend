const jwt = require('jsonwebtoken');
const { sendError } = require('../utils/response');
const { getAccessTokenSecret } = require('../utils/helpers');
const { getSessionUser } = require('../../modules/tenant/auth/session.service');
const { READ_ONLY_CODE, blockedByReadOnly, readOnlyMessage } = require('../utils/workspaceAccess');

const authenticate = async (req, res, next) => {
  const authHeader = req.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return sendError(res, 401, 'Authentication token is required.');

  let payload;
  try {
    payload = jwt.verify(token, getAccessTokenSecret(), { algorithms: ['HS256'] });
  } catch {
    return sendError(res, 401, 'Invalid or expired token.');
  }
  if (!payload.sid || !payload.userId || !payload.tenantId) {
    return sendError(res, 401, 'Please sign in again.');
  }
  try {
    const current = await getSessionUser(payload.sid, payload.userId, payload.tenantId);
    if (!current) return sendError(res, 401, 'This session has expired. Please sign in again.');
    const { user, tenant } = current;
    const readOnly = tenant.accessMode === 'read_only';
    req.user = {
      userId: user.userId,
      tenantId: user.tenantId,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      sessionId: payload.sid,
      readOnly,
    };
    // Enforced here so every authenticated tenant route, including future ones, respects read-only access.
    if (blockedByReadOnly(req, readOnly)) {
      return sendError(res, 403, readOnlyMessage(), { code: READ_ONLY_CODE });
    }
    return next();
  } catch (error) {
    return next(error);
  }
};

module.exports = authenticate;
