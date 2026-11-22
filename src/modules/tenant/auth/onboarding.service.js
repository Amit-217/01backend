const { createHash, randomBytes } = require('node:crypto');
const mongoose = require('mongoose');
const { AppError } = require('../../../common/utils/errors');
const { normalizeEmail, generateOtp, hashPassword, comparePassword } = require('../../../common/utils/helpers');
const { generateReadableId } = require('../../../common/utils/idGenerator');
const Tenant = require('../tenant/tenant.model');
const User = require('../users/user.model');
const { OTP_PURPOSES, OTP_TTL_MINUTES, MAX_OTP_ATTEMPTS } = require('./auth.constant');
const { sendEmailVerificationOTP } = require('./auth.util');

const OTP_TTL_MS = (Number(process.env.OTP_EXPIRY) || OTP_TTL_MINUTES) * 60_000;
const OTP_RESEND_MS = 60_000;
const ONBOARDING_TTL_MS = 30 * 60_000;
const COMPANY_PURPOSE = OTP_PURPOSES.COMPANY_EMAIL_VERIFICATION;
const unclaimedTenant = { status: { $in: ['pending', 'active'] }, onboardingCompletedAt: null };
const clearCompanyOtp = { otp: null, otpPurpose: null, otpExpiresAt: null, otpAttempts: 0 };
const clearAdminOtp = { adminOtpHash: null, adminOtpExpiresAt: null, adminOtpAttempts: 0 };

const hashGrant = (token) => createHash('sha256').update(token).digest('hex');
const invalidGrant = () => new AppError(400, 'Verify the company email again to continue signup.');
const invalidOtp = () => new AppError(400, 'This code is invalid or expired. Request a new code if needed.');
const existingTenant = () => new AppError(409, 'That company email is registered. If signup is unfinished, request a new verification code.');
const resendTooSoon = () => new AppError(429, 'Wait a minute before requesting another code.');

const createOtp = async () => {
  const code = generateOtp();
  const hash = await hashPassword(code);
  const sentAt = new Date();
  return { code, hash, sentAt, expiresAt: new Date(sentAt.getTime() + OTP_TTL_MS) };
};

const canResend = (field, now) => ({
  $or: [{ [field]: null }, { [field]: { $lte: new Date(now.getTime() - OTP_RESEND_MS) } }],
});

const deliverOtp = async ({ tenantId, email, code, purpose, challenge, clear }) => {
  let sent;
  try {
    sent = await sendEmailVerificationOTP({ email, otp: code, purpose });
  } catch {
    sent = false;
  }
  if (sent !== false) return;

  await Tenant.updateOne({ _id: tenantId, ...challenge }, { $set: clear });
  throw new AppError(503, 'The verification code could not be sent. Please request a new code.', { canResend: true });
};

const findUnclaimedTenant = async (email) => {
  const tenant = await Tenant.findOne({ email, ...unclaimedTenant });
  if (!tenant || await User.exists({ tenantId: tenant.tenantId, role: 'admin' })) return null;
  return tenant;
};

const grantFilter = (companyEmail, token) => {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalidGrant();
  return {
    ...unclaimedTenant,
    email: normalizeEmail(companyEmail),
    emailVerified: true,
    onboardingTokenHash: hashGrant(token),
    onboardingTokenExpiresAt: { $gt: new Date() },
  };
};

const registerTenant = async ({ name, email }) => {
  const companyEmail = normalizeEmail(email);
  const companyName = String(name ?? '').trim();
  if (companyName.length < 2) throw new AppError(400, 'Company name is required.');
  if (await Tenant.exists({ email: companyEmail })) throw existingTenant();

  const { code, hash, sentAt, expiresAt } = await createOtp();
  const tenantId = await generateReadableId('TEN');
  let tenant;
  try {
    tenant = await Tenant.create({
      tenantId, name: companyName, email: companyEmail, status: 'pending',
      otp: hash, otpPurpose: COMPANY_PURPOSE, otpExpiresAt: expiresAt, otpAttempts: 0, companyOtpSentAt: sentAt,
    });
  } catch (error) {
    if (error.code === 11000) throw existingTenant();
    throw error;
  }

  await deliverOtp({
    tenantId: tenant._id, email: tenant.email, code, purpose: 'company email verification',
    challenge: { otp: hash }, clear: { ...clearCompanyOtp, companyOtpSentAt: null },
  });
  return { tenantId: tenant.tenantId, email: tenant.email, message: 'Registration started. Please verify your company email.' };
};

