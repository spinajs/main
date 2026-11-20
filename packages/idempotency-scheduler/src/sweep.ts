import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { IDEMPOTENCY_CONFIGURATION_SCHEMA, IdempotencyService } from '@spinajs/idempotency';
import { registerBuiltinSchedule, ScheduledTask } from '@spinajs/scheduler';
import type { RunContext } from '@spinajs/scheduler';

export const IDEMPOTENCY_SWEEP_SCHEDULE = 'idempotency.sweep';

export interface IdempotencySweepResult {
  swept: number;
  batches: number;
}

/** Sweeps `idempotency.sweepBatch` rows at a time until a batch comes back empty or the signal aborts. */
export async function sweepExpired(service: Pick<IdempotencyService, 'sweep'>, signal: AbortSignal): Promise<IdempotencySweepResult> {
  let swept = 0;
  let batches = 0;
  while (!signal.aborted) {
    const deleted = await service.sweep();
    batches++;
    swept += deleted;
    if (deleted === 0) break;
  }
  return { swept, batches };
}

/** The task of the builtin `idempotency.sweep` schedule; its return value is stored as the run result. */
export class IdempotencySweepTask extends ScheduledTask {
  public async execute(ctx: RunContext): Promise<IdempotencySweepResult> {
    // resolved per run: an async service injected into a task could arrive as a promise (doctor DI003)
    const result = await sweepExpired(await DI.resolve(IdempotencyService), ctx.signal);
    ctx.log.info(`idempotency sweep: ${result.swept} rows deleted in ${result.batches} batches`, result);
    return result;
  }
}

// a configuration the idempotency schema did not fill still gets the schema default
const sweepEvery = (): string => DI.get(Configuration)?.get<string>('idempotency.sweepEvery') ?? IDEMPOTENCY_CONFIGURATION_SCHEMA.properties.sweepEvery.default;

// The factory runs when ScheduleRegistry resolves, after the Configuration; its argument holds scheduler.* only.
registerBuiltinSchedule(() => ({
  name: IDEMPOTENCY_SWEEP_SCHEDULE,
  options: { every: sweepEvery(), runOn: 'leader', overlap: 'skip' },
  target: IdempotencySweepTask,
  source: 'builtin',
}));
