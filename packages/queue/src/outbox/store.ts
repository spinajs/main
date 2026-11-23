import { RowLease, type RowLeaseTarget } from '@spinajs/durable';
import { rowsAffected, type IWhereBuilder, type OrmDriver } from '@spinajs/orm';
import { OUTBOX_TABLE, toOutboxRow, type NewOutboxRow, type OutboxRow } from './row.js';

export interface OutboxClaim {
  row: OutboxRow;
  owner: string;
  epoch: number;
  until: number;
}

export interface OutboxFailure {
  Status: 'pending' | 'dead';
  Attempts: number;
  AvailableAt: number;
  LastError: string;
  PublishedTo: readonly string[];
}

export const OUTBOX_LAST_ERROR_MAX = 4000;

const target = (row: OutboxRow): RowLeaseTarget => ({ table: OUTBOX_TABLE, key: { Id: row.Id } });

const publishedBefore = (before: number) =>
  function (this: IWhereBuilder<unknown>) {
    this.where('Status', 'published').where('PublishedAt', '<', before);
  };

/** Every statement on queue_outbox. Every write after the insert is fenced by the RowLease columns. */
export class OutboxStore {
  protected readonly lease: RowLease;

  constructor(public readonly driver: OrmDriver) {
    this.lease = new RowLease(driver);
  }

  public async insert(row: NewOutboxRow): Promise<boolean> {
    // INSERT OR IGNORE / ON CONFLICT DO NOTHING: a duplicate MessageId must not abort the caller's transaction on Postgres
    return rowsAffected(await this.driver.insert().into(OUTBOX_TABLE).values(row).orIgnore()) === 1;
  }

  public async find(messageId: string): Promise<OutboxRow | undefined> {
    const rows = await this.driver.select<Record<string, unknown>[]>().from(OUTBOX_TABLE).where('MessageId', messageId).onPrimary();
    // MySQL (PAD SPACE collations) and SQL Server compare 'a1' equal to 'a1 '; only the exact id is this message's row
    return rows.map(toOutboxRow).find((row) => row.MessageId === messageId);
  }

  /** Pending rows whose time has come and whose claim, if any, ended. */
  public async due(now: number, limit: number): Promise<OutboxRow[]> {
    const rows = await this.driver
      .select<Record<string, unknown>[]>()
      .from(OUTBOX_TABLE)
      .where('Status', 'pending')
      .where('AvailableAt', '<=', now)
      .where(function (this: IWhereBuilder<unknown>) {
        this.whereNull('ClaimedBy').orWhere('ClaimedUntil', '<', now);
      })
      .orderBy('Id')
      .take(limit)
      .onPrimary();
    return rows.map(toOutboxRow);
  }

  public async claim(row: OutboxRow, owner: string, ttlMs: number, now: number): Promise<OutboxClaim | null> {
    // Attempts and PublishedTo of `row` are trusted after this: they change only under a claim, and a claim taken
    // since `row` was read moved the epoch, so this one loses
    const won = await this.lease.claimObserved(target(row), owner, ttlMs, now, row.ClaimEpoch, { Status: 'pending' });
    return won ? { row, owner, epoch: won.epoch, until: now + ttlMs } : null;
  }

  public async markPublished(claim: OutboxClaim, publishedTo: readonly string[], now: number): Promise<boolean> {
    const r = await this.driver
      .update()
      .in(OUTBOX_TABLE)
      .update({ Status: 'published', PublishedAt: now, PublishedTo: JSON.stringify(publishedTo), ClaimedBy: null, ClaimedUntil: null })
      .where(this.lease.fenced(target(claim.row), claim.owner, claim.epoch));
    return rowsAffected(r) === 1;
  }

  public release(claim: OutboxClaim): Promise<boolean> {
    return this.lease.release(target(claim.row), claim.owner, claim.epoch);
  }

  public async markFailed(claim: OutboxClaim, failure: OutboxFailure): Promise<boolean> {
    const r = await this.driver
      .update()
      .in(OUTBOX_TABLE)
      .update({ ...failure, PublishedTo: JSON.stringify(failure.PublishedTo), LastError: failure.LastError.slice(0, OUTBOX_LAST_ERROR_MAX), ClaimedBy: null, ClaimedUntil: null })
      .where(this.lease.fenced(target(claim.row), claim.owner, claim.epoch));
    return rowsAffected(r) === 1;
  }

  /** Deletes up to `limit` published rows whose PublishedAt is below `before`; answers how many it deleted. */
  public async purgePublished(before: number, limit: number): Promise<number> {
    const ids = await this.purgeCandidates(before, limit);
    if (ids.length === 0) return 0;
    // the WHERE again: a row an operator re-drove since the select stays
    const r = await this.driver
      .del()
      .from(OUTBOX_TABLE)
      .whereIn('Id', ids)
      .where(publishedBefore(before));
    return rowsAffected(r);
  }

  protected async purgeCandidates(before: number, limit: number): Promise<number[]> {
    const rows = await this.driver
      .select<Array<{ Id: number | string }>>()
      .from(OUTBOX_TABLE)
      .columns(['Id'])
      .where(publishedBefore(before))
      .orderBy('Id')
      .take(limit)
      .onPrimary();
    return rows.map((row) => Number(row.Id));
  }
}