const resendCompanyOtp = async ({ email }) => {
  const message = 'If company signup is unfinished, a new verification code has been sent.';
  const tenant = await findUnclaimedTenant(normalizeEmail(email));
  if (!tenant) return { message };

  const { code, hash, sentAt, expiresAt } = await createOtp();
  const result = await Tenant.updateOne({ _id: tenant._id, ...unclaimedTenant, ...canResend('companyOtpSentAt', sentAt) }, {
    $set: { otp: hash, otpPurpose: COMPANY_PURPOSE, otpExpiresAt: expiresAt, otpAttempts: 0, companyOtpSentAt: sentAt },
  });
  if (!result.modifiedCount) throw resendTooSoon();

  await deliverOtp({
    tenantId: tenant._id, email: tenant.email, code, purpose: 'company email verification',
    challenge: { otp: hash }, clear: { ...clearCompanyOtp, companyOtpSentAt: null },
  });
  return { message };
};

const verifyOtp = async ({ filter, hash, otp, attemptsField }) => {
  if (!hash || typeof otp !== 'string' || !/^\d{6}$/.test(otp)) throw invalidOtp();
  if (!await comparePassword(otp, hash)) {
    await Tenant.updateOne(filter, { $inc: { [attemptsField]: 1 } });
    throw invalidOtp();
  }
};

const verifyCompanyEmail = async ({ email, otp }) => {
  const tenant = await findUnclaimedTenant(normalizeEmail(email));
  if (!tenant || tenant.otpPurpose !== COMPANY_PURPOSE || !tenant.otpExpiresAt ||
      tenant.otpExpiresAt <= new Date() || tenant.otpAttempts >= MAX_OTP_ATTEMPTS) throw invalidOtp();

  const filter = {
    _id: tenant._id, ...unclaimedTenant, otp: tenant.otp, otpPurpose: COMPANY_PURPOSE,
    otpExpiresAt: { $gt: new Date() }, otpAttempts: { $lt: MAX_OTP_ATTEMPTS },
  };
  await verifyOtp({ filter, hash: tenant.otp, otp, attemptsField: 'otpAttempts' });

  const onboardingToken = randomBytes(32).toString('base64url');
  const now = new Date();
  filter.otpExpiresAt.$gt = now;
  const result = await Tenant.updateOne(filter, { $set: {
    ...clearCompanyOtp, ...clearAdminOtp,
    emailVerified: true, adminEmail: null, adminEmailVerified: false, adminOtpSentAt: null,
    onboardingTokenHash: hashGrant(onboardingToken), onboardingTokenExpiresAt: new Date(now.getTime() + ONBOARDING_TTL_MS),
  } });
  if (!result.modifiedCount) throw invalidOtp();

  return { tenantId: tenant.tenantId, onboardingToken, message: 'Company email verified successfully.' };
};

const sendAdminEmailOtp = async ({ companyEmail, email, adminEmail, onboardingToken }) => {
  const targetEmail = normalizeEmail(adminEmail || email);
  const filter = grantFilter(companyEmail, onboardingToken);
  const tenant = await Tenant.findOne(filter);
  if (!tenant) throw invalidGrant();
  if (targetEmail === tenant.email) return { message: 'The company email is already verified.' };
  if (!targetEmail) throw new AppError(400, 'An admin email is required.');

  const { code, hash, sentAt, expiresAt } = await createOtp();
  const result = await Tenant.updateOne({ ...grantFilter(companyEmail, onboardingToken), _id: tenant._id,
    ...canResend('adminOtpSentAt', sentAt) }, { $set: {
    adminEmail: targetEmail, adminEmailVerified: false, adminOtpHash: hash,
    adminOtpExpiresAt: expiresAt, adminOtpAttempts: 0, adminOtpSentAt: sentAt,
  } });
  if (!result.modifiedCount) throw resendTooSoon();

  await deliverOtp({
    tenantId: tenant._id, email: targetEmail, code, purpose: 'admin email verification',
    challenge: { adminOtpHash: hash }, clear: { ...clearAdminOtp, adminOtpSentAt: null },
  });
  return { message: 'Admin email verification code sent.' };
};

