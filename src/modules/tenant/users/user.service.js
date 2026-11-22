const User = require('./user.model');
const { AppError } = require('../../../common/utils/errors');
const { normalizeEmail, hashPassword, generateOtp } = require('../../../common/utils/helpers');
const { generateReadableId } = require('../../../common/utils/idGenerator');
const { OTP_PURPOSES } = require('../auth/auth.constant');
const { sendEmailVerificationOTP } = require('../auth/auth.util');
const { revokeUserSessions } = require('../auth/session.service');

const duplicateEmail = () => new AppError(409, 'A user with this email already exists.');

const mapDuplicateEmail = (error) => {
  if (error.code === 11000 && (error.keyPattern?.email || error.keyValue?.email)) {
    throw duplicateEmail();
  }
  throw error;
};

const createVerificationCode = async () => {
  const code = generateOtp();
  const expiresInMinutes = Number(process.env.OTP_EXPIRY || 10);
  return {
    code,
    fields: {
      otp: await hashPassword(code),
      otpPurpose: OTP_PURPOSES.EMPLOYEE_EMAIL_VERIFICATION,
      otpExpiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000),
      otpAttempts: 0,
    },
  };
};

const sendEmployeeVerification = async (email, otp) => {
  try {
    return await sendEmailVerificationOTP({ email, otp, purpose: 'employee email verification' });
  } catch {
    return false;
  }
};

const clearPreviousCredentials = (user) => {
  user.refreshTokenHash = null;
  user.refreshTokenExpiresAt = null;
  user.passwordResetVerified = false;
  user.passwordResetVerifiedAt = null;
  if (user.otpPurpose === OTP_PURPOSES.PASSWORD_RESET || user.status === 'inactive') {
    user.otp = null;
    user.otpPurpose = null;
    user.otpExpiresAt = null;
    user.otpAttempts = 0;
  }
};

const createEmployee = async ({ firstName, lastName, email, password, confirmPassword, tenantId }) => {
  const normalizedEmail = normalizeEmail(email);
  const name = String(firstName || '').trim();
  const last = String(lastName || '').trim();

  if (name.length < 2) throw new AppError(400, 'First name is required.');
  if (!password || password !== confirmPassword) {
    throw new AppError(400, 'Password confirmation does not match.');
  }
  if (await User.exists({ email: normalizedEmail })) throw duplicateEmail();

  const userId = await generateReadableId('USR');
  const hashedPassword = await hashPassword(password);
  const verification = await createVerificationCode();
  const user = await User.create({
    userId,
    tenantId,
    firstName: name,
    lastName: last,
    email: normalizedEmail,
    password: hashedPassword,
    role: 'employee',
    emailVerified: false,
    status: 'active',
    ...verification.fields,
  }).catch(mapDuplicateEmail);
  const delivered = await sendEmployeeVerification(user.email, verification.code);

  return {
    userId: user.userId,
    email: user.email,
    message: delivered
      ? 'Employee created. Please verify the employee email.'
      : 'Employee created. The verification email could not be sent. The employee can request a new code from the sign-in screen.',
  };
};

const listUsersForTenant = async (tenantId) =>
  User.find({ tenantId, role: 'employee', status: 'active' }).sort({ createdAt: -1 });

// Public user IDs use the USR-000007 format.
const getUserByIdForTenant = async (userId, tenantId) => User.findOne({ userId, tenantId });

const updateUserByIdForTenant = async (userId, tenantId, payload) => {
  const user = await User.findOne({ userId, tenantId, role: 'employee' });
  if (!user) return null;

  const nextEmail = payload.email ? normalizeEmail(payload.email) : user.email;
  const emailChanged = nextEmail !== user.email;
  if (emailChanged && await User.exists({ email: nextEmail, _id: { $ne: user._id } })) {
    throw duplicateEmail();
  }

  for (const field of ['firstName', 'lastName', 'status']) {
    if (payload[field] !== undefined) user[field] = payload[field];
  }

  if (payload.password) {
    if (payload.password !== payload.confirmPassword) {
      throw new AppError(400, 'Password confirmation does not match.');
    }
    user.password = await hashPassword(payload.password);
  }

  const revokeSessions = emailChanged || Boolean(payload.password) || payload.status === 'inactive';
  if (revokeSessions) clearPreviousCredentials(user);

  let verification;
  if (emailChanged) {
    verification = await createVerificationCode();
    user.email = nextEmail;
    user.emailVerified = false;
    Object.assign(user, verification.fields);
  }

  if (revokeSessions) user.$inc('credentialVersion', 1);
  await user.save().catch(mapDuplicateEmail);
  if (revokeSessions) await revokeUserSessions(user.userId, user.credentialVersion);
  if (verification) await sendEmployeeVerification(nextEmail, verification.code);
  return user;
};

const deleteUserByIdForTenant = async (userId, tenantId) => {
  const user = await User.findOne({ userId, tenantId, role: 'employee' });
  if (!user) return null;

  user.status = 'inactive';
  clearPreviousCredentials(user);
  user.$inc('credentialVersion', 1);
  await user.save();
  await revokeUserSessions(user.userId, user.credentialVersion);
  return user;
};

module.exports = {
  createEmployee,
  listUsersForTenant,
  getUserByIdForTenant,
  updateUserByIdForTenant,
  deleteUserByIdForTenant,
};
