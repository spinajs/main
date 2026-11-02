import { NewInstance } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { OrmDriver } from './driver.js';
import { OrmException } from './exceptions.js';

export const MIGRATION_LOCK_POLL_INTERVAL = 500;
export const MIGRATION_LOCK_TIMEOUT = 30_000;
export const MIGRATION_LOCK_STALE_AFTER = 600_000;

/**
 * How many times one `acquire()` call may remove a lock row it judged stale. A steal is
 * not proof the row is gone - a DELETE can succeed and remove nothing - so without a cap the
 * stale branch is free to warn and retry forever.
 */
export const MIGRATION_LOCK_MAX_STEALS = 3;

/** What one connection's migration lock is asked for. */
export interface IMigrationLockRequest {
  /** `migrationLockKey()` of the connection and its tracking table. */
  readonly key: string;

  /** The lock-table name; read by `TableMigrationLock` only. */
  readonly lockTable: string;

  /** Ms to wait for the lock before throwing. */
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

/**
 * One connection's migration run lock. `OrmDriver.resolve()` registers `TableMigrationLock` as
 * the default; a driver with a native lock registers its own class over this token.
 */
@NewInstance()
export abstract class MigrationLock {
  constructor(protected driver: OrmDriver) {}

  /** Waits up to `request.timeout`, then throws `OrmException`. */
  public abstract acquire(request: IMigrationLockRequest): Promise<IMigrationLockHandle>;

  /** Whether any run holds the lock now. Never takes it: `status()` asks while a run may be going. */
  public abstract isHeld(request: IMigrationLockRequest): Promise<boolean>;
}

/** Server-wide lock name for a connection: two apps with different tracking tables never block each other. */
export function migrationLockKey(driver: OrmDriver, table: string): string {
  return `spinajs_migration:${driver.Options.Database ?? ''}:${table}`;
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
    const owner = this.lockOwner();
    const heartbeat = new TableLockHeartbeat(this.driver, this.Log, request, owner, await this.claim(request, owner));

    return {
      holder: owner,
      assertHeld: async () => heartbeat.assertFresh(),
      release: async () => {
        await heartbeat.stop();
        await this.releaseRow(request);
      },
    };
  }

