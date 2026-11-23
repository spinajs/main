import type { TenantScope } from '@spinajs/tenancy';

declare module '@spinajs/http' {
  interface IActionLocalStoregeContext {
    /** Written by TenantMiddleware before the policy gate; `tenantScope()` reads it inside the action. */
    Tenant?: TenantScope;
  }
}
