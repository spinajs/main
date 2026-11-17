import { Schedule, ScheduledTask } from '@spinajs/scheduler';
import type { RunContext } from '@spinajs/scheduler';

import { AuditPruneFailed, pruneAudit } from './retention.js';

export const AUDIT_RETENTION_SCHEDULE = 'audit.retention';

export interface AuditRetentionResult {
  readonly deleted: number;
  readonly failed: readonly { readonly trail: string; readonly connection: string | undefined }[];
}

/** Prunes every trail that has `retentionDays`, daily; a `scheduler.schedules` entry of the same name overrides the timing. */
@Schedule(AUDIT_RETENTION_SCHEDULE, { every: '24h', runOn: 'leader', overlap: 'skip', misfire: 'run-once' })
export class AuditRetentionTask extends ScheduledTask {
  public async execute(ctx: Pick<RunContext, 'result'>): Promise<AuditRetentionResult> {
    try {
      const out: AuditRetentionResult = { deleted: await pruneAudit(), failed: [] };
      ctx.result(out);
      return out;
    } catch (err) {
      // The run fails, and its result still records what was pruned and where it failed.
      if (err instanceof AuditPruneFailed) ctx.result({ deleted: err.deleted, failed: err.failed.map(({ trail, connection }) => ({ trail, connection })) });
      throw err;
    }
  }
}
