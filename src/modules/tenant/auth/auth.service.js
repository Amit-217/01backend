const bcrypt = require('bcryptjs');
const User = require('../users/user.model');
const { sanitizeUser } = require('../users/user.util');
const { AppError } = require('../../../common/utils/errors');
const {
  normalizeEmail,
  comparePassword,
  hashPassword,
  generateOtp,
  signAccessToken,
} = require('../../../common/utils/helpers');
const { sendEmailVerificationOTP, sendPasswordResetOTP } = require('./auth.util');
const { OTP_PURPOSES } = require('./auth.constant');
const onboarding = require('./onboarding.service');
const { activeTenant, createSession, rotateSession, revokeSession, revokeUserSessions } = require('./session.service');
const { LOCK_MS, assertNotLocked, recordFailure, clearFailures, clearedLock } = require('../../../common/utils/loginLock');

const OTP_TTL = Number(process.env.OTP_EXPIRY || 10) * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const OTP_RESEND_MS = 60 * 1000;

// A code for this purpose went out less than a minute ago; reuse it instead of mailing another.
const sentRecently = (user, purpose) => user.otpPurpose === purpose && user.otpSentAt
  && Date.now() - new Date(user.otpSentAt).getTime() < OTP_RESEND_MS
  && user.otpExpiresAt && user.otpExpiresAt > new Date();

const clearOtpData = (user) => {
  user.otp = null;
  user.otpPurpose = null;
  user.otpExpiresAt = null;
  user.otpAttempts = 0;
};

const clearResetVerification = (user) => {
  user.passwordResetVerified = false;
  user.passwordResetVerifiedAt = null;
};

const createOtpRecord = async (user, purpose, session) => {
  const otp = generateOtp();
  user.otp = await hashPassword(otp);
  user.otpPurpose = purpose;
  user.otpExpiresAt = new Date(Date.now() + OTP_TTL);
  user.otpAttempts = 0;
  user.otpSentAt = new Date();
  await user.save({ session });
  return otp;
};

const verifyOtpForUser = async (user, otp, purpose) => {
  if (!user?.otp || user.otpPurpose !== purpose || !user.otpExpiresAt) {
    throw new AppError(400, 'OTP is invalid or expired.');
  }
  if (user.otpExpiresAt < new Date() || user.otpAttempts >= MAX_OTP_ATTEMPTS) {
    throw new AppError(400, 'Request a new code to continue.');
  }
  if (!(await bcrypt.compare(otp, user.otp))) {
    if (user._id) {
      await User.updateOne({ _id: user._id, otp: user.otp }, { $inc: { otpAttempts: 1 } });
    } else {
      user.otpAttempts = Number(user.otpAttempts || 0) + 1;
      await user.save();
    }
    throw new AppError(400, 'Invalid OTP.');
  }
};

const verifyTenantEmail = async ({
  email, otp, purpose = OTP_PURPOSES.COMPANY_EMAIL_VERIFICATION, newPassword, confirmPassword,
}) => {
  if (purpose === OTP_PURPOSES.COMPANY_EMAIL_VERIFICATION) {
    return onboarding.verifyCompanyEmail({ email, otp });
  }
  if (purpose !== OTP_PURPOSES.EMPLOYEE_EMAIL_VERIFICATION) {
    throw new AppError(400, 'Invalid email verification purpose.');
  }
  const user = await User.findOne({
    email: normalizeEmail(email), role: 'employee', status: 'active', emailVerified: false,
  });
  await verifyOtpForUser(user, otp, purpose);
  // The code stays valid after this check, so an invited employee can retry with a password.
  if (user.passwordSetupRequired && !newPassword) {
    throw new AppError(400, 'Choose a password to finish setting up your account.');
  }
  if (newPassword && newPassword !== confirmPassword) {
    throw new AppError(400, 'Password confirmation does not match.');
  }
  user.emailVerified = true;
  clearOtpData(user);
  if (newPassword) {
    user.password = await hashPassword(newPassword);
    user.passwordSetupRequired = false;
    Object.assign(user, clearedLock);
    user.$inc('credentialVersion', 1);
  }
  await user.save();
  if (newPassword) await revokeUserSessions(user.userId, user.credentialVersion);
  return { userId: user.userId, message: 'Email verified successfully.' };
};

const sessionResponse = ({ user, sessionId, refreshToken }) => ({
  user: sanitizeUser(user),
  accessToken: signAccessToken({
    sid: sessionId,
    userId: user.userId,
    tenantId: user.tenantId,
    role: user.role,
    email: user.email,
  }),
  refreshToken,
});

const loginUser = async ({ email, password }) => {
  const user = await User.findOne({ email: normalizeEmail(email) });
  // Check the lock before the password so guesses during a lock never count or succeed.
  assertNotLocked(user);
  if (!user || !(await comparePassword(password, user.password))) {
    if (user && await recordFailure(User, user)) assertNotLocked({ lockedUntil: new Date(Date.now() + LOCK_MS) });
    throw new AppError(401, 'Invalid email or password.');
  }
  await clearFailures(User, user);
  if (user.status !== 'active') throw new AppError(403, 'Account is inactive.');
  if (!user.emailVerified) throw new AppError(403, 'Email is not verified.');
  const tenant = await activeTenant(user.tenantId);
  if (!tenant) throw new AppError(403, 'This company workspace is unavailable.');
  return sessionResponse(await createSession(user, tenant));
};