  /**
   * A row younger than `staleAfter` means somebody is inside a run; an older one means the holder
   * is presumed dead. Freshness rather than mere presence: a process killed mid-migration leaves
   * its lock row behind, so "a row exists" would hide every crash `status()` is meant to surface.
   */
  public async isHeld(request: IMigrationLockRequest): Promise<boolean> {
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
   */
  protected async claim(request: IMigrationLockRequest, owner: string): Promise<Date> {
    const start = Date.now();
    const expired = () => Date.now() - start > request.timeout;
    let steals = 0;

    for (;;) {
      const acquiredAt = new Date();

      try {
        await this.driver.insert().into(request.lockTable).values({ Id: 1, AcquiredAt: acquiredAt, Owner: owner });
        return acquiredAt;
      } catch (err) {
        // deliberately unguarded: a select that dies here means the connection is gone, and that
        // has to surface as itself rather than as a lock timeout thirty seconds later
        const holder = await this.holder(request);

        // capped because a steal is not proof the row is gone: a DELETE can succeed and remove
        // nothing, and the read that follows then finds the same row
        if (holder && Date.now() - holder.since.getTime() > request.staleAfter && steals < MIGRATION_LOCK_MAX_STEALS) {
          steals++;
          await this.steal(request, holder);

          // straight back to the INSERT: sleeping a poll interval for a lock nobody holds is
          // pure latency. Only a deadline already passed falls through to the throw below
          if (!expired()) {
            continue;
          }
        }

        if (expired()) {
          throw this.timedOut(request, holder, steals, err);
        }

        await new Promise((resolve) => setTimeout(resolve, MIGRATION_LOCK_POLL_INTERVAL));
      }
    }
  }

  protected async holder(request: IMigrationLockRequest): Promise<{ owner: string; since: Date } | undefined> {
    const rows = ((await this.driver.select().from(request.lockTable).where({ Id: 1 })) ?? []) as Array<{ AcquiredAt: Date | string; Owner: string }>;
    const row = rows[0];

    return row ? { owner: row.Owner, since: row.AcquiredAt instanceof Date ? row.AcquiredAt : new Date(row.AcquiredAt) } : undefined;
  }

  protected async steal(request: IMigrationLockRequest, holder: { owner: string; since: Date }): Promise<void> {
    // loud, because the alternative reading is a live run that could not refresh its row
    this.Log.warn(
      { connection: this.driver.Options.Name, owner: holder.owner, acquiredAt: holder.since, staleAfter: request.staleAfter },
      'Stealing stale migration lock on connection ${connection}, held by ${owner} since ${acquiredAt} ( older than ${staleAfter}ms ). If that process is still alive, two migration runs are now in flight - raise Migration.Lock.StaleAfter above the longest run.',
    );
    await this.driver.del().from(request.lockTable).where({ Id: 1 });
  }

  protected timedOut(request: IMigrationLockRequest, holder: { owner: string; since: Date } | undefined, steals: number, err: unknown): OrmException {
    const { timeout, lockTable } = request;
    const name = this.driver.Options.Name;

    if (holder) {
      return new OrmException(`Could not acquire migration lock on connection ${name} within ${timeout}ms - held by ${holder.owner} since ${holder.since.toISOString()}${steals > 0 ? `, and ${steals} attempt(s) to remove it as stale left it in place - delete the row from ${lockTable} by hand` : ''}`);
    }

    // no row to blame, so the insert is failing for its own reasons ( missing table, lost
    // connection ). Carrying that message is the only thing that makes this diagnosable
    return new OrmException(`Could not acquire migration lock on connection ${name} within ${timeout}ms - no lock row is present, the last insert failed with: ${(err as Error).message}`, undefined, undefined, undefined, err);
  }

  /**
   * Drops the row unconditionally rather than only the row this process wrote. Deleting only
   * `Owner = ours` leaves the table holding a row nobody clears if the owner string ever changes
   * underneath a run, and losing a stolen lock is the lesser harm: the thief already assumed this
   * run was dead.
   */
  protected async releaseRow(request: IMigrationLockRequest): Promise<void> {
    await this.driver.del().from(request.lockTable).where({ Id: 1 });
  }
}

/**
 * Keeps a held lock row fresh, and judges from the refreshes alone whether it can still be ours.
 *
 * A thief takes the row only once it is older than `staleAfter`. So while the last refresh that
 * went through is younger than that, nobody can have taken it, and `assertFresh()` needs no query.
 * A gap longer than `staleAfter` marks the lock lost for good: a refresh succeeding after a steal
 * matches no row (`Owner` is ours, the row is not) and proves nothing.
 */
class TableLockHeartbeat {
  protected confirmedAt: number;
  protected lost = false;
  protected stopped = false;
  protected timer: NodeJS.Timeout | undefined;
  protected beat: Promise<void> = Promise.resolve();

  constructor(
    protected driver: OrmDriver,
    protected log: Log,
    protected request: IMigrationLockRequest,
    protected owner: string,
    acquiredAt: Date,
  ) {
    this.confirmedAt = acquiredAt.getTime();
    this.schedule();
  }

  public assertFresh(): void {
    this.judge(Date.now());

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
        if (!this.stopped) {
          this.schedule();
        }
      });
    }, Math.max(1, Math.floor(this.request.staleAfter / 3)));

    // a run in progress keeps the process alive through its own I/O; the refresh must not
    this.timer.unref();
  }

  protected async refresh(): Promise<void> {
    const stamp = new Date();

    try {
      await this.driver.update().in(this.request.lockTable).update({ AcquiredAt: stamp }).where({ Id: 1, Owner: this.owner });
      this.judge(stamp.getTime());

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
