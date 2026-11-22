const { z } = require('zod');
const { AppError } = require('../../../common/utils/errors');
const { movementTypes } = require('./material.transaction.validation');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Expected a MongoDB ObjectId.');
const movementFilters = z.strictObject({
  rawMaterialId: objectId.optional(),
  type: z.enum(movementTypes).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  cursor: z.string().regex(/^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_[a-f\d]{24}$/).optional(),
  limit: z.string().regex(/^[1-9]\d?$/).transform(Number).pipe(z.number().max(50)).optional(),
});

const movementFilter = ({ rawMaterialId, type, from, to, cursor }) => {
  if (from && to && from > to) throw new AppError(400, 'Start date must be on or before end date.');
  const query = {};
  if (rawMaterialId) query.rawMaterialId = rawMaterialId;
  if (type) query.type = type;
  if (from || to) {
    query.date = {};
    if (from) query.date.$gte = new Date(from + 'T00:00:00.000Z');
    if (to) query.date.$lte = new Date(to + 'T23:59:59.999Z');
  }
  if (cursor) {
    const [value, id] = cursor.split('_');
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
      throw new AppError(400, 'Invalid movement cursor.');
    }
    query.$or = [{ date: { $lt: date } }, { date, _id: { $lt: id } }];
  }
  return query;
};

const movementPage = (rows, limit) => {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit ? last.date.toISOString() + '_' + last._id : null };
};

module.exports = { objectId, movementFilters, movementFilter, movementPage };
