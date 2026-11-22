const { z } = require('zod');
const { allowedUnits } = require('../raw_material/raw.material.validation');

const movementTypes = ['IN', 'CONSUMPTION', 'ADJUSTMENT', 'OPENING'];
const referencesByType = {
  IN: ['PURCHASE'],
  CONSUMPTION: ['DIRECT_CONSUMPTION', 'PRODUCTION'],
  ADJUSTMENT: ['ADJUSTMENT'],
  OPENING: ['OPENING'],
};
const referenceTypes = Object.values(referencesByType).flat();
const movementDate = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

const createMaterialTransactionValidation = z.object({
  rawMaterialId: z.string().min(1, 'Raw material is required.'),
  type: z.enum(movementTypes),
  direction: z.enum(['IN', 'OUT']),
  quantity: z.number().positive('Quantity must be greater than zero.'),
  rate: z.number().min(0, 'Rate cannot be negative.').optional(),
  vendorId: z.string().optional(),
  referenceType: z.enum(referenceTypes),
  referenceId: z.string().optional(),
  reference: z.string().trim().max(120, 'Reference is too long.').optional(),
  expectedUnit: z.enum(allowedUnits).optional(),
  reason: z.string().trim().max(250, 'Reason is too long.').optional(),
  date: movementDate.optional(),
  notes: z.string().trim().max(500, 'Notes are too long.').optional(),
}).refine(({ type, referenceType }) => referencesByType[type]?.includes(referenceType), {
  message: 'Reference type does not match this stock movement.',
  path: ['referenceType'],
});

module.exports = {
  createMaterialTransactionValidation,
  movementDate,
  movementTypes,
  referencesByType,
  referenceTypes,
};
