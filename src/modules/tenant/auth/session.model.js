const mongoose = require('mongoose');

const authSessionSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  tenantId: { type: String, required: true, index: true },
  credentialVersion: { type: Number, default: 0 },
  tenantAccessVersion: { type: Number, default: 0 },
  refreshTokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.AuthSession || mongoose.model('AuthSession', authSessionSchema);
