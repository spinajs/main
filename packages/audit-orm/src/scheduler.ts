import { Schedule, ScheduledTask } from '@spinajs/scheduler';
import type { RunContext } from '@spinajs/scheduler';

import { AuditPruneFailed, pruneAudit } from './retention.js';
import { sealAudit } from './seal/seal.js';
import type { SealResult } from './seal/seal.js';
import { shipAudit } from './ship/ship.js';
import type { ShipResult } from './ship/ship.js';

export const AUDIT_RETENTION_SCHEDULE = 'audit.retention';

export interface AuditRetentionResult {
  readonly deleted: number;
  readonly failed: readonly { readonly trail: string; readonly connection: string | undefined; readonly reason: string }[];
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
      // The scheduler keeps the result of a successful run only: the error message carries the count and the failures.
      if (err instanceof AuditPruneFailed) ctx.result({ deleted: err.deleted, failed: err.failed.map(({ trail, connection, reason }) => ({ trail, connection, reason })) });
      throw err;
    }
  }
}

export const AUDIT_SHIP_SCHEDULE = 'audit.ship';

export class AuditShipError extends Error {}

/** Ships buffered audit events every 10 seconds on the leader; a `scheduler.schedules` entry of the same name overrides the timing. */
@Schedule(AUDIT_SHIP_SCHEDULE, { every: '10s', runOn: 'leader', overlap: 'skip', misfire: 'run-once', timeout: '10m' })
export class AuditShipTask extends ScheduledTask {
  public async execute(ctx: Pick<RunContext, 'result'>): Promise<ShipResult> {
    const out = await shipAudit();
    ctx.result(out);
    if (out.failed.length > 0) throw new AuditShipError(`audit: shipping failed for ${out.failed.map((f) => `${f.trail}@${f.connection}`).join(', ')}`);
    return out;
  }
}

export const AUDIT_SEAL_SCHEDULE = 'audit.seal';

export class AuditSealError extends Error {}

/**
 * Seals the sealed trails every 60 seconds on the leader; a run seals what was already there one settle time earlier,
 * so an event is sealed within about two minutes. A `scheduler.schedules` entry of the same name overrides the timing.
 */
@Schedule(AUDIT_SEAL_SCHEDULE, { every: '60s', runOn: 'leader', overlap: 'skip', misfire: 'run-once', timeout: '10m' })
export class AuditSealTask extends ScheduledTask {
  public async execute(ctx: Pick<RunContext, 'result'>): Promise<SealResult> {
    const out = await sealAudit();
    ctx.result(out);
    if (out.failed.length > 0) throw new AuditSealError(`audit: sealing failed for ${out.failed.map((f) => `${f.trail}@${f.connection}`).join(', ')}`);
    return out;
  }
}
