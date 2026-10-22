import '@spinajs/authn/register-schema';
import { AsyncService, Autoinject, Injectable, PerChildInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { Orm } from '@spinajs/orm';

import { AuthnAudit } from '../models/AuthnAudit.js';
import { checkedMs, instant } from '../support/sql.js';

const DAY_MS = 86_400_000;
const PURGE_BATCH = 500;

/**
 * Deletes `authn_audit` rows older than `authn.audit.retentionDays`, in batches, on `purge` and, when
 * `authn.audit.purgeInterval` (ms) is set, on a timer. Both keys are unset by default: audit rows are kept forever.
 */
@PerChildInstance()
@Injectable()
export class AuthnAuditRetention extends AsyncService {
  /** Never read: injecting it resolves the Orm, which binds `AuthnAudit`, before the first purge. */
  @Autoinject(Orm)
  protected Orm: Orm;

  @Config('authn.audit.retentionDays')
  protected RetentionDays: number | null | undefined;

  @Config('authn.audit.purgeInterval')
  protected PurgeInterval: number | null | undefined;

  @Logger('authn-orm')
  protected Log: Log;

  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  public get Enabled(): boolean {
    return typeof this.RetentionDays === 'number' && this.RetentionDays > 0;
  }

  public async resolve(): Promise<void> {
    if (!this.Enabled || !this.PurgeInterval || this.PurgeInterval < 1) {
      return;
    }

    this.timer = setInterval(() => void this.tick(), this.PurgeInterval);
    this.timer.unref?.();
  }

  public async dispose(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Deletes the rows older than the retention; returns how many went. 0 while `retentionDays` is unset. */
  public async purge(now: Date = new Date()): Promise<number> {
    const days = this.RetentionDays;
    if (typeof days !== 'number' || !(days > 0)) {
      return 0;
    }

    const cutoff = instant(checkedMs(now, 'AuthnAuditRetention.purge: now') - days * DAY_MS);

    let removed = 0;
    for (;;) {
      // MSSQL pages with OFFSET ... FETCH, which needs an ORDER BY.
      const ids = (await AuthnAudit.query().columns(['id']).where('at', '<', cutoff).orderBy('at').take(PURGE_BATCH)).map((r) => r.id);
      if (ids.length === 0) {
        break;
      }

      const deleted = (await AuthnAudit.destroy().whereIn('id', ids).where('at', '<', cutoff)).RowsAffected;
      removed += deleted;
      if (ids.length < PURGE_BATCH || deleted === 0) {
        break;
      }
    }

    return removed;
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      const count = await this.purge();
      if (count > 0) {
        this.Log.info({ count }, 'Purged audit rows past retention, count: ${count}');
      }
    } catch (err) {
      // An unhandled rejection here would end the process; the next tick retries.
      this.Log.error(err as Error, 'Audit retention purge failed');
    } finally {
      this.running = false;
    }
  }
}