const verifyAdminEmail = async ({ companyEmail, email, adminEmail, otp, onboardingToken }) => {
  const targetEmail = normalizeEmail(adminEmail || email);
  const filter = grantFilter(companyEmail, onboardingToken);
  const tenant = await Tenant.findOne(filter).select('+adminOtpHash');
  if (!tenant) throw invalidGrant();
  if (targetEmail === tenant.email) return { message: 'The company email is already verified.' };
  if (tenant.adminEmail !== targetEmail || !tenant.adminOtpExpiresAt ||
      tenant.adminOtpExpiresAt <= new Date() || tenant.adminOtpAttempts >= MAX_OTP_ATTEMPTS) throw invalidOtp();

  const otpFilter = {
    ...filter, _id: tenant._id, adminEmail: targetEmail, adminOtpHash: tenant.adminOtpHash,
    adminOtpExpiresAt: { $gt: new Date() }, adminOtpAttempts: { $lt: MAX_OTP_ATTEMPTS },
  };
  await verifyOtp({ filter: otpFilter, hash: tenant.adminOtpHash, otp, attemptsField: 'adminOtpAttempts' });
  Object.assign(otpFilter, grantFilter(companyEmail, onboardingToken));
  otpFilter.adminOtpExpiresAt.$gt = new Date();
  const result = await Tenant.updateOne(otpFilter, { $set: { ...clearAdminOtp, adminEmailVerified: true } });
  if (!result.modifiedCount) throw invalidOtp();

  return { message: 'Admin email verified successfully.' };
};

const registerAdminAndTenant = async ({
  companyEmail, tenantEmail, adminEmail, email, firstName, lastName = '', password, confirmPassword, onboardingToken,
}) => {
  const verifiedCompanyEmail = normalizeEmail(companyEmail || tenantEmail);
  const targetEmail = normalizeEmail(adminEmail || email);
  const name = String(firstName ?? '').trim();
  const filter = grantFilter(verifiedCompanyEmail, onboardingToken);
  const tenant = await Tenant.findOne(filter);
  if (!tenant) throw invalidGrant();
  if (!targetEmail || name.length < 2) throw new AppError(400, 'An admin email and first name are required.');
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password) > 72) {
    throw new AppError(400, 'Use a password of at least 8 characters and at most 72 UTF-8 bytes.');
  }
  if (password !== confirmPassword) throw new AppError(400, 'Password confirmation does not match.');

  const adminFilter = targetEmail === verifiedCompanyEmail ? {} : { adminEmail: targetEmail, adminEmailVerified: true };
  if (targetEmail !== verifiedCompanyEmail && !(tenant.adminEmailVerified && tenant.adminEmail === targetEmail)) {
    throw new AppError(400, 'Verify the selected admin email before completing registration.');
  }
  const passwordHash = await hashPassword(password);
  const userId = await generateReadableId('USR');
  const session = await mongoose.startSession();

  try {
    return await session.withTransaction(async () => {
      if (await User.exists({ tenantId: tenant.tenantId, role: 'admin' }).session(session)) {
        throw new AppError(409, 'This company already has an administrator.');
      }
      if (await User.exists({ email: targetEmail }).session(session)) {
        throw new AppError(409, 'An account with this admin email already exists.');
      }

      const result = await Tenant.updateOne({ ...grantFilter(verifiedCompanyEmail, onboardingToken), ...adminFilter,
        _id: tenant._id }, { $set: {
        ...clearCompanyOtp, ...clearAdminOtp, adminEmail: targetEmail, adminEmailVerified: true,
        status: 'active', onboardingCompletedAt: new Date(), onboardingTokenHash: null, onboardingTokenExpiresAt: null,
      } }, { session });
      if (!result.modifiedCount) throw invalidGrant();

      await User.create([{
        userId, tenantId: tenant.tenantId, firstName: name, lastName: String(lastName ?? '').trim(),
        email: targetEmail, password: passwordHash, role: 'admin', emailVerified: true, status: 'active',
      }], { session });

      return { tenantId: tenant.tenantId, userId, message: 'Registration completed successfully.' };
    });
  } finally {
    await session.endSession();
  }
};

module.exports = { registerTenant, verifyCompanyEmail, resendCompanyOtp, sendAdminEmailOtp, verifyAdminEmail, registerAdminAndTenant };
