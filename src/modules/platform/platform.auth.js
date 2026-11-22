const mongoose = require('mongoose');
const { createHash, randomBytes } = require('node:crypto');
const { comparePassword } = require('../../common/utils/helpers');
const { AppError, asyncHandler } = require('../../common/utils/errors');
const { PlatformStaff, PlatformSession, PlatformAudit } = require('./platform.model');
const { matchStep, unseal } = require('./platform.totp');

const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const publicStaff = (staff) => ({ id: String(staff._id), name: staff.name, role: staff.role });
const invalidLogin = () => new AppError(401, 'Invalid platform sign-in credentials.');

const loginPlatform = async ({ email, password, code }) => {
  const staff = await PlatformStaff.findOne({ email, active: true }).select('+passwordHash +totpSecret');
  if (!staff || !await comparePassword(password, staff.passwordHash)) throw invalidLogin();
  const step = matchStep(unseal(staff.totpSecret), code);
  if (step === undefined) throw invalidLogin();

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 30 * 60_000);
  await mongoose.connection.transaction(async (session) => {
    const verified = await PlatformStaff.updateOne({
      _id: staff._id, active: true, totpSecret: staff.totpSecret, lastTotpStep: { $lt: step },
    }, { $set: { lastTotpStep: step } }, { session });
    if (!verified.modifiedCount) throw invalidLogin();
    await PlatformSession.create([{ staffId: staff._id, tokenHash: tokenHash(token), expiresAt }], { session });
    await PlatformAudit.create([{
      staffId: staff._id, staffName: staff.name, action: 'auth.login', outcome: 'succeeded', status: 200,
    }], { session });
  });
  return { staff: publicStaff(staff), token, expiresAt };
};

const authenticatePlatform = asyncHandler(async (req, _res, next) => {
  const token = req.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new AppError(401, 'Platform sign-in is required.');
  const session = await PlatformSession.findOne({ tokenHash: tokenHash(token), expiresAt: { $gt: new Date() } });
  if (!session) throw new AppError(401, 'Platform session expired.');
  const staff = await PlatformStaff.findOne({ _id: session.staffId, active: true });
  if (!staff) throw new AppError(401, 'Platform session expired.');
  req.platform = { staff, sessionId: session._id };
  next();
});

module.exports = { loginPlatform, authenticatePlatform };
