const mongoose = require('mongoose');

const tenantSchema = new mongoose.Schema(
  {
    tenantId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    otp: {
      type: String,
      default: null,
    },
    otpPurpose: {
      type: String,
      default: null,
    },
    otpExpiresAt: {
      type: Date,
      default: null,
    },
    otpAttempts: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ['active', 'inactive', 'pending'],
      default: 'pending',
    },
    accessVersion: { type: Number, default: 0 },
    // Manual subscription billing (see common/utils/workspaceAccess.js). Suspension uses `status: inactive`.
    accessMode: { type: String, enum: ['full', 'read_only'], default: 'full' },
    paidUntil: { type: Date, default: null },
    billingNote: { type: String, default: '', trim: true, maxlength: 500 },
    adminEmail: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
    },
    adminEmailVerified: {
      type: Boolean,
      default: false,
    },
    companyOtpSentAt: { type: Date, default: null },
    adminOtpSentAt: { type: Date, default: null },
    adminOtpHash: { type: String, default: null, select: false },
    adminOtpExpiresAt: { type: Date, default: null },
    adminOtpAttempts: { type: Number, default: 0 },
    onboardingTokenHash: { type: String, default: null, select: false },
    onboardingTokenExpiresAt: { type: Date, default: null },
    onboardingCompletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.models.Tenant || mongoose.model('Tenant', tenantSchema);
