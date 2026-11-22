const { test } = require('node:test');
const assert = require('node:assert/strict');

const authorizeAdmin = require('../src/common/middlewares/authorizeAdmin');
const userRouter = require('../src/modules/tenant/users/user.route');
const { passwordSchema, verifyEmailValidation } = require('../src/modules/tenant/auth/auth.validation');
const { employeeCreateValidation } = require('../src/modules/tenant/users/user.validation');
const platformRules = require('../src/modules/platform/platform.validation');

const routeHandlers = (method, path) => userRouter.stack
  .find((layer) => layer.route?.path === path && layer.route.methods[method])
  ?.route.stack.map((entry) => entry.handle) ?? [];

test('team reads and writes require the admin role', () => {
  for (const [method, path] of [['get', '/'], ['get', '/capacity'], ['get', '/:id'], ['post', '/'], ['patch', '/:id'], ['delete', '/:id']]) {
    assert.ok(routeHandlers(method, path).includes(authorizeAdmin), `${method.toUpperCase()} ${path} must use authorizeAdmin`);
  }
});

test('passwords are 8 characters to 72 bytes so bcrypt never truncates them', () => {
  assert.equal(passwordSchema.safeParse('short').success, false);
  assert.equal(passwordSchema.safeParse('long enough').success, true);
  assert.equal(passwordSchema.safeParse('é'.repeat(37)).success, false, '74 bytes must be rejected');
});

test('employees can be invited without a password, and confirmations must match', () => {
  assert.equal(employeeCreateValidation.safeParse({ firstName: 'Asha', email: 'asha@example.test' }).success, true);
  assert.equal(employeeCreateValidation.safeParse({
    firstName: 'Asha', email: 'asha@example.test', password: 'Password1324', confirmPassword: 'Different1324',
  }).success, false);
  const verify = { email: 'asha@example.test', otp: '123456', purpose: 'employee_email_verification' };
  assert.equal(verifyEmailValidation.safeParse(verify).success, true);
  assert.equal(verifyEmailValidation.safeParse({ ...verify, newPassword: 'Password1324', confirmPassword: 'Nope1324' }).success, false);
});

test('platform role changes need a case reference, reason, and a known role', () => {
  const context = { caseReference: 'SUP-1042', reason: 'Admin left the company' };
  assert.equal(platformRules.role.safeParse({ ...context, role: 'admin' }).success, true);
  assert.equal(platformRules.role.safeParse({ ...context, role: 'owner' }).success, false);
  assert.equal(platformRules.role.safeParse({ role: 'admin' }).success, false);
  assert.equal(platformRules.context.safeParse({ ...context, caseReference: 'SUP 1042' }).success, false,
    'Case references cannot contain spaces');
});
