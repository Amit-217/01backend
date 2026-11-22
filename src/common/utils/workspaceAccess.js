const { supportLine } = require('../../config/support');

/**
 * Company access levels set by platform support for manual subscription billing:
 * - full: normal use.
 * - read_only: users sign in and read everything, but cannot change data.
 * - suspended: tenant `status` is `inactive`; nobody can sign in.
 * `accessMode` (full/read_only) is separate from `status` because read-only users must still sign in.
 */
const READ_ONLY_CODE = 'WORKSPACE_READ_ONLY';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const accessLevel = (tenant) => {
  if (tenant.status === 'inactive') return 'suspended';
  return tenant.accessMode === 'read_only' ? 'read_only' : 'full';
};

const readOnlyMessage = () =>
  'Your workspace is read-only until the subscription is renewed. You can view data, but changes are paused. ' + supportLine();

const suspendedMessage = () => 'Your company’s access is paused. ' + supportLine();

/**
 * Writes a read-only company may still make: signing out, and deactivating an employee who left
 * (a security action, not business data).
 */
const allowedWhileReadOnly = (req) => {
  const path = (req.baseUrl || '') + (req.path || '');
  if (req.method === 'POST' && path === '/api/auth/logout') return true;
  if (!/^\/api\/users\/[^/]+$/.test(path)) return false;
  if (req.method === 'DELETE') return true;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const keys = Object.keys(body);
  return req.method === 'PATCH' && keys.length === 1 && keys[0] === 'status' && body.status === 'inactive';
};

/** True when the request must be refused because the company is read-only. */
const blockedByReadOnly = (req, readOnly) => readOnly && !SAFE_METHODS.has(req.method) && !allowedWhileReadOnly(req);

module.exports = {
  READ_ONLY_CODE, accessLevel, readOnlyMessage, suspendedMessage, allowedWhileReadOnly, blockedByReadOnly,
};
