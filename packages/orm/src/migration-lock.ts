import { NewInstance } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { OrmDriver } from './driver.js';
import { OrmException } from './exceptions.js';
import type { IUpdateResult } from './interfaces.js';

export const MIGRATION_LOCK_POLL_INTERVAL = 500;
export const MIGRATION_LOCK_TIMEOUT = 30_000;
export const MIGRATION_LOCK_STALE_AFTER = 600_000;

/**
 * How many times one `acquire()` call may remove a lock row it judged stale. A steal is
 * not proof the row is gone - a DELETE can succeed and remove nothing - so without a cap the
 * stale branch is free to warn and retry forever.
 */
export const MIGRATION_LOCK_MAX_STEALS = 3;

/**
 * How often a lock-table row written under an advisory lock is refreshed ( at most; `staleAfter / 3`
 * when shorter ). Another holder of that advisory lock takes such a row over once it has seen it go
 * two of these unrefreshed, which is how long the next run waits after a crash.
 */
export const MIGRATION_LOCK_ADVISORY_HEARTBEAT = 5_000;

/**
 * Ends the `Owner` of a lock-table row written under the advisory lock for `key`
 * ( `TableMigrationLock.acquireUnderAdvisory()` ): `:advisory:` and the first 8 hex chars of
 * sha256(key). The key is part of the mark because one physical table is reached under different
 * keys when two configs spell it differently ( `Schema` unset vs `'public'` ), and a row written
 * under another key's advisory lock may still be live.
 */
export function migrationLockAdvisoryMark(key: string): string {
  return `:advisory:${createHash('sha256').update(key).digest('hex').slice(0, 8)}`;
}

/** What one connection's migration lock is asked for. */
export interface IMigrationLockRequest {
  /** `migrationLockKey()` of the connection and its tracking table. */
  readonly key: string;

  /** The lock-table name; read by `TableMigrationLock` only. */
  readonly lockTable: string;

  /**
   * Ms to wait for the lock before throwing. A row marked under the advisory lock the caller holds
   * may keep it up to `2 * MIGRATION_LOCK_ADVISORY_HEARTBEAT + MIGRATION_LOCK_POLL_INTERVAL` longer
   * ( `TableMigrationLock.acquireUnderAdvisory()` ).
   */
  readonly timeout: number;

  /** Ms after which a table lock counts as abandoned; read by `TableMigrationLock` only. */
  readonly staleAfter: number;
}

/** A held migration lock. */
export interface IMigrationLockHandle {
  /** Who holds it, for messages: `<hostname>:<pid>:<nonce>` or the driver's lock name. */
  readonly holder: string;

  /**
   * Rejects with `MigrationLockLostException` when the lock can no longer be trusted to be held.
   * Called before each migration; any failure to verify must surface as that exception, because
   * anything else is recorded as the failure of the migration about to start.
   */
  assertHeld(): Promise<void>;

  release(): Promise<void>;
}

/** The run lock was lost while held: another run may be migrating the same connection. */
export class MigrationLockLostException extends OrmException {
  constructor(message: string, inner?: unknown) {
    super(message, undefined, undefined, undefined, inner);
  }
}

/** The lock-table row as read: `raw` is `AcquiredAt` as the driver returned it. */
interface LockRow {
  owner: string;
  since: Date;
  raw: Date | string;
}

/** By owner and timestamp: a row its holder refreshed after it was read is a live one, not the one read. */
function lockRowVersion(holder: LockRow): string {
  return `${holder.owner}@${holder.since.getTime()}`;
}

/**
 * One connection's migration run lock. `OrmDriver.resolve()` registers `TableMigrationLock` as
 * the default; a driver with a native lock registers its own class over this token.
 */
@NewInstance()
export abstract class MigrationLock {
  constructor(protected driver: OrmDriver) {}

  /** Waits up to `request.timeout` ( a session lock's marked row: see `TableMigrationLock.acquireUnderAdvisory()` ), then throws `OrmException`. */
  public abstract acquire(request: IMigrationLockRequest): Promise<IMigrationLockHandle>;

  /** Whether any run holds the lock now. Never takes it: `status()` asks while a run may be going. */
  public abstract isHeld(request: IMigrationLockRequest): Promise<boolean>;
}

/**
 * Server-wide lock name for a connection: two apps with different tracking tables never block each
 * other, nor do two connections whose `Options.Schema` gives each its own tracking table.
 */
export function migrationLockKey(driver: OrmDriver, table: string): string {
  return `spinajs_migration:${driver.Options.Database ?? ''}:${(driver.Options.Options as { Schema?: string } | undefined)?.Schema ?? ''}:${table}`;
}

