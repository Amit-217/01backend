const { randomBytes } = require('node:crypto');
const User = require('./user.model');
const { AppError } = require('../../../common/utils/errors');
const { normalizeEmail, hashPassword, generateOtp } = require('../../../common/utils/helpers');
const { generateReadableId } = require('../../../common/utils/idGenerator');
const { OTP_PURPOSES } = require('../auth/auth.constant');
const { sendEmailVerificationOTP } = require('../auth/auth.util');
const { revokeUserSessions } = require('../auth/session.service');
const { withTeamChange, assertSeatAvailable, assertMemberChange } = require('./team-capacity');

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
      otpSentAt: new Date(),
    },
  };
};

// A deactivated employee of the same company keeps their email; point the admin to Reactivate.
const assertEmailAvailable = async (email, tenantId, session, excludeId) => {
  const existing = await User.findOne({ email, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })
    .select('tenantId status').session(session);
  if (!existing) return;
  if (existing.tenantId === tenantId && existing.status === 'inactive') {
    throw new AppError(409, 'This email belongs to a deactivated employee. Reactivate them from the deactivated list.');
  }
  throw duplicateEmail();
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

const createEmployee = async ({ firstName, lastName, email, password, confirmPassword, tenantId, actorId }) => {
  const normalizedEmail = normalizeEmail(email);
  const name = String(firstName || '').trim();
  const last = String(lastName || '').trim();

  if (name.length < 2) throw new AppError(400, 'First name is required.');
  // Without a password the employee is invited and chooses one when verifying their email.
  const invited = !password;
  if (!invited && password !== confirmPassword) {
    throw new AppError(400, 'Password confirmation does not match.');
  }
  const userId = await generateReadableId('USR');
  const hashedPassword = await hashPassword(invited ? randomBytes(32).toString('base64url') : password);
  const verification = await createVerificationCode();
  const user = await withTeamChange(tenantId, async (tenant, session) => {
    await assertEmailAvailable(normalizedEmail, tenantId, session);
    await assertSeatAvailable(tenant, 'employee', session);
    const [created] = await User.create([{
      userId,
      tenantId,
      firstName: name,
      lastName: last,
      email: normalizedEmail,
      password: hashedPassword,
      passwordSetupRequired: invited,
      role: 'employee',
      emailVerified: false,
      status: 'active',
      ...verification.fields,
    }], { session });
    return created;
  }, { actorId }).catch(mapDuplicateEmail);
  const delivered = await sendEmployeeVerification(user.email, verification.code);
  const next = invited ? 'They verify their email and choose a password from the sign-in screen.'
    : 'Please verify the employee email.';

  return {
    userId: user.userId,
    email: user.email,
    emailSent: delivered,
    message: delivered
      ? 'Employee invited. ' + next
      : 'Employee created. The verification email could not be sent. The employee can request a new code from the sign-in screen.',
  };
};

/** Active (default) or deactivated members of a company, administrators first. */
const listUsersForTenant = async (tenantId, status = 'active') =>
  User.find({ tenantId, status }).sort({ role: 1, createdAt: -1 });

// Public user IDs use the USR-000007 format.
const getUserByIdForTenant = async (userId, tenantId) => User.findOne({ userId, tenantId });

/**
 * Admin rules: nobody changes their own role or status; only active, verified employees can be
 * promoted; another administrator can only have admin rights removed (then edit them as an employee).
 */
const editMember = async (tenant, session, userId, payload, actorId) => {
  const { tenantId } = tenant;
  const user = await User.findOne({ userId, tenantId }).session(session);
  if (!user) return null;

  const roleChange = payload.role !== undefined && payload.role !== user.role;
  if (user.userId === actorId && (roleChange || payload.status !== undefined)) {
    throw new AppError(409, 'You cannot change your own role or access.');
  }
  if (user.role === 'admin') {
    const otherFields = Object.keys(payload).filter((field) => field !== 'role' && payload[field] !== undefined);
    if (!roleChange || otherFields.length) {
      throw new AppError(409, 'Remove administrator rights before changing this account.');
    }
  }
  const nextEmail = payload.email ? normalizeEmail(payload.email) : user.email;
  const emailChanged = nextEmail !== user.email;
  if (roleChange && payload.role === 'admin'
      && (user.status !== 'active' || payload.status === 'inactive' || !user.emailVerified || emailChanged)) {
    throw new AppError(409, 'Only active employees with a verified email can become administrators.');
  }
  await assertMemberChange(tenant, user, payload, session);
  if (emailChanged) await assertEmailAvailable(nextEmail, tenantId, session, user._id);

  for (const field of ['firstName', 'lastName', 'status', 'role']) {
    if (payload[field] !== undefined) user[field] = payload[field];
  }

  if (payload.password) {
    if (payload.password !== payload.confirmPassword) {
      throw new AppError(400, 'Password confirmation does not match.');
    }
    user.password = await hashPassword(payload.password);
  }

  // A role change signs the person out so their app reloads with the new permissions.
  const revokeSessions = emailChanged || Boolean(payload.password) || payload.status === 'inactive' || roleChange;
  if (revokeSessions) clearPreviousCredentials(user);

  let verification;
  if (emailChanged) {
    verification = await createVerificationCode();
    user.email = nextEmail;
    user.emailVerified = false;
    Object.assign(user, verification.fields);
  }

  if (revokeSessions) user.$inc('credentialVersion', 1);
  await user.save({ session });
  if (revokeSessions) await revokeUserSessions(user.userId, user.credentialVersion, session);
  return { user, verification };
};

const updateUserByIdForTenant = async (userId, tenantId, payload, actorId) => {
  const allowReadOnly = payload.status === 'inactive' && Object.keys(payload).length === 1;
  const result = await withTeamChange(tenantId, (tenant, session) => editMember(tenant, session, userId, payload, actorId),
    { actorId, allowReadOnly }).catch(mapDuplicateEmail);
  if (result?.verification) await sendEmployeeVerification(result.user.email, result.verification.code);
  return result?.user ?? null;
};

const deleteUserByIdForTenant = (userId, tenantId, actorId) => withTeamChange(tenantId, async (_tenant, session) => {
  const user = await User.findOne({ userId, tenantId, role: 'employee' }).session(session);
  if (!user) return null;

  user.status = 'inactive';
  clearPreviousCredentials(user);
  user.$inc('credentialVersion', 1);
  await user.save({ session });
  await revokeUserSessions(user.userId, user.credentialVersion, session);
  return user;
}, { actorId, allowReadOnly: true });

module.exports = {
  createEmployee,
  listUsersForTenant,
  getUserByIdForTenant,
  updateUserByIdForTenant,
  deleteUserByIdForTenant,
};
