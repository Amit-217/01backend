const { supportContact } = require('../../../config/support');
const { accessLevel } = require('../../../common/utils/workspaceAccess');

// Billing details (paidUntil, billingNote) are for platform staff only and are never sent to the company.
const sanitizeTenant = (tenant) => {
  if (!tenant) return null;

  return {
    tenantId: tenant.tenantId,
    name: tenant.name,
    email: tenant.email,
    emailVerified: tenant.emailVerified,
    status: tenant.status,
    access: accessLevel(tenant),
    support: supportContact(),
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
  };
};

module.exports = {
  sanitizeTenant,
};
