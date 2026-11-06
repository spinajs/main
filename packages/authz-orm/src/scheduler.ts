import { Schedule, ScheduledTask } from '@spinajs/scheduler';
import type { RunContext } from '@spinajs/scheduler';

import { changeLogRetentionDays, pruneChangeLog } from './changelog/retention.js';

export const CHANGELOG_RETENTION_SCHEDULE = 'authz.changelog.retention';

/** Prunes authz_change_log daily to `authz.changelog.retentionDays`; a `scheduler.schedules` entry of the same name overrides it. */
@Schedule(CHANGELOG_RETENTION_SCHEDULE, { every: '24h', runOn: 'leader', overlap: 'skip', misfire: 'run-once' })
export class ChangeLogRetentionTask extends ScheduledTask {
  public async execute(ctx: RunContext): Promise<{ readonly deleted: number; readonly retentionDays: number }> {
    const retentionDays = changeLogRetentionDays();
    const out = { deleted: await pruneChangeLog(retentionDays), retentionDays };
    ctx.result(out);
    return out;
  }
}
