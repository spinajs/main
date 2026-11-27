import type { Principal } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { TenantAccess } from '@spinajs/tenancy';
import type { TenantRecord } from '@spinajs/tenancy';

import { tenancyAuthz } from './host.js';
import { TENANT_ENTER, tenantResource } from './names.js';

/** Entering a tenant is `tenant:enter` on `tenant:<id>`; `@spinajs/tenancy` takes it when `tenancy.access` is unset. */
@Injectable(TenantAccess)
export class AuthzTenantAccess extends TenantAccess {
  public async canEnter(principal: Principal, tenant: TenantRecord): Promise<boolean> {
    return (await tenancyAuthz()).can(principal, TENANT_ENTER, tenantResource(tenant.id));
  }
}
