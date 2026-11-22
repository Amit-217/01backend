const mongoose = require("mongoose");

const vendorSchema = new mongoose.Schema(
  {
    tenantId: {
      type: String,
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    phone: {
      type: String,
      trim: true,
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    emailKey: { type: String, select: false },

    address: {
      type: String,
      trim: true,
    },

    gstin: {
      type: String,
      trim: true,
      uppercase: true,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: { transform(_vendor, fields) { delete fields.emailKey; return fields; } },
  }
);

// Vendor name must be unique within a tenant
vendorSchema.index(
  { tenantId: 1, name: 1 },
  { unique: true }
);

// Legacy duplicates can remain readable while support resolves them. New email assignments
// reserve a normalized key, and the service checks legacy email fields before assigning one.
vendorSchema.index(
  { tenantId: 1, emailKey: 1 },
  { unique: true, partialFilterExpression: { emailKey: { $type: 'string' } } }
);

const Vendor = mongoose.model(
  "Vendor",
  vendorSchema
);

module.exports = Vendor;
