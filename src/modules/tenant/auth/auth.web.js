const { sendError } = require('../../../common/utils/response');

const refreshCookie = 'viplora_refresh';
const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/api/auth',
});

const isWebClient = (req) => req.get('X-Viplora-Client') === 'web';

const isAllowedWebOrigin = (req) => {
  const origin = req.get('Origin');
  if (!origin) return false;
  const allowed = (process.env.WEB_ORIGINS || '').split(',').map((value) => value.trim());
  try {
    const url = new URL(origin);
    if (url.origin !== origin) return false;
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') return false;
    if (allowed.includes(origin) || url.host === req.get('Host')) return true;
    return process.env.NODE_ENV !== 'production' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
};

const requireWebOrigin = (req, res, next) => {
  if (isWebClient(req) && !isAllowedWebOrigin(req)) {
    return sendError(res, 403, 'This browser origin is not allowed to sign in.');
  }
  return next();
};

const getWebRefresh = (req) => {
  if (!isWebClient(req)) return undefined;
  const cookie = (req.get('Cookie') || '').split(';')
    .map((value) => value.trim()).find((value) => value.startsWith(refreshCookie + '='));
  return cookie?.slice(refreshCookie.length + 1);
};

const readWebRefresh = (req, res, next) => {
  if (!isWebClient(req)) return next();
  const refreshToken = getWebRefresh(req);
  if (!refreshToken) return sendError(res, 401, 'Please sign in again.');
  req.body = { refreshToken };
  return next();
};

const formatSessionResponse = (req, res, session) => {
  if (!isWebClient(req)) return session;
  const { refreshToken, ...publicSession } = session;
  res.cookie(refreshCookie, refreshToken, { ...cookieOptions(), maxAge: 7 * 24 * 60 * 60 * 1000 });
  return publicSession;
};

const clearWebSession = (req, res) => {
  if (isWebClient(req)) res.clearCookie(refreshCookie, cookieOptions());
};

module.exports = {
  isAllowedWebOrigin, requireWebOrigin, getWebRefresh, readWebRefresh, formatSessionResponse, clearWebSession,
};
