import { Schedule, ScheduledTask } from '@spinajs/scheduler';
import type { RunContext } from '@spinajs/scheduler';

import { pruneAudit } from './retention.js';

export const AUDIT_RETENTION_SCHEDULE = 'audit.retention';

/** Prunes every trail that has `retentionDays`, daily; a `scheduler.schedules` entry of the same name overrides the timing. */
@Schedule(AUDIT_RETENTION_SCHEDULE, { every: '24h', runOn: 'leader', overlap: 'skip', misfire: 'run-once' })
export class AuditRetentionTask extends ScheduledTask {
  public async execute(ctx: Pick<RunContext, 'result'>): Promise<{ readonly deleted: number }> {
    const out = { deleted: await pruneAudit() };
    ctx.result(out);
    return out;
  }
}
