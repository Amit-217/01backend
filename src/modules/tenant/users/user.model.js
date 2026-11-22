const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    tenantId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    firstName: {
      type: String,
      required: true,
      trim: true,
    },
    lastName: {
      type: String,
      default: '',
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ['admin', 'employee'],
      required: true,
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
    // When the current code was sent; resends inside the cooldown reuse it instead of mailing another.
    otpSentAt: {
      type: Date,
      default: null,
    },
    // Invited employees choose their own password when they verify their email.
    passwordSetupRequired: {
      type: Boolean,
      default: false,
    },
    passwordResetVerified: {
      type: Boolean,
      default: false,
    },
    passwordResetVerifiedAt: {
      type: Date,
      default: null,
    },
    refreshTokenHash: {
      type: String,
      default: null,
    },
    refreshTokenExpiresAt: {
      type: Date,
      default: null,
    },
    credentialVersion: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },

    profileImage: {
  type: String,
  default: "/uploads/profile/default.png",
},


  },
  {
    timestamps: true,
  }
);

userSchema.index({ email: 1 }, { unique: true, name: 'unique_login_email' });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
