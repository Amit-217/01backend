const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  accessLevel, allowedWhileReadOnly, blockedByReadOnly, readOnlyMessage, suspendedMessage,
} = require('../src/common/utils/workspaceAccess');
const platformRules = require('../src/modules/platform/platform.validation');

const req = (method, baseUrl, path, body) => ({ method, baseUrl, path, body });

test('access level combines sign-in status and read-only mode', () => {
  assert.equal(accessLevel({ status: 'active', accessMode: 'full' }), 'full');
  assert.equal(accessLevel({ status: 'active' }), 'full');
  assert.equal(accessLevel({ status: 'active', accessMode: 'read_only' }), 'read_only');
  assert.equal(accessLevel({ status: 'inactive', accessMode: 'read_only' }), 'suspended');
});

test('read-only companies can read, sign out, and deactivate employees, but not change data', () => {
  assert.equal(blockedByReadOnly(req('GET', '/api/v1/raw-materials', '/'), true), false);
  assert.equal(blockedByReadOnly(req('POST', '/api/v1/material-transactions', '/'), true), true);
  assert.equal(blockedByReadOnly(req('PATCH', '/api/v1/raw-materials', '/abc'), true), true);
  assert.equal(blockedByReadOnly(req('POST', '/api/v1/finished-goods', '/movements'), true), true);
  assert.equal(blockedByReadOnly(req('POST', '/api/users', '/'), true), true, 'Inviting is blocked');
  assert.equal(blockedByReadOnly(req('POST', '/api/v1/material-transactions', '/'), false), false, 'Full access is unaffected');

  assert.ok(allowedWhileReadOnly(req('POST', '/api/auth', '/logout')));
  assert.ok(allowedWhileReadOnly(req('DELETE', '/api/users', '/USR-000007')));
  assert.ok(allowedWhileReadOnly(req('PATCH', '/api/users', '/USR-000007', { status: 'inactive' })));
  assert.equal(allowedWhileReadOnly(req('PATCH', '/api/users', '/USR-000007', { status: 'active' })), false, 'Reactivating is blocked');
  assert.equal(allowedWhileReadOnly(req('PATCH', '/api/users', '/USR-000007', { status: 'inactive', role: 'admin' })), false);
  assert.equal(allowedWhileReadOnly(req('DELETE', '/api/v1/vendors', '/abc')), false);
});

test('limited-access messages include the support contact from the environment', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { SUPPORT_NAME: 'Viplora Billing', SUPPORT_PHONE: '+91 98765 43210', SUPPORT_EMAIL: 'billing@example.test' });
    assert.match(readOnlyMessage(), /read-only.*Contact Viplora Billing at \+91 98765 43210 or billing@example\.test\./);
    assert.match(suspendedMessage(), /paused.*Viplora Billing/);
    delete process.env.SUPPORT_NAME; delete process.env.SUPPORT_PHONE; delete process.env.SUPPORT_EMAIL;
    assert.match(readOnlyMessage(), /Contact Viplora support\.$/);
  } finally {
    process.env = saved;
  }
});

test('access and billing changes need a case reference and valid values', () => {
  const context = { caseReference: 'BILL-42', reason: 'Invoice 42 unpaid' };
  assert.equal(platformRules.access.safeParse({ ...context, access: 'read_only' }).success, true);
  assert.equal(platformRules.access.safeParse({ ...context, access: 'locked' }).success, false);
  assert.equal(platformRules.access.safeParse({ access: 'full' }).success, false);
  assert.equal(platformRules.billing.safeParse({ ...context, paidUntil: '2026-12-31', billingNote: 'Paid by UPI' }).success, true);
  assert.equal(platformRules.billing.safeParse({ ...context, paidUntil: null }).success, true);
  assert.equal(platformRules.billing.safeParse({ ...context, paidUntil: '31/12/2026' }).success, false);
  assert.equal(platformRules.billing.safeParse({ ...context, paidUntil: '2026-12-31', billingNote: 'x'.repeat(501) }).success, false);
});