/** Two int32 halves of sha256(key), the shape of a two-argument advisory lock id. */
export function advisoryKeyPair(key: string): [number, number] {
  const hash = createHash('sha256').update(key).digest();
  return [hash.readInt32BE(0), hash.readInt32BE(4)];
}

/**
 * The lock-table row: row `Id = 1` of `<Table>_lock`, claimed by INSERT. Refreshed every
 * `staleAfter / 3` while held, so only the row of a holder that stopped refreshing goes stale.
 */
export class TableMigrationLock extends MigrationLock {
  @Logger('ORM')
  protected Log: Log;

  public async acquire(request: IMigrationLockRequest): Promise<IMigrationLockHandle> {
    return await this.take(request, false);
  }

  /**
   * Takes the row for a dialect lock that already holds the advisory lock for `request.key`, so
   * processes that lock by the row alone ( older releases, `Lock.Mode: 'table'` ) are kept out too.
   * The row is marked with `migrationLockAdvisoryMark(request.key)` and refreshed every
   * `MIGRATION_LOCK_ADVISORY_HEARTBEAT`. A row with that mark is removed once this call has seen it go
   * two heartbeats unrefreshed, whatever its age, any other row only once older than `staleAfter`.
   * For a marked row found unrefreshed at `request.timeout`, the call goes on polling until it has
   * watched that row for two heartbeats and a poll interval, so a timeout shorter than that still
   * takes over a crashed run's row. `release()` drops the row only.
   *
   * Call it only while holding that advisory lock exclusively for this acquisition, on a session of
   * its own: advisory locks are re-entrant per session ( postgres, mysql `GET_LOCK`, mssql
   * `sp_getapplock` with `@LockOwner = 'Session'` ), so a second run on a shared session would
   * remove the first run's live row.
   */
  public async acquireUnderAdvisory(request: IMigrationLockRequest): Promise<IMigrationLockHandle> {
    return await this.take(request, true);
  }

  protected async take(request: IMigrationLockRequest, advisory: boolean): Promise<IMigrationLockHandle> {
    const owner = advisory ? `${this.lockOwner()}${migrationLockAdvisoryMark(request.key)}` : this.lockOwner();
    const every = Math.max(1, Math.floor(request.staleAfter / 3));
    const heartbeat = new TableLockHeartbeat(this.driver, this.Log, request, owner, await this.claim(request, owner, advisory), advisory ? Math.min(every, MIGRATION_LOCK_ADVISORY_HEARTBEAT) : every);

    return {
      holder: owner,
      assertHeld: async () => heartbeat.assertFresh(),
      release: async () => {
        await heartbeat.stop();
        await this.releaseRow(request, owner);
      },
    };
  }

  /**
   * A row younger than `staleAfter` means somebody is inside a run; an older one means the holder
   * is presumed dead. Freshness rather than mere presence: a process killed mid-migration leaves
   * its lock row behind, so "a row exists" would hide every crash `status()` is meant to surface.
   */
  public async isHeld(request: IMigrationLockRequest): Promise<boolean> {
    // a read-only status() must not fail on a database that never ran a migration
    if (!(await this.driver.schema().tableExists(request.lockTable))) {
      return false;
    }

    const rows = ((await this.driver.select().from(request.lockTable).where({ Id: 1 })) ?? []) as Array<{ AcquiredAt: Date | string }>;
    const holder = rows[0];

    if (!holder) {
      return false;
    }

    const acquiredAt = holder.AcquiredAt instanceof Date ? holder.AcquiredAt : new Date(holder.AcquiredAt);

    // NaN from an unreadable timestamp compares false, which reports "not running": a warning an
    // operator can dismiss beats a silence they cannot
    return Date.now() - acquiredAt.getTime() <= request.staleAfter;
  }

