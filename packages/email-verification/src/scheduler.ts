import { Autoinject } from '@spinajs/di';
import { Schedule, ScheduledTask } from '@spinajs/scheduler';
import type { RunContext } from '@spinajs/scheduler';

import { DomainListSync } from './sync.js';
import type { SyncOutcome } from './sync.js';

export const EMAIL_DOMAIN_LIST_SYNC_SCHEDULE = 'email-verification.list-sync';

@Schedule(EMAIL_DOMAIN_LIST_SYNC_SCHEDULE, { every: '24h', runOn: 'leader', overlap: 'skip', misfire: 'run-once' })
export class EmailDomainListSyncTask extends ScheduledTask {
  @Autoinject(DomainListSync)
  protected Sync: DomainListSync;

  public async execute(ctx: RunContext): Promise<SyncOutcome[]> {
    const outcomes = await this.Sync.run();
    // The scheduler persists ctx.result only for successful runs, so a failure must carry the per-source errors in its message.
    const failed = outcomes.filter((o) => o.status === 'failed');
    if (failed.length > 0) throw new Error(`list sync failed: ${failed.map((o) => `${o.source}: ${o.error}`).join('; ')}`);
    ctx.result(outcomes);
    return outcomes;
  }
}
