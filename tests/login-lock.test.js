const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_FAILURES, LOCK_MS, assertNotLocked, recordFailure, clearFailures, isLocked,
} = require('../src/common/utils/loginLock');

// Minimal stand-in for a Mongoose model holding one account document.
const fakeModel = (doc) => ({
  doc,
  findOneAndUpdate(_filter, update) {
    if (update.$inc) doc.failedLoginCount += update.$inc.failedLoginCount;
    Object.assign(doc, update.$set);
    return { select: async () => ({ failedLoginCount: doc.failedLoginCount }) };
  },
  async updateOne(_filter, update) { Object.assign(doc, update.$set); },
});
const account = () => ({ _id: 'a1', failedLoginCount: 0, lastFailedLoginAt: null, lockedUntil: null });

test('the tenth failed attempt within ten minutes locks the account for ten minutes', async () => {
  assert.equal(MAX_FAILURES, 10);
  assert.equal(LOCK_MS, 10 * 60 * 1000);
  const model = fakeModel(account());
  for (let attempt = 1; attempt < MAX_FAILURES; attempt += 1) {
    assert.equal(await recordFailure(model, { ...model.doc }), false, `attempt ${attempt} must not lock`);
  }
  assert.equal(await recordFailure(model, { ...model.doc }), true);
  assert.ok(isLocked(model.doc));
  const remaining = model.doc.lockedUntil.getTime() - Date.now();
  assert.ok(remaining > 9 * 60_000 && remaining <= LOCK_MS);
  assert.equal(model.doc.failedLoginCount, 0, 'The count restarts once the lock is set');
  assert.throws(() => assertNotLocked(model.doc), (error) => error.statusCode === 429 && /reset your password/.test(error.message));
});

test('failures older than the window start a fresh count', async () => {
  const model = fakeModel({ ...account(), failedLoginCount: 9, lastFailedLoginAt: new Date(Date.now() - LOCK_MS - 1000) });
  assert.equal(await recordFailure(model, { ...model.doc }), false);
  assert.equal(model.doc.failedLoginCount, 1);
});

test('a successful sign-in clears the count, and an expired lock no longer blocks', async () => {
  const model = fakeModel({ ...account(), failedLoginCount: 4, lastFailedLoginAt: new Date() });
  await clearFailures(model, { ...model.doc });
  assert.equal(model.doc.failedLoginCount, 0);
  assert.doesNotThrow(() => assertNotLocked({ lockedUntil: new Date(Date.now() - 1000) }));
  assert.throws(() => assertNotLocked({ lockedUntil: new Date(Date.now() + 60_000) }, 'Generic'), { message: 'Generic' });
});
