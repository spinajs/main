import type { IUpdateResult, IWhereBuilder, OrmDriver } from '@spinajs/orm';
import { onPrimary } from './sql.js';

export interface RowLeaseColumns {
  owner: string;
  until: string;
  epoch: string;
}

export interface RowLeaseTarget {
  table: string;
  key: Record<string, string | number>;
}

const DEFAULT_COLUMNS: RowLeaseColumns = { owner: 'ClaimedBy', until: 'ClaimedUntil', epoch: 'ClaimEpoch' };

const affected = (r: unknown) => (r as IUpdateResult | undefined)?.RowsAffected ?? 0;

function whereEquals(builder: IWhereBuilder<unknown>, conditions: Record<string, unknown>): void {
  for (const [column, value] of Object.entries(conditions)) {
    if (value === null) builder.whereNull(column);
    else builder.where(column, value);
  }
}

/**
 * A lease on one row, fenced by an epoch: every claim increments it, so writes guarded by
 * `fenced()` stop matching once another owner has taken the row over.
 *
 * Every write is a conditional UPDATE whose affected-row count says whether this owner won; that count
 * must mean "rows matched" (see the scheduler's LeaseStore on MySQL found rows). The epoch column
 * must be NOT NULL (default 0).
 */
export class RowLease {
  constructor(
    protected readonly driver: OrmDriver,
    protected readonly columns: RowLeaseColumns = DEFAULT_COLUMNS,
  ) {}

  /** Claims a free row (no owner, or `until < now`); `extraWhere` adds equality conditions (`null` means IS NULL). */
  public async claim(target: RowLeaseTarget, owner: string, ttlMs: number, now: number, extraWhere: Record<string, unknown> = {}): Promise<{ epoch: number } | null> {
    const c = this.columns;
    const rows = (await onPrimary(this.driver.select().from(target.table).columns([c.epoch]).where(target.key))) as Array<Record<string, unknown>>;
    if (rows.length !== 1) return null;
    const observed = Number(rows[0][c.epoch]);

    // Compare-and-set on the observed epoch rather than increment-then-read-back: a read after the UPDATE can
    // see a later claim by the same owner string (a replica id) and hand both callers one epoch. A stale
    // observation only makes this claim lose.
    const r = await this.driver
      .update()
      .in(target.table)
      .update({ [c.owner]: owner, [c.until]: now + ttlMs, [c.epoch]: observed + 1 })
      .where(function (this: IWhereBuilder<unknown>) {
        whereEquals(this, { ...extraWhere, ...target.key, [c.epoch]: observed });
      })
      .where(function (this: IWhereBuilder<unknown>) {
        this.whereNull(c.owner).orWhere(c.until, '<', now);
      });
    return affected(r) === 1 ? { epoch: observed + 1 } : null;
  }

  public async renew(target: RowLeaseTarget, owner: string, epoch: number, ttlMs: number, now: number): Promise<boolean> {
    const r = await this.driver
      .update()
      .in(target.table)
      .update({ [this.columns.until]: now + ttlMs })
      .where(this.fenced(target, owner, epoch));
    return affected(r) === 1;
  }

  /** Clears the owner and the expiry; the epoch is kept, so the next claim still moves past it. */
  public async release(target: RowLeaseTarget, owner: string, epoch: number): Promise<boolean> {
    const r = await this.driver
      .update()
      .in(target.table)
      .update({ [this.columns.owner]: null, [this.columns.until]: null })
      .where(this.fenced(target, owner, epoch));
    return affected(r) === 1;
  }

  /** Equality conditions for a write that must commit only while `owner` holds `epoch`. */
  public fenced(target: RowLeaseTarget, owner: string, epoch: number): Record<string, unknown> {
    return { ...target.key, [this.columns.owner]: owner, [this.columns.epoch]: epoch };
  }
}
