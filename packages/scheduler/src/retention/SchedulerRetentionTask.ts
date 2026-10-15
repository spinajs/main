import { Autoinject } from '@spinajs/di';
import { registerBuiltinSchedule } from '../decorators.js';
import type { RunContext } from '../run/RunContext.js';
import { ScheduledTask } from '../ScheduledTask.js';
import { DbClock } from '../time/clock.js';
import { PurgeResult, RetentionService } from './RetentionService.js';

export const SCHEDULER_RETENTION_SCHEDULE = 'scheduler-retention';

/** The built-in nightly purge (design §10); `scheduler.retention` sets its cron and windows. */
export class SchedulerRetentionTask extends ScheduledTask {
  @Autoinject(RetentionService)
  protected Retention: RetentionService;

  @Autoinject(DbClock)
  protected Clock: DbClock;

  public async execute(ctx: RunContext): Promise<PurgeResult> {
    const purged = await ctx.step('purge', async () => this.Retention.purge(await this.Clock.sync()));
    ctx.result(purged);
    return purged;
  }
}

registerBuiltinSchedule((cfg) =>
  cfg.retention.enabled
    ? {
        name: SCHEDULER_RETENTION_SCHEDULE,
        options: { cron: cfg.retention.schedule, overlap: 'skip', misfire: 'run-once' },
        target: SchedulerRetentionTask,
        source: 'builtin',
      }
    : null,
);
