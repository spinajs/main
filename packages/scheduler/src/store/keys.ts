import type { IWhereBuilder } from '@spinajs/orm';

/** The tenant column of a global schedule's row. */
export const GLOBAL_TENANT = '';

/** One row of `__scheduler`: a schedule and the tenant of its instance, `GLOBAL_TENANT` for the global one. */
export interface ScheduleKey {
  readonly name: string;
  readonly tenant: string;
}

/** A bare name addresses the global instance, as every call did before schedules had tenants. */
export type ScheduleRef = string | ScheduleKey;

export function scheduleKey(ref: ScheduleRef): ScheduleKey {
  return typeof ref === 'string' ? { name: ref, tenant: GLOBAL_TENANT } : ref;
}

/** The `where()` condition that matches one row of `__scheduler`. */
export function scheduleRow(ref: ScheduleRef): { Name: string; Tenant: string } {
  const key = scheduleKey(ref);
  return { Name: key.name, Tenant: key.tenant };
}

export function runScheduleKey(run: { Schedule: string; Tenant?: string | null }): ScheduleKey {
  return { name: run.Schedule, tenant: run.Tenant ?? GLOBAL_TENANT };
}

/** `__scheduler_run.Tenant` of a run of this instance. */
export function runTenantOf(key: ScheduleKey): string | null {
  return key.tenant === GLOBAL_TENANT ? null : key.tenant;
}

/** The runs of one instance; a global run's tenant is NULL, which `= ''` or `= NULL` would never match. */
export function runsOf(key: ScheduleKey): (this: IWhereBuilder<unknown>) => void {
  return function (this: IWhereBuilder<unknown>) {
    this.where('Schedule', key.name);
    if (key.tenant === GLOBAL_TENANT) this.whereNull('Tenant');
    else this.where('Tenant', key.tenant);
  };
}

/** A map key of one instance; a tenant id never holds U+0000. */
export function instanceId(key: ScheduleKey): string {
  return `${key.name}\u0000${key.tenant}`;
}
