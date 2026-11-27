import { Injectable } from '@spinajs/di';
import { ScheduleRunHook } from '@spinajs/scheduler';
import type { ScheduleRunInfo } from '@spinajs/scheduler';
import { admitTenant, tenantScopeOf } from './index.js'; // the entry registers the registries: a loop process may load nothing else
import { establishTenantScope } from './scope.js';

/** Below the default order: a hook of another package (authz, audit) runs inside the run's tenant. */
export const TENANT_SCHEDULE_HOOK_ORDER = -100;

/**
 * Runs a schedule run inside the tenant of its instance, once the registry admits it, and a run of the global instance
 * with no tenant scope. The store starts empty: the loop may run inside whatever context resolved or woke it, and a run
 * takes along neither that scope nor its principal.
 */
@Injectable(ScheduleRunHook)
export class TenantScheduleRunHook extends ScheduleRunHook {
  public override readonly order: number = TENANT_SCHEDULE_HOOK_ORDER;

  public async aroundRun<T>(run: ScheduleRunInfo, next: () => Promise<T>): Promise<T> {
    if (!run.tenant) return establishTenantScope(undefined, next, { inherit: false });
    const tenant = await admitTenant(run.tenant.id);
    return establishTenantScope(tenantScopeOf(tenant.id), next, { inherit: false });
  }
}
