const mongoose = require('mongoose');
const { createHash, randomBytes } = require('node:crypto');
const { comparePassword } = require('../../common/utils/helpers');
const { AppError, asyncHandler } = require('../../common/utils/errors');
const { PlatformStaff, PlatformSession, PlatformAudit } = require('./platform.model');
const { matchStep, requiresTotp, unseal } = require('./platform.totp');
const { assertNotLocked, recordFailure, clearedLock, unlocked } = require('../../common/utils/loginLock');

const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const publicStaff = (staff) => ({ id: String(staff._id), name: staff.name, role: staff.role });
const invalidLogin = () => new AppError(401, 'Invalid platform sign-in credentials.');
const lockedMessage = 'Too many failed sign-in attempts for this account. Try again in 10 minutes.';

const loginPlatform = async ({ email, password, code }) => {
  const staff = await PlatformStaff.findOne({ email, active: true }).select('+passwordHash +totpSecret');
  // Staff locks use a generic message so the response never confirms which staff emails exist.
  assertNotLocked(staff, lockedMessage);
  const fail = async () => {
    if (staff && await recordFailure(PlatformStaff, staff)) throw new AppError(429, lockedMessage);
    throw invalidLogin();
  };
  if (!staff || !await comparePassword(password, staff.passwordHash)) return fail();
  const passwordOnly = !requiresTotp();
  let step;
  if (!passwordOnly) {
    if (!staff.totpSecret || !code) return fail();
    step = matchStep(unseal(staff.totpSecret), code);
    if (step === undefined) return fail();
  }

  const token = (passwordOnly ? 'pwd.' : '') + randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 30 * 60_000);
  await mongoose.connection.transaction(async (session) => {
    const verified = await PlatformStaff.updateOne({
      _id: staff._id, active: true, passwordHash: staff.passwordHash, ...unlocked(),
      ...(passwordOnly ? {} : { totpSecret: staff.totpSecret, lastTotpStep: { $lt: step } }),
    }, { $set: { ...clearedLock, ...(passwordOnly ? {} : { lastTotpStep: step }) } }, { session });
    if (!verified.matchedCount) {
      assertNotLocked(await PlatformStaff.findById(staff._id).select('lockedUntil').session(session), lockedMessage);
      throw invalidLogin();
    }
    await PlatformSession.create([{ staffId: staff._id, tokenHash: tokenHash(token), expiresAt }], { session });
    await PlatformAudit.create([{
      staffId: staff._id, staffName: staff.name, action: 'auth.login', outcome: 'succeeded', status: 200,
    }], { session });
  });
  return { staff: publicStaff(staff), token, expiresAt };
};

const authenticatePlatform = asyncHandler(async (req, _res, next) => {
  // Password-only tokens also differ from the format accepted by older servers.
  const bearer = req.get('authorization')?.match(/^Bearer ((pwd\.)?[A-Za-z0-9_-]{43})$/);
  if (!bearer || (bearer[2] && requiresTotp())) throw new AppError(401, 'Platform sign-in is required.');
  const session = await PlatformSession.findOne({ tokenHash: tokenHash(bearer[1]), expiresAt: { $gt: new Date() } });
  if (!session) throw new AppError(401, 'Platform session expired.');
  const staff = await PlatformStaff.findOne({ _id: session.staffId, active: true });
  if (!staff) throw new AppError(401, 'Platform session expired.');
  req.platform = { staff, sessionId: session._id };
  next();
});

module.exports = { loginPlatform, authenticatePlatform };
