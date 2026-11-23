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
export { carriesTenantSettings } from './transaction.js';
// Registers the scope-change guard of T4 with @spinajs/tenancy.
export { stopTransactionScopeGuard } from './scope-guard.js';
export { TENANCY_CONNECTION, TENANTS_TABLE } from './connection.js';
export { TenantModel } from './models/TenantModel.js';
export { Tenants_2026_11_16_00_00_00 } from './migrations/Tenants_2026_11_16_00_00_00.js';
export { canTransition, isTenantState, nextStates } from './state-machine.js';
export { toTenantRecord } from './records.js';
export { TenantStateService } from './states.js';
// Registers DbTenantRegistry as a TenantRegistry.
export { DbTenantRegistry } from './db-registry.js';