const refreshUserToken = async ({ refreshToken }) => {
  const session = await rotateSession(refreshToken);
  if (!session) throw new AppError(401, 'Invalid or expired session. Please sign in again.');
  return sessionResponse(session);
};

const logoutUser = async (sessionId, userId, refreshToken) => {
  const clearRefreshCookie = await revokeSession(sessionId, userId, refreshToken);
  return { message: 'Logged out successfully.', clearRefreshCookie };
};

const preparePasswordReset = (user, session) => {
  clearResetVerification(user);
  return createOtpRecord(user, OTP_PURPOSES.PASSWORD_RESET, session);
};

const deliverPasswordReset = async (email, otp) => {
  if (!(await sendPasswordResetOTP({ email, otp }))) {
    throw new AppError(503, 'The code could not be delivered. Please try again in a few minutes.');
  }
};

const forgotPassword = async ({ email }) => {
  const user = await User.findOne({ email: normalizeEmail(email), status: 'active' });
  const message = 'If an account exists, a password reset code has been sent.';
  if (!user || sentRecently(user, OTP_PURPOSES.PASSWORD_RESET)) return { message };
  const otp = await preparePasswordReset(user);
  await deliverPasswordReset(user.email, otp);
  return { message };
};

const verifyResetOtp = async ({ email, otp }) => {
  const user = await User.findOne({ email: normalizeEmail(email), status: 'active' });
  await verifyOtpForUser(user, otp, OTP_PURPOSES.PASSWORD_RESET);
  user.passwordResetVerified = true;
  user.passwordResetVerifiedAt = new Date();
  // Give the user a full window to choose the new password after proving the code.
  user.otpExpiresAt = new Date(Date.now() + OTP_TTL);
  await user.save();
  return {
    message: 'OTP verified successfully. You can now reset your password.',
    canReset: true,
  };
};

const resetPassword = async ({ email, otp, newPassword, confirmPassword }) => {
  const user = await User.findOne({ email: normalizeEmail(email), status: 'active' });
  if (!user || !user.passwordResetVerifiedAt || !user.passwordResetVerified) {
    throw new AppError(400, 'Please verify the reset OTP before setting a new password.');
  }
  if (!newPassword || newPassword !== confirmPassword) {
    throw new AppError(400, 'Password confirmation does not match.');
  }
  if (new Date(user.passwordResetVerifiedAt).getTime() + OTP_TTL < Date.now()) {
    throw new AppError(400, 'Password reset verification has expired. Please request a new code.');
  }
  await verifyOtpForUser(user, otp, OTP_PURPOSES.PASSWORD_RESET);
  const password = await hashPassword(newPassword);
  const consumed = await User.updateOne(
    { _id: user._id, otp: user.otp, passwordResetVerified: true, otpExpiresAt: { $gt: new Date() } },
    {
      $inc: { credentialVersion: 1 },
      $set: {
        ...clearedLock,
        password, refreshTokenHash: null, refreshTokenExpiresAt: null,
        otp: null, otpPurpose: null, otpExpiresAt: null, otpAttempts: 0,
        passwordResetVerified: false, passwordResetVerifiedAt: null,
      },
    },
  );
  if (!consumed.modifiedCount) throw new AppError(400, 'Request a new code to continue.');
  await revokeUserSessions(user.userId, (user.credentialVersion ?? 0) + 1);
  return { message: 'Password reset successfully.' };
};

const resendOtp = async ({ email, purpose }) => {
  if (purpose === OTP_PURPOSES.COMPANY_EMAIL_VERIFICATION) return onboarding.resendCompanyOtp({ email });
  if (purpose === OTP_PURPOSES.PASSWORD_RESET) return forgotPassword({ email });
  if (purpose !== OTP_PURPOSES.EMPLOYEE_EMAIL_VERIFICATION) {
    throw new AppError(400, 'Use the company registration form to resend the admin code.');
  }
  const user = await User.findOne({
    email: normalizeEmail(email), role: 'employee', status: 'active', emailVerified: false,
  });
  if (user && !sentRecently(user, purpose)) {
    const otp = await createOtpRecord(user, purpose);
    if (!(await sendEmailVerificationOTP({ email: user.email, otp, purpose: 'employee email verification' }))) {
      throw new AppError(503, 'The code could not be delivered. Please try again in a few minutes.');
    }
  }
  return { message: 'If an account is awaiting verification, a new code has been sent.' };
};

module.exports = {
  registerTenant: onboarding.registerTenant,
  verifyTenantEmail,
  sendAdminEmailOtp: onboarding.sendAdminEmailOtp,
  verifyAdminEmail: onboarding.verifyAdminEmail,
  registerAdminAndTenant: onboarding.registerAdminAndTenant,
  loginUser,
  refreshUserToken,
  logoutUser,
  forgotPassword,
  preparePasswordReset,
  deliverPasswordReset,
  verifyResetOtp,
  resetPassword,
  resendOtp,
};
