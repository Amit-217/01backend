const jwt = require('jsonwebtoken');
const { sendError } = require('../utils/response');
const { getAccessTokenSecret } = require('../utils/helpers');
const { getSessionUser } = require('../../modules/tenant/auth/session.service');

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
    const user = await getSessionUser(payload.sid, payload.userId, payload.tenantId);
    if (!user) return sendError(res, 401, 'This session has expired. Please sign in again.');
    req.user = {
      userId: user.userId,
      tenantId: user.tenantId,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      sessionId: payload.sid,
    };
    return next();
  } catch (error) {
    return next(error);
  }
};

module.exports = authenticate;
