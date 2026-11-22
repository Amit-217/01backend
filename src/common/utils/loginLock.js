const { AppError } = require('./errors');

/**
 * Per-account sign-in lock: 10 failed attempts within 10 minutes lock the account for 10 minutes,
 * whichever devices the attempts come from. The per-IP rate limit alone lets many addresses keep
 * guessing one account. A successful sign-in or password reset clears the count and any lock.
 */
const MAX_FAILURES = 10;
const LOCK_MS = 10 * 60 * 1000;

const lockFields = {
  failedLoginCount: { type: Number, default: 0 },
  lastFailedLoginAt: { type: Date, default: null },
  failedLoginAttempts: { type: [Date], default: undefined },
  lockedUntil: { type: Date, default: null },
};
const clearedLock = { failedLoginCount: 0, lastFailedLoginAt: null, failedLoginAttempts: [], lockedUntil: null };

const minutesLeft = (until) => Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 60_000));

const isLocked = (account) => !!(account?.lockedUntil && new Date(account.lockedUntil) > new Date());

/** Throws while the account is locked; `message` lets callers avoid revealing details (staff sign-in). */
const assertNotLocked = (account, message) => {
  if (!isLocked(account)) return;
  const minutes = minutesLeft(account.lockedUntil);
  throw new AppError(429, message || `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or reset your password.`);
};

const unlocked = () => ({ $or: [{ lockedUntil: null }, { lockedUntil: { $lte: new Date() } }] });

/** Adds an attempt and sets the lock in the same document update. */
const recordFailure = async (Model, account) => {
  // Older accounts recorded only the last timestamp. Carry their remaining count into the new window.
  const legacyAttempts = { $map: {
    input: { $range: [0, { $min: [{ $ifNull: ['$failedLoginCount', 0] }, MAX_FAILURES - 1] }] },
    as: 'index',
    in: '$lastFailedLoginAt',
  } };
  const attempts = { $ifNull: ['$failedLoginAttempts', legacyAttempts] };
  const recent = { $filter: {
    input: attempts, as: 'attempt', cond: { $gt: ['$$attempt', { $subtract: ['$$NOW', LOCK_MS] }] },
  } };
  const atLimit = { $gte: [{ $size: '$failedLoginAttempts' }, MAX_FAILURES] };
  const updated = await Model.findOneAndUpdate({ _id: account._id, ...unlocked() }, [
    { $set: { failedLoginAttempts: { $concatArrays: [recent, ['$$NOW']] } } },
    { $set: {
      lockedUntil: { $cond: [atLimit, { $add: ['$$NOW', LOCK_MS] }, null] },
      failedLoginAttempts: { $cond: [atLimit, [], '$failedLoginAttempts'] },
      failedLoginCount: 0,
      lastFailedLoginAt: null,
    } },
  ], { new: true }).select('lockedUntil');
  return isLocked(updated ?? await Model.findById(account._id).select('lockedUntil'));
};

const clearFailures = async (Model, account) => {
  const cleared = await Model.updateOne({ _id: account._id, ...unlocked() }, { $set: clearedLock });
  if (!cleared.matchedCount) assertNotLocked(await Model.findById(account._id).select('lockedUntil'));
};

module.exports = {
  MAX_FAILURES, LOCK_MS, lockFields, clearedLock, isLocked, assertNotLocked, recordFailure, clearFailures, unlocked,
};
