const { getTenantByContext } = require('./tenant.service');
const { sendSuccess, sendError } = require('../../../common/utils/response');
const { asyncHandler } = require('../../../common/utils/errors');
const { sanitizeTenant } = require('./tenant.util');

const getCurrentTenant = asyncHandler(async (req, res) => {
  const tenant = await getTenantByContext(req.user.tenantId);
  if (!tenant) {
    return sendError(res, 404, 'Tenant not found.');
  }

  return sendSuccess(res, 200, 'Tenant retrieved successfully.', sanitizeTenant(tenant));
});

module.exports = {
  getCurrentTenant,
};
