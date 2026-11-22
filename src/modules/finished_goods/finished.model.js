const mongoose = require('mongoose');
const { Schema } = mongoose;

const units = ['kg', 'g', 'ltr', 'ml', 'pcs', 'box', 'meter', 'cm', 'feet', 'inch', 'dozen', 'pack'];
const movementTypes = ['RECEIPT', 'DISPATCH', 'RETURN', 'OPENING', 'ADJUSTMENT', 'REVERSAL'];

const productSchema = new Schema({
  tenantId: { type: String, required: true },
  name: { type: String, required: true },
  nameKey: { type: String, select: false },
  unit: { type: String, enum: units, required: true, immutable: true },
  isActive: { type: Boolean, default: true },
  skuRevision: { type: Number, default: 0, select: false },
}, { timestamps: true });
productSchema.index({ tenantId: 1, name: 1 });
productSchema.index({ tenantId: 1, unit: 1, nameKey: 1 }, {
  unique: true, partialFilterExpression: { nameKey: { $type: 'string' } },
});

const skuSchema = new Schema({
  tenantId: { type: String, required: true },
  productId: { type: Schema.Types.ObjectId, ref: 'FinishedProduct', required: true, immutable: true },
  code: { type: String, required: true },
  reservedCodes: { type: [String], default: undefined },
  size: String,
  colour: String,
  unit: { type: String, enum: units, required: true, immutable: true },
  currentStock: { type: Number, min: 0, default: 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });
skuSchema.index({ tenantId: 1, code: 1 }, { unique: true });
skuSchema.index({ tenantId: 1, reservedCodes: 1 }, {
  unique: true, partialFilterExpression: { reservedCodes: { $exists: true } },
});
skuSchema.index({ tenantId: 1, productId: 1, isActive: 1 });

const movementSchema = new Schema({
  tenantId: { type: String, required: true },
  productId: { type: Schema.Types.ObjectId, required: true },
  skuId: { type: Schema.Types.ObjectId, required: true },
  productName: { type: String, required: true },
  skuCode: { type: String, required: true },
  size: String,
  colour: String,
  type: { type: String, enum: movementTypes, required: true },
  direction: { type: String, enum: ['IN', 'OUT'], required: true },
  quantity: { type: Number, min: 0.0001, required: true },
  date: { type: Date, required: true },
  reference: String,
  notes: String,
  reason: String,
  createdBy: { type: String, required: true },
  actorName: String,
  actorRole: { type: String, enum: ['admin', 'employee'] },
  stockBefore: { type: Number, required: true },
  stockAfter: { type: Number, required: true },
  stockUnit: { type: String, enum: units, required: true },
  reversalOf: Schema.Types.ObjectId,
  correctionOf: Schema.Types.ObjectId,
  dispatchId: Schema.Types.ObjectId,
  idempotencyKey: { type: String, select: false },
  fingerprint: { type: String, select: false },
}, { timestamps: { createdAt: true, updatedAt: false } });
movementSchema.index({ tenantId: 1, date: -1, _id: -1 });
movementSchema.index({ tenantId: 1, skuId: 1, date: -1, _id: -1 });
movementSchema.index({ tenantId: 1, createdAt: -1, _id: -1 });
movementSchema.index({ tenantId: 1, skuId: 1, createdAt: -1, _id: -1 });
movementSchema.index({ tenantId: 1, skuCode: 1, skuId: 1 });
movementSchema.index({ tenantId: 1, dispatchId: 1 });
movementSchema.index({ tenantId: 1, createdBy: 1, date: -1, _id: -1 });
movementSchema.index({ tenantId: 1, createdBy: 1, idempotencyKey: 1 }, {
  unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } },
});
movementSchema.index({ tenantId: 1, reversalOf: 1 }, {
  unique: true, partialFilterExpression: { reversalOf: { $type: 'objectId' } },
});

module.exports = {
  units, movementTypes,
  FinishedProduct: mongoose.model('FinishedProduct', productSchema),
  FinishedSku: mongoose.model('FinishedSku', skuSchema),
  FinishedMovement: mongoose.model('FinishedMovement', movementSchema),
};
