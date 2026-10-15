import { Autoinject } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { BaseController } from '@spinajs/http';
import { SCHEDULER_SSE_HEARTBEAT_MS, SchedulerService, TriggeredBy } from '@spinajs/scheduler';
import { IPrincipalStorage, triggeredByFrom } from './principal.js';

export function compact<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Shared base of the scheduler controllers. Kept outside `controllers/` so the
 * directory scan does not try to mount it.
 */
export abstract class SchedulerControllerBase extends BaseController {
  @Autoinject(SchedulerService)
  protected Scheduler: SchedulerService;

  @Config('scheduler.http.sse.heartbeat', { defaultValue: SCHEDULER_SSE_HEARTBEAT_MS })
  protected HeartbeatMs: number;

  protected triggeredBy(): TriggeredBy {
    // the action runs inside AsyncLocalStorage.run(req.storage), so the store is the request storage
    return triggeredByFrom(this._actionLocalStorage.getStore() as unknown as IPrincipalStorage | undefined);
  }
}
