const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const User = require('../src/modules/tenant/users/user.model');
const { MAX_FAILURES, LOCK_MS, assertNotLocked, recordFailure, clearFailures, isLocked } =
  require('../src/common/utils/loginLock');

test('expired locks allow sign-in and active locks report the remaining time', () => {
  assert.doesNotThrow(() => assertNotLocked({ lockedUntil: new Date(Date.now() - 1000) }));
  const locked = { lockedUntil: new Date(Date.now() + 60_000) };
  assert.throws(() => assertNotLocked(locked, 'Generic'), { message: 'Generic' });
  assert.throws(() => assertNotLocked(locked), (error) => error.statusCode === 429 && /reset your password/.test(error.message));
});

const mongoUri = process.env.TEST_MONGO_URI;
test('concurrent failed sign-ins count within the rolling window and set one lock', {
  skip: !mongoUri && 'Set TEST_MONGO_URI to check the MongoDB update.',
  timeout: 45_000,
}, async () => {
  const dbName = 'viplora_login_lock_test_' + randomUUID().replaceAll('-', '');
  try {
    await mongoose.connect(mongoUri, { dbName, serverSelectionTimeoutMS: 5_000 });
    const account = await User.create({
      tenantId: 'tenant-a', userId: 'user-a', firstName: 'Tester', email: 'login@example.test',
      role: 'employee', password: 'fixture',
    });
    const read = () => User.findById(account._id).lean();

    await Promise.all(Array.from({ length: MAX_FAILURES - 1 }, () => recordFailure(User, account)));
    assert.equal((await read()).failedLoginAttempts.length, MAX_FAILURES - 1);
    assert.equal(await recordFailure(User, account), true);
    const locked = await read();
    assert.ok(isLocked(locked));
    assert.ok(locked.lockedUntil.getTime() > Date.now() + 9 * 60_000);
    assert.equal(await recordFailure(User, account), true);
    assert.deepEqual((await read()).lockedUntil, locked.lockedUntil);
    await assert.rejects(clearFailures(User, account), { statusCode: 429 });

    await User.updateOne({ _id: account._id }, { $set: {
      lockedUntil: new Date(Date.now() - 1000),
      failedLoginAttempts: [new Date(Date.now() - LOCK_MS - 1000), new Date(Date.now() - 1000)],
    } });
    assert.equal(await recordFailure(User, account), false);
    assert.equal((await read()).failedLoginAttempts.length, 2);
    await clearFailures(User, account);
    assert.deepEqual((await read()).failedLoginAttempts, []);

    await User.updateOne({ _id: account._id }, {
      $unset: { failedLoginAttempts: '' },
      $set: { failedLoginCount: MAX_FAILURES - 1, lastFailedLoginAt: new Date() },
    });
    assert.equal(await recordFailure(User, account), true, 'Older records keep their recent count');
  } finally {
    try {
      if (mongoose.connection.readyState === 1 && mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    } finally {
      await mongoose.disconnect();
    }
  }
});
