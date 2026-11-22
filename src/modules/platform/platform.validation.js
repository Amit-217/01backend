const { z } = require('zod');
const { objectId } = require('../raw_material/material_transaction/movement.audit');

const readableId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, 'Invalid identifier.');
const staffIdentity = z.strictObject({
  name: z.string().trim().min(2).max(100),
  email: z.email().max(254).transform((value) => value.toLowerCase()),
  role: z.enum(['support', 'operator']),
  password: z.string().min(14).refine((value) => Buffer.byteLength(value) <= 72, 'Password is too long.'),
});
const login = z.strictObject({
  email: staffIdentity.shape.email,
  password: staffIdentity.shape.password,
  code: z.string().regex(/^\d{6}$/, 'Enter a six-digit authenticator code.'),
});
const context = z.strictObject({
  caseReference: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{1,79}$/, 'Enter a valid support case reference.'),
  reason: z.string().trim().min(5).max(250),
});
const status = context.extend({ status: z.enum(['active', 'inactive']) });
const role = context.extend({ role: z.enum(['admin', 'employee']) });
const access = context.extend({ access: z.enum(['full', 'read_only', 'suspended']) });
const billing = context.extend({
  paidUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.')
    .refine((value) => !Number.isNaN(Date.parse(value + 'T00:00:00Z')), 'Enter a real date.').nullable(),
  billingNote: z.string().trim().max(500).optional(),
});
const directionAndQuantity = {
  direction: z.enum(['IN', 'OUT']),
  quantity: z.number().min(0.0001).max(Number.MAX_SAFE_INTEGER),
};
const adjustment = context.extend({
  rawMaterialId: objectId,
  correctionOf: objectId,
  ...directionAndQuantity,
});
const bulkStock = context.extend({
  lines: z.array(z.strictObject({ rawMaterialId: objectId, ...directionAndQuantity })).min(2).max(25),
});
const recovery = context.extend({
  snapshotReference: z.string().trim().min(3).max(150),
  impactPreview: z.string().trim().min(10).max(1000),
});
const finishRecovery = context.extend({
  outcome: z.enum(['completed', 'failed']),
  evidenceReference: z.string().trim().min(3).max(150),
});
const directoryQuery = z.strictObject({
  cursor: objectId.optional(),
  lookup: z.string().trim().min(1).max(120).optional(),
});
const pageQuery = directoryQuery.omit({ lookup: true });

module.exports = {
  readableId, staffIdentity, login, context, status, role, access, billing, adjustment, bulkStock, recovery,
  finishRecovery, directoryQuery, pageQuery,
};