  /**
   * Identity written into the lock row. It answers "who is holding this?" when a run blocks, so it
   * has to survive being read on another machine; the nonce tells two runs of one process apart.
   */
  protected lockOwner(): string {
    return `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  }

  /**
   * Takes the row, waiting for whoever has it, and returns the `AcquiredAt` it wrote.
   *
   * The row is claimed by INSERT rather than by "SELECT then INSERT": `Id` is unique, so the
   * database decides the winner in one statement. A refused insert is read as "somebody else holds
   * it", which is also why the holder is re-read afterwards rather than guessed at.
   *
   * Staleness is judged against the *client* clock: `AcquiredAt` is written as `new Date()` and
   * compared to this host's `Date.now()`. On hosts whose clocks disagree the window is off by the
   * skew, which shows up as stealing too early or waiting too long.
   *
   * A row marked under the advisory lock this call holds is different: its writer lost that lock, by
   * crashing or by the server ending its session while it may still be migrating. Only the first
   * stops refreshing, so the row is taken over once it has stayed unchanged for two advisory
   * heartbeats, timed here rather than by `AcquiredAt`, which no clock skew can shorten. Its age is
   * not judged at all: a caller with a `staleAfter` below the heartbeat, or a clock running ahead,
   * would read a refreshed row as stale.
   */
  protected async claim(request: IMigrationLockRequest, owner: string, advisory = false): Promise<Date> {
    // the wait is timed monotonically: a step of the wall clock must not shorten it into taking over a live holder's row
    const start = performance.now();
    const waited = () => Math.round(performance.now() - start);
    const expired = () => waited() > request.timeout;
    const stale = (holder: LockRow | undefined) => !!holder && Date.now() - holder.since.getTime() > request.staleAfter;
    const watch = new MarkedRowWatch((holder) => advisory && holder.owner.endsWith(migrationLockAdvisoryMark(request.key)));
    const stolen = new Set<string>();
    let steals = 0;
    const stealsOf = (holder: LockRow | undefined) => (holder && stolen.has(lockRowVersion(holder)) ? steals : 0);

    for (;;) {
      const acquiredAt = new Date();

      try {
        await this.driver.insert().into(request.lockTable).values({ Id: 1, AcquiredAt: acquiredAt, Owner: owner });
        return acquiredAt;
      } catch (err) {
        // deliberately unguarded: a select that dies here means the connection is gone, and that
        // has to surface as itself rather than as a lock timeout thirty seconds later
        const holder = await this.holder(request);

        const watching = watch.see(holder);
        const abandoned = watching ? watching.quiet() : stale(holder);

        // capped because a steal is not proof the row is gone: a DELETE can succeed and remove
        // nothing, and the read that follows then finds the same row
        if (holder && abandoned && steals < MIGRATION_LOCK_MAX_STEALS) {
          steals++;
          stolen.add(lockRowVersion(holder));
          await this.steal(request, holder, advisory);

          // straight back to the INSERT: sleeping a poll interval for a lock nobody holds is
          // pure latency. Only a deadline already passed falls through to the throw below, unless
          // the row removed is a marked one: its wait is the one that may run past the deadline
          if (!expired() || watching) {
            continue;
          }
        }

        if (expired() && !watching?.waitPastDeadline()) {
          throw this.timedOut(request, holder, stealsOf(holder), err, waited(), watching);
        }

        await new Promise((resolve) => setTimeout(resolve, MIGRATION_LOCK_POLL_INTERVAL));
      }
    }
  }

  protected async holder(request: IMigrationLockRequest): Promise<{ owner: string; since: Date; raw: Date | string } | undefined> {
    const rows = ((await this.driver.select().from(request.lockTable).where({ Id: 1 })) ?? []) as Array<{ AcquiredAt: Date | string; Owner: string }>;
    const row = rows[0];

    return row ? { owner: row.Owner, since: row.AcquiredAt instanceof Date ? row.AcquiredAt : new Date(row.AcquiredAt), raw: row.AcquiredAt } : undefined;
  }

  /**
   * Deletes only the row that was judged, by `Owner` and `AcquiredAt`: another contender may already
   * have replaced it with its own, or its holder refreshed it after it was read. `AcquiredAt` is bound
   * as read, because a parsed copy of a value in another text format ( SpinaJS 2.x wrote local time )
   * would match no row.
   */
  protected async steal(request: IMigrationLockRequest, holder: { owner: string; since: Date; raw: Date | string }, advisory = false): Promise<void> {
    if (advisory && holder.owner.endsWith(migrationLockAdvisoryMark(request.key))) {
      this.Log.warn(
        { connection: this.driver.Options.Name, owner: holder.owner, acquiredAt: holder.since },
        'Removing the migration lock row of ${owner} on connection ${connection} ( last refreshed at ${acquiredAt} ): it was written under the advisory lock this run now holds and has stopped being refreshed, so its writer is gone.',
      );
    } else {
      // loud, because the alternative reading is a live run that could not refresh its row
      this.Log.warn(
        { connection: this.driver.Options.Name, owner: holder.owner, acquiredAt: holder.since, staleAfter: request.staleAfter },
        'Stealing stale migration lock on connection ${connection}, held by ${owner} since ${acquiredAt} ( older than ${staleAfter}ms ). If that process is still alive, two migration runs are now in flight - raise Migration.Lock.StaleAfter above the longest run.',
      );
    }

    // an unreadable timestamp cannot be matched back; only the marked-row branch gets here with one
    const where = Number.isNaN(holder.since.getTime()) ? { Id: 1, Owner: holder.owner } : { Id: 1, Owner: holder.owner, AcquiredAt: holder.raw };
    await this.driver.del().from(request.lockTable).where(where);
  }

  /** `watched`: how long this call has seen a row marked with its own key unchanged, and whether its owner was seen refreshing it. */
  protected timedOut(request: IMigrationLockRequest, holder: { owner: string; since: Date; raw: Date | string } | undefined, steals: number, err: unknown, waited: number, watched?: { watchedFor: () => number; refreshed: boolean }): OrmException {
    const { lockTable } = request;
    // a marked row is watched past the timeout, so the wait can exceed it by more than a poll
    const budget = waited > request.timeout + 2 * MIGRATION_LOCK_POLL_INTERVAL ? `${request.timeout}ms ( waited ${waited}ms )` : `${request.timeout}ms`;
    const name = this.driver.Options.Name;

    if (holder && Number.isNaN(holder.since.getTime())) {
      return new OrmException(`Could not acquire migration lock on connection ${name} within ${budget} - held by ${holder.owner}, and its AcquiredAt in ${lockTable} ( ${JSON.stringify(holder.raw)} ) is not a date, so it cannot be judged stale - delete the row from ${lockTable} by hand`);
    }

    if (holder && steals > 0) {
      return new OrmException(`Could not acquire migration lock on connection ${name} within ${budget} - held by ${holder.owner} since ${holder.since.toISOString()}, and ${steals} attempt(s) to remove it as stale left it in place - delete the row from ${lockTable} by hand`);
    }

    if (holder && watched?.refreshed) {
      return new OrmException(
        `Could not acquire migration lock on connection ${name} within ${budget} - held by ${holder.owner}, last refreshed at ${holder.since.toISOString()}: that run lost the advisory lock this run now holds but is still refreshing its row, so it may still be migrating. It stops before its next migration; the row is taken over once it goes ${2 * MIGRATION_LOCK_ADVISORY_HEARTBEAT}ms unrefreshed`,
      );
    }

    if (holder && watched) {
      return new OrmException(
        `Could not acquire migration lock on connection ${name} within ${budget} - held by ${holder.owner}, last refreshed at ${holder.since.toISOString()}: that run lost the advisory lock this run now holds, and this run watched for only ${watched.watchedFor()}ms without seeing its row refreshed, and the row of a different run replaced it after Lock.Timeout, too short to tell a crashed run from a live one. The next run takes the row over once it goes ${2 * MIGRATION_LOCK_ADVISORY_HEARTBEAT}ms unrefreshed`,
      );
    }

    if (holder) {
      const staleAt = new Date(holder.since.getTime() + request.staleAfter).toISOString();
      return new OrmException(`Could not acquire migration lock on connection ${name} within ${budget} - held by ${holder.owner} since ${holder.since.toISOString()}. If that process is dead, the row goes stale at ${staleAt} ( Migration.Lock.StaleAfter ) and the next run takes it; to go on sooner, delete it from ${lockTable} by hand`);
    }

    // no row to blame, so the insert is failing for its own reasons ( missing table, lost
    // connection ). Carrying that message is the only thing that makes this diagnosable
    return new OrmException(`Could not acquire migration lock on connection ${name} within ${budget} - no lock row is present, the last insert failed with: ${(err as Error).message}`, undefined, undefined, undefined, err);
  }

  /** Only our own row: after a steal the row belongs to the run that took it over. */
  protected async releaseRow(request: IMigrationLockRequest, owner: string): Promise<void> {
    await this.driver.del().from(request.lockTable).where({ Id: 1, Owner: owner });
  }
}

/**
 * What one `claim()` has seen of a lock row marked with its own advisory key: since when the row is
 * unchanged, and whether its owner was seen refreshing it.
 */
class MarkedRowWatch {
  public since = 0;
  public refreshed = false;
  protected first: number | undefined;
  protected row: string | undefined;
  protected owner: string | undefined;
  protected overtime: string | undefined;

  constructor(protected marked: (holder: LockRow) => boolean) {}

  /** Records the row as read now; undefined when there is none or it is not marked. */
  public see(holder: LockRow | undefined): this | undefined {
    if (!holder || !this.marked(holder)) {
      return undefined;
    }

    if (lockRowVersion(holder) !== this.row) {
      this.refreshed = holder.owner === this.owner;
      this.row = lockRowVersion(holder);
      this.owner = holder.owner;
      this.since = performance.now();
      this.first ??= this.since;
    }

    return this;
  }

  public quiet(): boolean {
    return performance.now() - this.since >= 2 * MIGRATION_LOCK_ADVISORY_HEARTBEAT;
  }

  /** How long since this call first saw a row marked with its key, whichever row it was since. */
  public watchedFor(): number {
    return Math.round(performance.now() - (this.first ?? performance.now()));
  }

  /**
   * Whether to go on polling past the deadline. Each run watches from scratch, so with a timeout below
   * the quiet window a crashed run's row would outlive every run until `staleAfter`. Only the row seen
   * at the deadline is waited for, and only while it stays unchanged, which bounds the overrun.
   */
  public waitPastDeadline(): boolean {
    this.overtime ??= this.row;
    return this.inOvertime() && performance.now() - this.since < 2 * MIGRATION_LOCK_ADVISORY_HEARTBEAT + MIGRATION_LOCK_POLL_INTERVAL;
  }

  public inOvertime(): boolean {
    return this.row === this.overtime;
  }
}

/**
 * Keeps a held lock row fresh, and judges from the refreshes alone whether it can still be ours.
 *
 * A thief takes the row only once it is older than `staleAfter`, and deletes it only while it still
 * carries the `AcquiredAt` it judged. So while the last refresh that went through is younger than
 * that, nobody can have taken it, and `assertFresh()` needs no query. A refresh that returns more
 * than `staleAfter` after the previous one marks the lock lost for good, because a thief may have
 * read the row as stale before it landed; so does a refresh that matches no row.
 *
 * A row marked under an advisory lock is taken sooner, once it goes two advisory heartbeats
 * unrefreshed. By then its holder has lost that advisory lock, which the dialect lock's
 * `assertHeld()` checks before this one.
 */
class TableLockHeartbeat {
  protected confirmedAt: number;
  protected lost = false;
  protected taken = false;
  protected stopped = false;
  protected timer: NodeJS.Timeout | undefined;
  protected beat: Promise<void> = Promise.resolve();

  constructor(
    protected driver: OrmDriver,
    protected log: Log,
    protected request: IMigrationLockRequest,
    protected owner: string,
    acquiredAt: Date,
    protected every: number,
  ) {
    this.confirmedAt = acquiredAt.getTime();
    this.schedule();
  }

  public assertFresh(): void {
    this.judge(Date.now());

    if (this.taken) {
      throw new MigrationLockLostException(
        `Migration lock on connection ${this.driver.Options.Name} was lost: its row in ${this.request.lockTable} no longer carries this run's owner ( ${this.owner} ), so another run has taken it. The run stops before its next migration; run it again.`,
      );
    }

    if (this.lost) {
      throw new MigrationLockLostException(
        `Migration lock on connection ${this.driver.Options.Name} was lost: its row in ${this.request.lockTable} was last refreshed at ${new Date(this.confirmedAt).toISOString()}, longer ago than Migration.Lock.StaleAfter ( ${this.request.staleAfter}ms ), so another run may have taken it. The run stops before its next migration; run it again.`,
      );
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.beat;
  }

  protected judge(now: number): void {
    if (now - this.confirmedAt > this.request.staleAfter) {
      this.lost = true;
    }
  }

  protected schedule(): void {
    this.timer = setTimeout(() => {
      this.beat = this.refresh().finally(() => {
        if (!this.stopped && !this.taken) {
          this.schedule();
        }
      });
    }, this.every);

    // a run in progress keeps the process alive through its own I/O; the refresh must not
    this.timer.unref();
  }

  protected async refresh(): Promise<void> {
    const stamp = new Date();

    try {
      const result = (await this.driver.update().in(this.request.lockTable).update({ AcquiredAt: stamp }).where({ Id: 1, Owner: this.owner })) as IUpdateResult | undefined;

      // matched rows, not changed ones ( mysql2 sets FOUND_ROWS by default ); a driver reporting no count proves nothing
      if (result?.RowsAffected === 0) {
        this.lost = this.taken = true;
        return;
      }

      // the time the UPDATE returned, not the stamp: a refresh held back past staleAfter landed after
      // a thief could already read the row as stale
      this.judge(Date.now());

      if (!this.lost) {
        this.confirmedAt = stamp.getTime();
      }
    } catch (err) {
      this.log.warn(
        { error: err, connection: this.driver.Options.Name, lockTable: this.request.lockTable, staleAfter: this.request.staleAfter },
        'Could not refresh the migration lock on connection ${connection} ( ${lockTable} ). If refreshing keeps failing for ${staleAfter}ms the row goes stale, another run may take it, and this run stops before its next migration.',
      );
    }
  }
}
