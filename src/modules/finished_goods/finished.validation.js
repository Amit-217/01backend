const { z } = require('zod');
const { units, movementTypes } = require('./finished.model');
const { AppError } = require('../../common/utils/errors');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Expected a valid ID.').transform((value) => value.toLowerCase());
const name = z.string().trim().min(2).max(120);
const variant = z.string().trim().max(60);
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._-]{0,49}$/,
  'Use 1–50 letters, digits, dots, underscores or hyphens for the SKU code.');
const createProduct = z.strictObject({ name, unit: z.enum(units) });
const createSku = z.strictObject({ productId: objectId, code, size: variant.optional(), colour: variant.optional() });
const requireChanges = (schema) => schema.refine((value) => Object.keys(value).length > 0, 'Provide at least one change.');
const updateProduct = requireChanges(z.strictObject({ name: name.optional(), isActive: z.boolean().optional() }));
const updateSku = requireChanges(createSku.omit({ productId: true }).partial().extend({ isActive: z.boolean().optional() }));
const noQuery = z.strictObject({});
const skuQuery = z.strictObject({ productId: objectId.optional() });
const direction = z.enum(['IN', 'OUT']);
const quantity = z.number().min(0.0001).max(1e12);
const reason = z.string().trim().min(1).max(250);
const movement = z.discriminatedUnion('type', [
  z.strictObject({ type: z.enum(['RECEIPT', 'DISPATCH', 'RETURN']), ...movementFields() }),
  z.strictObject({ type: z.literal('OPENING'), ...movementFields(), reason }),
  z.strictObject({ type: z.literal('ADJUSTMENT'), ...movementFields(), direction, reason }),
]);

function movementFields() {
  return {
    skuId: objectId, quantity, date: z.iso.date().optional(),
    reference: z.string().trim().max(120).optional(), notes: z.string().trim().max(500).optional(),
  };
}

const movementQuery = z.strictObject({
  productId: objectId.optional(), skuId: objectId.optional(), type: z.enum(movementTypes).optional(),
  actorId: z.string().trim().min(1).max(128).optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(),
  cursor: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_[a-f\d]{24}$/).optional(),
  limit: z.string().regex(/^[1-9]\d?$/).transform(Number).pipe(z.number().max(50)).optional(),
});
const validRange = (schema) => schema.refine((query) => !query.from || !query.to || query.from <= query.to,
  'Start date must be on or before end date.');
const auditQuery = validRange(movementQuery);
const publicQuery = validRange(movementQuery.omit({ actorId: true }));

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError(400, result.error.issues[0].message);
  return result.data;
}

module.exports = {
  objectId, createProduct, updateProduct, createSku, updateSku, noQuery, skuQuery,
  movement, auditQuery, publicQuery, direction, quantity, reason, parse,
};
