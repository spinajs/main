import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import type { RunModel } from '../models/RunModel.js';

/** The tenant a run belongs to, by id; the scheduler knows nothing else about tenants. */
export interface ScheduleTenant {
  readonly id: string;
}

export interface ScheduleRunInfo {
  readonly runId: string;
  readonly schedule: string;
  /** Undefined for a run of the global instance. */
  readonly tenant: ScheduleTenant | undefined;
}

/**
 * Wraps the body of every run the loop executes, and the emit of an emit-mode run; `@spinajs/tenancy/scheduler` enters
 * the run's tenant here. A refusal fails the attempt like an error of the task. Inline runs are not wrapped: they run
 * in the scope of the code that started them.
 */
export abstract class ScheduleRunHook {
  /** A lower order is further out; among hooks of one order, the first registered. */
  public readonly order: number = 0;

  public abstract aroundRun<T>(run: ScheduleRunInfo, next: () => Promise<T>): Promise<T>;
}

/** `null` (a run row) and `''` (a schedule row) both mean the global instance. */
export function scheduleTenantOf(tenant: string | null | undefined): ScheduleTenant | undefined {
  return tenant ? Object.freeze({ id: tenant }) : undefined;
}

export function scheduleRunInfo(run: RunModel): ScheduleRunInfo {
  return Object.freeze({ runId: run.Id, schedule: run.Schedule, tenant: scheduleTenantOf(run.Tenant) });
}

// Resolved on every call, as the queue's hooks are: a hook registered after the loop started still applies.
export async function runScheduleHooks<T>(run: ScheduleRunInfo, work: () => Promise<T>): Promise<T> {
  const registered: ScheduleRunHook[] = (await DI.resolve(Array.ofType(ScheduleRunHook))) ?? [];
  // Without a hook nothing enters the tenant: the body would run in whatever scope the loop has.
  if (run.tenant && registered.length === 0) {
    throw new InvalidOperation(
      `run ${run.runId} of '${run.schedule}' belongs to tenant '${run.tenant.id}' and no ScheduleRunHook is registered to enter it; import '@spinajs/tenancy/scheduler' in every process that runs the scheduler loop`,
    );
  }
  // Array.prototype.sort is stable, so hooks of one order keep their registration order.
  const chain = [...registered].sort((a, b) => a.order - b.order);
  return chain.reduceRight<() => Promise<T>>((next, hook) => () => hook.aroundRun(run, next), work)();
}
