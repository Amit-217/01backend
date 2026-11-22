const { sendError } = require('../utils/response');

// Parses req.body with a Zod schema; unknown keys are stripped and the parsed value replaces req.body.
const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return sendError(res, 400, result.error.issues[0]?.message || 'Validation failed');
  }
  req.body = result.data;
  return next();
};

module.exports = validate;
