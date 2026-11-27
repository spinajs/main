export * from './names.js';
export { tenancyAuthz } from './host.js';
// Registers AuthzTenantAccess as a TenantAccess; @spinajs/tenancy takes it when tenancy.access is unset.
export { AuthzTenantAccess } from './access.js';
export { tenantsOf } from './tenants-of.js';
