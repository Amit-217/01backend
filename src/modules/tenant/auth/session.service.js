const { createHash, randomBytes } = require('node:crypto');
const { isObjectIdOrHexString } = require('mongoose');
const User = require('../users/user.model');
const Tenant = require('../tenant/tenant.model');
const AuthSession = require('./session.model');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const newRefreshToken = () => randomBytes(32).toString('base64url');
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const nextExpiry = (now) => new Date(now.getTime() + SESSION_TTL_MS);

const findActiveUser = (userId, tenantId) => User.findOne({
  userId, tenantId, status: 'active', emailVerified: true,
});

const activeTenant = (tenantId) => Tenant.findOne({ tenantId, status: 'active' }).select('accessVersion');

const findSessionUser = async (session) => {
  const [user, tenant] = await Promise.all([
    findActiveUser(session.userId, session.tenantId),
    activeTenant(session.tenantId),
  ]);
  return user && tenant
    && (user.credentialVersion ?? 0) === (session.credentialVersion ?? 0)
    && (tenant.accessVersion ?? 0) === (session.tenantAccessVersion ?? 0) ? user : null;
};

const createSession = async (user, tenant) => {
  const refreshToken = newRefreshToken();
  const session = await AuthSession.create({
    userId: user.userId,
    tenantId: user.tenantId,
    credentialVersion: user.credentialVersion ?? 0,
    tenantAccessVersion: tenant.accessVersion ?? 0,
    refreshTokenHash: hashToken(refreshToken),
    expiresAt: nextExpiry(new Date()),
  });
  return { sessionId: String(session._id), refreshToken, user };
};

const rotateSession = async (previousToken) => {
  if (typeof previousToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(previousToken)) return null;
  const now = new Date();
  const refreshToken = newRefreshToken();
  const session = await AuthSession.findOneAndUpdate({
    refreshTokenHash: hashToken(previousToken),
    expiresAt: { $gt: now },
  }, {
    $set: { refreshTokenHash: hashToken(refreshToken), expiresAt: nextExpiry(now) },
  }, { new: true });
  if (!session) return null;
  const user = await findSessionUser(session);
  if (!user) return null;
  return { sessionId: String(session._id), refreshToken, user };
};

const getSessionUser = async (sessionId, userId, tenantId) => {
  if (!isObjectIdOrHexString(sessionId) || !userId || !tenantId) return null;
  const session = await AuthSession.findOne({
    _id: sessionId, userId, tenantId, expiresAt: { $gt: new Date() },
  }).select('credentialVersion tenantAccessVersion userId tenantId');
  if (!session) return null;
  return findSessionUser(session);
};

const revokeSession = async (sessionId, userId, refreshToken) => {
  if (!isObjectIdOrHexString(sessionId) || !userId) return false;
  const session = await AuthSession.findOneAndDelete({ _id: sessionId, userId });
  return !!(session && refreshToken && session.refreshTokenHash === hashToken(refreshToken));
};

const revokeUserSessions = async (userId, credentialVersion) => {
  if (!userId) return;
  await AuthSession.deleteMany({
    userId,
    $or: [{ credentialVersion: { $lt: credentialVersion } }, { credentialVersion: { $exists: false } }],
  });
};

module.exports = { activeTenant, createSession, rotateSession, getSessionUser, revokeSession, revokeUserSessions };
