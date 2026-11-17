import { Injectable } from '@spinajs/di';
import type { Principal } from '@spinajs/principal';
import { TenantAccess } from './contracts.js';
import type { TenantRecord } from './contracts.js';

/** Allows a principal whose `attributes.tenants` (a list of tenant ids) holds the tenant. */
@Injectable(TenantAccess)
export class PrincipalAttributeTenantAccess extends TenantAccess {
  public canEnter(principal: Principal, tenant: TenantRecord): Promise<boolean> {
    const tenants: unknown = principal.attributes.tenants;
    return Promise.resolve(Array.isArray(tenants) && tenants.includes(tenant.id));
  }
}
