import './once.js';

export { Tenant, registerTenantModel } from './decorators.js';
export { tenantModelOf, tenantModelOfTable, tenantModels } from './registry.js';
export type { TenantIsolation, TenantModelEntry, TenantModelOptions } from './registry.js';
// Registers the schema of tenancy.orm.
export { TENANCY_ORM_CONFIGURATION_SCHEMA, TENANCY_ORM_DEFAULTS } from './schema.js';
// Registers TenantScopeMiddleware as a QueryMiddleware.
export { TenantScopeMiddleware } from './middleware.js';
export { acrossTenantsReason } from './marker.js';
// Registers `.acrossTenants()` on select, update and delete builders.
export { TenantDeleteExtension, TenantSelectExtension, TenantUpdateExtension } from './across.js';
export type { SameQuery, TenantQueryMethods } from './across.js';
