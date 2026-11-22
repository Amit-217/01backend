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
  lockedUntil: { type: Date, default: null },
};
const clearedLock = { failedLoginCount: 0, lastFailedLoginAt: null, lockedUntil: null };

const minutesLeft = (until) => Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 60_000));

const isLocked = (account) => !!(account?.lockedUntil && new Date(account.lockedUntil) > new Date());

/** Throws while the account is locked; `message` lets callers avoid revealing details (staff sign-in). */
const assertNotLocked = (account, message) => {
  if (!isLocked(account)) return;
  const minutes = minutesLeft(account.lockedUntil);
  throw new AppError(429, message || `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or reset your password.`);
};

/** Counts a failed attempt; returns true when this attempt locked the account. */
const recordFailure = async (Model, account) => {
  const now = new Date();
  const recent = account.lastFailedLoginAt && now.getTime() - new Date(account.lastFailedLoginAt).getTime() < LOCK_MS;
  const updated = await Model.findOneAndUpdate({ _id: account._id }, recent
    ? { $inc: { failedLoginCount: 1 }, $set: { lastFailedLoginAt: now } }
    : { $set: { failedLoginCount: 1, lastFailedLoginAt: now } }, { new: true }).select('failedLoginCount');
  if (!updated || updated.failedLoginCount < MAX_FAILURES) return false;
  await Model.updateOne({ _id: account._id }, {
    $set: { ...clearedLock, lockedUntil: new Date(now.getTime() + LOCK_MS) },
  });
  return true;
};

const clearFailures = async (Model, account) => {
  if (account.failedLoginCount || account.lockedUntil || account.lastFailedLoginAt) {
    await Model.updateOne({ _id: account._id }, { $set: clearedLock });
  }
};

module.exports = {
  MAX_FAILURES, LOCK_MS, lockFields, clearedLock, isLocked, assertNotLocked, recordFailure, clearFailures,
};
