const mongoose = require('mongoose');
const { Schema } = mongoose;

const staffSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  role: { type: String, enum: ['support', 'operator'], required: true },
  active: { type: Boolean, default: true },
  passwordHash: { type: String, required: true, select: false },
  totpSecret: { type: String, required: true, select: false },
  lastTotpStep: { type: Number, default: -1, select: false },
}, { timestamps: true });

const sessionSchema = new Schema({
  staffId: { type: Schema.Types.ObjectId, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true, select: false },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const auditSchema = new Schema({
  staffId: Schema.Types.ObjectId,
  staffName: String,
  tenantId: String,
  action: { type: String, required: true },
  target: String,
  caseReference: String,
  reason: String,
  details: String,
  outcome: { type: String, enum: ['succeeded', 'prepared', 'failed'], required: true },
  status: { type: Number, required: true },
  resultId: String,
}, { timestamps: { createdAt: true, updatedAt: false } });
auditSchema.index({ tenantId: 1, _id: -1 });

const repairLine = new Schema({
  rawMaterialId: { type: Schema.Types.ObjectId, required: true },
  name: String,
  unit: String,
  direction: { type: String, enum: ['IN', 'OUT'], required: true },
  quantity: { type: Number, required: true, min: 0.0001 },
  stockBefore: { type: Number, required: true },
}, { _id: false });
const changeSchema = new Schema({
  tenantId: { type: String, required: true },
  kind: { type: String, enum: ['stock', 'recovery'], required: true },
  status: { type: String, enum: ['pending', 'approved', 'completed', 'failed'], default: 'pending' },
  caseReference: { type: String, required: true },
  reason: { type: String, required: true },
  requestedBy: { type: Schema.Types.ObjectId, required: true },
  requestedByName: String,
  approvedBy: Schema.Types.ObjectId,
  approvedByName: String,
  approvedAt: Date,
  completedBy: Schema.Types.ObjectId,
  completedAt: Date,
  lines: { type: [repairLine], default: undefined },
  snapshotReference: String,
  impactPreview: String,
  evidenceReference: String,
  movementIds: { type: [Schema.Types.ObjectId], default: undefined },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
changeSchema.index({ tenantId: 1, _id: -1 });

module.exports = {
  PlatformStaff: mongoose.model('PlatformStaff', staffSchema),
  PlatformSession: mongoose.model('PlatformSession', sessionSchema),
  PlatformAudit: mongoose.model('PlatformAudit', auditSchema),
  PlatformChange: mongoose.model('PlatformChange', changeSchema),
};
