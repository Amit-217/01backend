const Tenant = require('./tenant.model');

const getTenantByContext = async (tenantId) => Tenant.findOne({ tenantId });

module.exports = {
  getTenantByContext,
};
