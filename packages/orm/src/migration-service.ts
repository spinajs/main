import { NewInstance, Class } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { DateTime } from 'luxon';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import type { TableQueryBuilder } from './builders.js';
import { OrmDriver } from './driver.js';
import { MigrationTransactionMode, OrmMigration } from './interfaces.js';
import { OrmException } from './exceptions.js';

export const MIGRATION_TABLE_NAME = 'spinajs_migration';
export const MIGRATION_LOCK_POLL_INTERVAL = 500;
export const MIGRATION_LOCK_TIMEOUT = 30_000;
export const MIGRATION_LOCK_STALE_AFTER = 600_000;

/**
 * How many times one `acquireLock()` call may remove a lock row it judged stale. A steal is
 * not proof the row is gone - a DELETE can succeed and remove nothing - so without a cap the
 * stale branch is free to warn and retry forever.
 */
export const MIGRATION_LOCK_MAX_STEALS = 3;

export type MigrationResolveAction = 'applied' | 'rolled-back';

/**
 * One row of the migration tracking table.
 */
export interface IMigrationRecord {
  Migration: string;
  CreatedAt: Date;
  StartedAt: Date;
  FinishedAt: Date | null;
  RolledBackAt: Date | null;
  Logs: string | null;
  Checksum: string | null;
  Batch: number;
}

/**
 * A migration class paired with the timestamp parsed out of its name.
 */
export interface IMigrationUnit {
  name: string;
  created: DateTime;
  type: Class<OrmMigration>;
}

export interface IMigrationRunOptions {
  /**
   * Record the migration as applied without running its `up()`.
   */
  fake?: boolean;
}

export interface IMigrationDownOptions extends IMigrationRunOptions {
  /**
   * Roll every applied migration back instead of only the last batch.
   */
  all?: boolean;
}

export interface IMigrationStatusEntry {
  name: string;
  connection: string;
  applied: boolean;
  failed: boolean;
  rolledBack: boolean;
  pending: boolean;

  /**
   * The row was opened by a run that never reached either outcome: `StartedAt` is set while both
   * `FinishedAt` and `Logs` are NULL, and no run is currently holding the migration lock. A
   * process killed between the start and the outcome ( OOM, SIGKILL, a lost connection that took
   * the failure write down with it ) leaves exactly this.
   *
   * Orthogonal to `pending`, like `rolledBack`: such a migration IS pending and the next `up()`
   * WILL re-run it from the top. What the flag adds is that nobody knows how much of it already
   * reached the database. It never blocks a run - see `warnOnInterrupted` for why.
   */
  interrupted: boolean;

  batch: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  checksumMismatch: boolean;
}

/**
 * Fingerprint of a migration's source, used to detect a migration that was edited
 * after it had already been applied.
 */
export function migrationChecksum(type: Class<OrmMigration>): string {
  return createHash('sha256').update(type.toString()).digest('hex');
}

/**
 * Per-connection migration execution contract. Configure an alternative
 * implementation with db.Connections[n].Migration.Service (DI token).
 */
@NewInstance()
export abstract class OrmMigrationService {
  constructor(protected driver: OrmDriver) {}

  /**
   * Creates or upgrades the tracking tables this connection needs.
   *
   * NOTE on what is NOT here: `applied()`. It was part of this contract and had no production
   * caller - `status()` answers "what is applied", per unit and per connection, and is what the
   * runner, the CLI and every deploy gate go through. An abstract method that every custom
   * implementation must write and nothing ever calls is a tax with no payer, so it is a concrete
   * helper on `DefaultMigrationService` instead.
   */
  public abstract ensureStorage(): Promise<void>;

  public abstract up(units: IMigrationUnit[], options?: IMigrationRunOptions): Promise<OrmMigration[]>;
  public abstract down(units: IMigrationUnit[], options?: IMigrationDownOptions): Promise<OrmMigration[]>;
  public abstract status(units: IMigrationUnit[]): Promise<IMigrationStatusEntry[]>;

  /**
   * Forces a migration's recorded state without running it - the escape hatch for a
   * run that died halfway and left the table lying.
   *
   * `unit` is optional so callers that only know a name (the CLI, the runner facade) keep
   * working; passing it lets an `'applied'` resolution stamp the checksum as a real run would.
   */
  public abstract resolve(name: string, action: MigrationResolveAction, unit?: IMigrationUnit): Promise<void>;
}

export class DefaultMigrationService extends OrmMigrationService {
  @Logger('ORM')
  protected Log: Log;

  protected get table(): string {
    return this.driver.Options.Migration?.Table ?? MIGRATION_TABLE_NAME;
  }

  protected get lockTable(): string {
    return `${this.table}_lock`;
  }

  /**
   * Creates `name` unless it is already there, tolerating a second process that creates it in
   * the window between the probe and the CREATE.
   *
   * That window cannot be closed with a lock: the lock table is one of the tables being created
   * here, so it cannot guard its own creation. Two processes booting together therefore both see
   * "absent" and both issue a CREATE, and the loser must not take the whole boot down with it.
   * Only a table that really is present afterwards excuses the failure - anything else ( no
   * permission, bad DDL, dead connection ) is a genuine error and is rethrown.
   *
   * Returns true when the table was *absent at probe time* - which is not the same as "this
   * process created it", since the lost-race path returns true too. Callers use it to skip the
   * legacy upgrade path: a table that appeared inside the race window was created by a peer
   * running this same DDL, so it already carries the current shape.
   */
  protected async createTableIfAbsent(name: string, columns: (t: TableQueryBuilder) => void): Promise<boolean> {
    // a builder executes at most once, so every statement needs a fresh SchemaQueryBuilder
    //
    // The probe deliberately passes NO database: a migration table always lives wherever an
    // unqualified CREATE TABLE on this connection lands, and the drivers disagree about what a
    // second argument means there. MySQL treats it as the database (== schema, and defaulting to
    // the connection's own is identical); postgres treats it as a SCHEMA — so passing
    // `Options.Database` ('galaxy') probed `table_schema = 'galaxy'` while the table sat in
    // `public`, the guard reported "absent" forever, and every startup after the first crashed on
    // the CREATE collision.

    if (await this.driver.schema().tableExists(name)) {
      return false;
    }

    try {
      await this.driver.schema().createTable(name, columns);
    } catch (err) {
      if (!(await this.driver.schema().tableExists(name))) {
        throw new OrmException(`Could not create migration table ${name} on connection ${this.driver.Options.Name}: ${(err as Error).message}`, undefined, undefined, undefined, err);
      }

      this.Log.trace(`Migration table ${name} on connection ${this.driver.Options.Name} was created concurrently by another process - continuing`);
    }

    return true;
  }

  public async ensureStorage(): Promise<void> {
    // a builder executes at most once, so every statement needs a fresh SchemaQueryBuilder
    const schema = () => this.driver.schema();

    // "was absent when we probed", not "we created it" - a lost race reports absent too
    const wasAbsent = await this.createTableIfAbsent(this.table, (t) => {
      t.string('Migration').unique().notNull();
      t.dateTime('CreatedAt').notNull();
      t.dateTime('StartedAt').notNull();
      t.dateTime('FinishedAt');
      t.dateTime('RolledBackAt');
      t.text('Logs');
      t.string('Checksum', 64);
      t.int('Batch').notNull().default().value(1);
    });

    if (!wasAbsent) {
      // Same unqualified-probe rule as createTableIfAbsent: the connection's own scope, no db arg.
      const cols = (await this.driver.tableInfo(this.table)) ?? [];
      const has = (n: string) => cols.some((c) => c.Name === n);

      if (!has('StartedAt') || !has('FinishedAt') || !has('RolledBackAt') || !has('Logs') || !has('Checksum') || !has('Batch')) {
        await schema().alterTable(this.table, (t) => {
          if (!has('StartedAt')) t.dateTime('StartedAt').addColumn();
          if (!has('FinishedAt')) t.dateTime('FinishedAt').addColumn();
          if (!has('RolledBackAt')) t.dateTime('RolledBackAt').addColumn();
          if (!has('Logs')) t.text('Logs').addColumn();
          if (!has('Checksum')) t.string('Checksum', 64).addColumn();
          if (!has('Batch')) {
            // added nullable and backfilled below - a NOT NULL column cannot be bolted
            // onto a table that already has rows
            const batch = t.int('Batch');
            batch.default().value(1);
            batch.addColumn();
          }
        });

        await this.backfillLegacyRows();
      }
    }

    await this.createTableIfAbsent(this.lockTable, (t) => {
      t.int('Id').unique().notNull();
      t.dateTime('AcquiredAt').notNull();
      t.string('Owner', 255).notNull();
    });
  }

  protected async records(): Promise<IMigrationRecord[]> {
    return ((await this.driver.select().from(this.table)) ?? []) as IMigrationRecord[];
  }

  /**
   * Fills the columns the upgrade above has just added. A row written before they existed carries
   * nothing but `CreatedAt`, and a NULL `FinishedAt` reads as "never applied" - so without this
   * every migration the deployment ran years ago would run again over a schema that already has
   * it. `CreatedAt` is the only timestamp such a row has, so it is treated as both start and
   * finish.
   *
   * Row by row through the update builder rather than as three set-based `UPDATE`s, and that is
   * the point of the method: a set-based statement has to name the table itself, and the only
   * way to do that here is raw SQL. `Migration.Table` is configuration - a name that needs
   * quoting ( a reserved word, a dot, a space ) would then break this path alone, and only on a
   * deployment that already has rows, which is the least reachable corner in the file. The
   * builder quotes it exactly as every other statement in this class does. The cost is one UPDATE
   * per legacy row, on the single boot that performs the upgrade and never again.
   */
  protected async backfillLegacyRows(): Promise<void> {
    for (const r of await this.records()) {
      const patch: Partial<IMigrationRecord> = {};

      // `== null` on purpose - the column is either absent from the row object ( undefined ) or
      // present and NULL, depending on how the driver hydrates a freshly added column
      if (r.StartedAt == null) {
        patch.StartedAt = r.CreatedAt;
      }

      // `Logs` set with a NULL `FinishedAt` is the FAILED state. It cannot occur on a table this
      // old - there was no Logs column to write - but stamping a finish over one would silently
      // unblock a half-applied migration, so the guard is stated rather than assumed away.
      if (r.FinishedAt == null && !r.Logs) {
        patch.FinishedAt = r.CreatedAt;
      }

      if (r.Batch == null) {
        patch.Batch = 1;
      }

      if (Object.keys(patch).length === 0) {
        continue;
      }

      await this.driver.update().in(this.table).update(patch).where({ Migration: r.Migration });
    }
  }

  /**
   * Migrations that finished successfully and were not rolled back - the raw rows, unmerged with
   * the registry.
   *
   * A convenience on this class rather than part of `OrmMigrationService`: nothing in the ORM,
   * the runner or the CLI calls it, because they all need the registry merged in and go through
   * `status()`. It is kept because a subclass, a script or a health check reaching for "what does
   * this connection think it has applied?" should not have to reimplement the applied-gate, and
   * getting that gate subtly wrong ( "a row exists" rather than the FinishedAt NOT NULL and
   * RolledBackAt NULL pair ) is the classic way to re-run a migration.
   */
  public async applied(): Promise<IMigrationRecord[]> {
    return (await this.records()).filter((r) => r.FinishedAt !== null && r.FinishedAt !== undefined && !r.RolledBackAt);
  }

  /**
   * Opens a migration's row: a fresh one, or a reset of whatever a previous failed or
   * rolled-back attempt left behind.
   */
  protected async upsertStart(name: string, existing: IMigrationRecord | undefined): Promise<void> {
    const now = new Date();

    if (existing) {
      await this.driver.update().in(this.table).update({ StartedAt: now, FinishedAt: null, RolledBackAt: null, Logs: null }).where({ Migration: name });
    } else {
      await this.driver.insert().into(this.table).values({ Migration: name, CreatedAt: now, StartedAt: now, FinishedAt: null, RolledBackAt: null, Logs: null, Checksum: null, Batch: 0 });
    }
  }

  /**
   * Closes a migration's row as applied. The batch number is stamped here rather than at
   * insert time, so a row that never finishes carries no batch to be rolled back later.
   */
  protected async markFinished(name: string, batch: number, checksum: string): Promise<void> {
    await this.driver.update().in(this.table).update({ FinishedAt: new Date(), Batch: batch, Checksum: checksum }).where({ Migration: name });
  }

  /**
   * Records why a migration died. Failed state is `FinishedAt` NULL *and* `Logs` set - the pair
   * `assertNoFailed` matches on - so this write establishes both rather than assuming the row
   * already carries a NULL `FinishedAt`.
   *
   * It cannot assume it: a migration that was applied and later rolled back is pending again
   * while still holding the old `FinishedAt`/`RolledBackAt` timestamps, and the reset
   * `upsertStart` issued for the retry is inside the transaction that just unwound. Writing only
   * `Logs` would leave `FinishedAt` set, and a half-applied migration would slip past the block.
   */
  protected async markFailed(name: string, err: Error): Promise<void> {
    await this.driver
      .update()
      .in(this.table)
      .update({ Logs: `${err.message}\n${err.stack ?? ''}`, FinishedAt: null, RolledBackAt: null })
      .where({ Migration: name });
  }

  /**
   * A half-applied migration means the database is in a state nobody described. Refuse to
   * pile more schema changes on top of it.
   */
  protected assertNoFailed(records: IMigrationRecord[]): void {
    const failed = records.find((r) => !r.FinishedAt && r.Logs);

    if (failed) {
      throw new OrmException(
        `Migration ${failed.Migration} on connection ${this.driver.Options.Name} failed previously and blocks migration runs. Inspect Logs column, fix the database manually, then run orm.Migration.resolve('${failed.Migration}', 'applied') or ('rolled-back'). That call reaches registered migrations only - if this one's class is gone, remove its row from ${this.table} by hand instead.`,
      );
    }
  }

  /**
   * The shape of a row whose run never reached an outcome: `StartedAt`, written by `upsertStart`,
   * and neither of the two writes that close it - `markFinished`'s `FinishedAt` or `markFailed`'s
   * `Logs`. Nothing in this class produces it deliberately; a process killed between the start and
   * the outcome does.
   *
   * `RolledBackAt` is excluded on purpose. `resolve('rolled-back')` also leaves `FinishedAt` and
   * `Logs` NULL with `StartedAt` set, and that row is pending because somebody said so - not
   * abandoned.
   *
   * The predicate says nothing about how much of the migration reached the database. It says only
   * that nobody recorded the answer, which is exactly why it is worth surfacing.
   */
  protected isInterrupted(rec: IMigrationRecord): boolean {
    return !!rec.StartedAt && !rec.FinishedAt && !rec.Logs && !rec.RolledBackAt;
  }

  /**
   * Is a migration run in flight on this connection right now? Read, never acquired: the caller is
   * `status()`, which must not block behind the run it is reporting on.
   *
   * The lock row is the only honest signal available, and it is judged exactly as `acquireLock`
   * judges it - a row younger than `StaleAfter` means somebody is inside a run, an older one means
   * the holder is presumed dead. Freshness rather than mere presence is what makes this usable
   * here: a process killed mid-migration leaves BOTH its open tracking row and its lock row
   * behind, so "a lock row exists" would hide every crash this is meant to surface, permanently.
   *
   * Two deliberate consequences. For `StaleAfter` after a crash the answer is "running" and the
   * open row is not yet reported as interrupted - the same window in which `acquireLock` still
   * waits for the holder, and with the same client-clock caveat documented there. And
   * `Lock.Enabled: false` removes the signal altogether, so the answer is "not running": an open
   * row then always reads as interrupted, which is right for the crash and wrong only for a report
   * taken while a run is genuinely in progress.
   */
  protected async runInProgress(): Promise<boolean> {
    const { enabled, staleAfter } = this.lockOptions();

    if (!enabled) {
      return false;
    }

    const rows = ((await this.driver.select().from(this.lockTable).where({ Id: 1 })) ?? []) as Array<{ AcquiredAt: Date | string }>;
    const holder = rows[0];

    if (!holder) {
      return false;
    }

    const acquiredAt = holder.AcquiredAt instanceof Date ? holder.AcquiredAt : new Date(holder.AcquiredAt);

    // NaN from an unreadable timestamp compares false, which reports "not running" - the same
    // bias as everywhere else here: a warning an operator can dismiss beats a silence they cannot
    return Date.now() - acquiredAt.getTime() <= staleAfter;
  }

  /**
   * Warns about every migration this run is about to re-run whose row says a previous attempt was
   * started and never closed. No lock check is needed here, unlike in `status()`: this runs inside
   * `withLock`, so the only run in flight on this connection is this one.
   *
   * It warns rather than blocks, and that is a judgement call worth stating. The row records that
   * a run STARTED, not that anything reached the database, so blocking would escalate "unknown" to
   * "refuse to migrate" - and it would do so for the common, harmless shapes too: an idempotent
   * `CREATE TABLE` that had not run yet, or any migration on a `PerMigration` / `PerRun`
   * connection, whose transaction unwound the partial work when the process died. In those cases
   * re-running from the top is exactly right, and a block would turn every OOM kill during a long
   * migration into an operator ticket.
   *
   * The case that is genuinely dangerous is `Transaction.Mode: None` ( the default ) plus
   * non-idempotent DML: half the INSERTs are already in, nothing recorded which half, and the
   * re-run applies them again. Non-idempotent DDL is the recoverable version of the same thing -
   * it fails, and the failed row then blocks properly. Neither is detectable from here, so the
   * warning describes them and leaves the decision with the operator, who is also the only party
   * that can look at the data.
   */
  protected warnOnInterrupted(records: IMigrationRecord[], pending: IMigrationUnit[]): void {
    for (const u of pending) {
      const rec = records.find((r) => r.Migration === u.name);

      if (!rec || !this.isInterrupted(rec)) {
        continue;
      }

      // rendered without `new Date(...)`: a dialect that hands timestamps back as strings would
      // make that an Invalid Date on some formats, and `toISOString()` on one THROWS - out of a
      // warning, which would replace the diagnosis with a crash
      const started = rec.StartedAt instanceof Date ? rec.StartedAt.toISOString() : String(rec.StartedAt);

      this.Log.warn(`Migration ${u.name} on connection ${this.driver.Options.Name} was STARTED and never finished - its tracking row carries StartedAt with neither FinishedAt nor Logs, so the process running it was killed mid-migration ( started ${started} ). It is being RE-RUN from the top and nothing recorded how far the first attempt got. Under Migration.Transaction.Mode None ( the default ) whatever it had already applied is still in the database: non-idempotent DDL will fail and land in the failed state, non-idempotent data changes will be applied a second time and nothing will say so. Check what the first attempt left behind, or record the truth with orm.Migration.resolve('${u.name}', 'applied') or ('rolled-back') before running again.`);
    }
  }

  protected transactionMode(): MigrationTransactionMode {
    return this.driver.Options.Migration?.Transaction?.Mode ?? MigrationTransactionMode.None;
  }

  /**
   * True when this migration must run outside any wrapping transaction ( TypeORM parity:
   * `public transaction = false` on the migration class - needed for DDL that cannot be
   * transacted, such as MySQL index rebuilds ).
   *
   * That declaration is an *instance* field, assigned in the constructor, so it never reaches
   * the prototype - the resolved instance is the only place it can be read from. A prototype
   * getter or a static property is honoured too, so a migration may also opt out without
   * being constructed.
   */
  protected optedOutOfTransaction(u: IMigrationUnit, instance?: OrmMigration): boolean {
    return (instance as any)?.transaction === false || (u.type.prototype as any)?.transaction === false || (u.type as any)?.transaction === false;
  }

  /**
   * Advisory only: transpilation differences move the checksum as readily as an edit does,
   * so this warns and never blocks.
   */
  protected warnOnChecksumDrift(u: IMigrationUnit, records: IMigrationRecord[]): void {
    const rec = records.find((r) => r.Migration === u.name);

    if (rec?.Checksum && rec.Checksum !== migrationChecksum(u.type)) {
      this.Log.warn(`Migration ${u.name} source changed since it was applied (checksum mismatch). This is advisory - transpilation differences also change the checksum.`);
    }
  }

  protected lockOptions() {
    const cfg = this.driver.Options.Migration?.Lock;

    return {
      enabled: cfg?.Enabled ?? true,
      timeout: cfg?.Timeout ?? MIGRATION_LOCK_TIMEOUT,
      staleAfter: cfg?.StaleAfter ?? MIGRATION_LOCK_STALE_AFTER,
    };
  }

  /**
   * Identity written into the lock row. It exists to answer "who is holding this?" when a run
   * blocks, so it has to survive being read on another machine.
   */
  protected lockOwner(): string {
    return `${hostname()}:${process.pid}`;
  }

  /**
   * Takes the single row of the lock table, waiting for whoever has it.
   *
   * The row is claimed by INSERT rather than by "SELECT then INSERT": `Id` is unique, so the
   * database decides the winner in one statement and two processes racing here cannot both
   * succeed. A refused insert is therefore read as "somebody else holds it" - which is also why
   * the holder is re-read afterwards rather than guessed at.
   *
   * Staleness is judged against the *client* clock: `AcquiredAt` is written here as
   * `new Date()` and compared to this host's `Date.now()`. That is sound for the case this
   * lock is built for - one process migrating, crashing, and restarting to find its own
   * abandoned row - but on hosts whose clocks disagree the window is off by the skew, which
   * shows up as stealing too early or waiting too long. Stamping `AcquiredAt` from the
   * database ( a driver-level `CURRENT_TIMESTAMP` default and a server-side comparison ) would
   * remove the assumption; it needs dialect support that does not exist here yet.
   */
  protected async acquireLock(): Promise<void> {
    const { timeout, staleAfter } = this.lockOptions();
    const owner = this.lockOwner();
    const start = Date.now();
    const expired = () => Date.now() - start > timeout;
    let steals = 0;

    for (;;) {
      try {
        await this.driver.insert().into(this.lockTable).values({ Id: 1, AcquiredAt: new Date(), Owner: owner });
        return;
      } catch (err) {
        // deliberately unguarded: a select that dies here means the connection is gone, and that
        // has to surface as itself rather than as a lock timeout thirty seconds later
        const rows = ((await this.driver.select().from(this.lockTable).where({ Id: 1 })) ?? []) as Array<{ AcquiredAt: Date | string; Owner: string }>;
        const holder = rows[0];

        if (holder) {
          const acquiredAt = holder.AcquiredAt instanceof Date ? holder.AcquiredAt : new Date(holder.AcquiredAt);
          const stale = Date.now() - acquiredAt.getTime() > staleAfter;

          // A process that died mid-run leaves its row behind and nothing else will ever clear
          // it. The attempts are capped because a steal is not proof the row is gone - a DELETE
          // can succeed and remove nothing, and the read that follows then finds the same row.
          // Uncapped, that is a sleepless loop warning once per turn and never timing out.
          if (stale && steals < MIGRATION_LOCK_MAX_STEALS) {
            steals++;

            // Loud, because the alternative reading is a live run that outlasted StaleAfter - in
            // which case two migration runs are now in flight and somebody has to know
            this.Log.warn(`Stealing stale migration lock on connection ${this.driver.Options.Name}, held by ${holder.Owner} since ${acquiredAt.toISOString()} ( older than ${staleAfter}ms ). If that process is still alive, two migration runs are now in flight - raise Migration.Lock.StaleAfter above the longest run.`);
            await this.driver.del().from(this.lockTable).where({ Id: 1 });

            // straight back to the INSERT: the row should be free now, and sleeping a poll
            // interval for a lock nobody holds is pure boot latency. Only when the deadline has
            // already passed does this fall through to the throw below
            if (!expired()) {
              continue;
            }
          }

          if (expired()) {
            throw new OrmException(`Could not acquire migration lock on connection ${this.driver.Options.Name} within ${timeout}ms - held by ${holder.Owner} since ${acquiredAt.toISOString()}${steals > 0 ? `, and ${steals} attempt(s) to remove it as stale left it in place - delete the row from ${this.lockTable} by hand` : ''}`);
          }
        } else if (expired()) {
          // no row to blame, so the insert is failing for its own reasons ( missing table, lost
          // connection ). Carrying that message is the only thing that makes this diagnosable
          throw new OrmException(`Could not acquire migration lock on connection ${this.driver.Options.Name} within ${timeout}ms - no lock row is present, the last insert failed with: ${(err as Error).message}`, undefined, undefined, undefined, err);
        }

        await new Promise((r) => setTimeout(r, MIGRATION_LOCK_POLL_INTERVAL));
      }
    }
  }

  /**
   * Drops the lock row unconditionally rather than only the row this process wrote. A run whose
   * lock was stolen as stale would otherwise have nothing to release, and the alternative -
   * deleting only `Owner = ours` - leaves the table holding a row nobody will clear if the owner
   * string ever changes underneath a run. Losing a stolen lock is the lesser harm: the thief
   * already assumed the run was dead.
   */
  protected async releaseLock(): Promise<void> {
    await this.driver.del().from(this.lockTable).where({ Id: 1 });
  }

  /**
   * Concurrency guard around a whole run: one migration run per connection at a time, across
   * processes. Note the release is `finally` - a run that throws must not leave the connection
   * locked until the staleness window expires.
   */
  protected async withLock<R>(fn: () => Promise<R>): Promise<R> {
    if (!this.lockOptions().enabled) {
      return fn();
    }

    await this.acquireLock();

    try {
      return await fn();
    } finally {
      try {
        await this.releaseLock();
      } catch (err) {
        // a throw out of `finally` replaces whatever the run was already throwing, and the
        // migration error is the one the operator actually needs - the likeliest reason the
        // release died is the same dead connection that killed the run. The lock is left behind
        // instead: it goes stale and the next run steals it, which is what StaleAfter is for.
        this.Log.error(`Could not release the migration lock on connection ${this.driver.Options.Name}: ${(err as Error).message}. It will block further runs until it goes stale ( Migration.Lock.StaleAfter ) or its row is deleted from ${this.lockTable} by hand.`);
      }
    }
  }

  public async up(units: IMigrationUnit[], options?: IMigrationRunOptions): Promise<OrmMigration[]> {
    await this.ensureStorage();

    return await this.withLock(async () => {
      const records = await this.records();
      this.assertNoFailed(records);

      const isApplied = (n: string) => records.some((r) => r.Migration === n && r.FinishedAt && !r.RolledBackAt);
      const pending = units.filter((u) => !isApplied(u.name));

      if (pending.length === 0) {
        return [];
      }

      // before the fake branch as well as the real one: `fake: true` on a row nobody closed
      // records "applied" over a migration whose actual effect is unknown, which is the outcome
      // most worth being told about
      this.warnOnInterrupted(records, pending);

      // Resolved up front, once each. `transaction = false` only exists on a constructed
      // migration, so the segmenting below cannot be decided without instances - and resolving
      // a second time at execution would build every migration twice.
      const instances = new Map<string, OrmMigration>();
      for (const u of pending) {
        instances.set(u.name, await this.driver.Container.resolve<OrmMigration>(u.type, [this.driver]));
      }

      const instanceOf = (u: IMigrationUnit) => instances.get(u.name) as OrmMigration;
      const optedOut = (u: IMigrationUnit) => this.optedOutOfTransaction(u, instances.get(u.name));

      const batch = Math.max(0, ...records.filter((r) => r.FinishedAt && !r.RolledBackAt).map((r) => r.Batch ?? 0)) + 1;
      const executed: OrmMigration[] = [];

      if (options?.fake) {
        const stamp = new Date();

        for (const u of pending) {
          const existing = records.find((r) => r.Migration === u.name);

          if (existing) {
            await this.driver
              .update()
              .in(this.table)
              .update({ StartedAt: stamp, FinishedAt: stamp, RolledBackAt: null, Logs: null, Batch: batch, Checksum: migrationChecksum(u.type) })
              .where({ Migration: u.name });
          } else {
            await this.driver
              .insert()
              .into(this.table)
              .values({ Migration: u.name, CreatedAt: stamp, StartedAt: stamp, FinishedAt: stamp, RolledBackAt: null, Logs: null, Checksum: migrationChecksum(u.type), Batch: batch });
          }

          executed.push(instanceOf(u));
          this.Log.info(`Migration ${u.name}: faked (recorded without executing)`);
        }

        return executed;
      }

      const startAndRun = async (u: IMigrationUnit) => {
        const migration = instanceOf(u);
        // the snapshot taken at the top of the run is still accurate here: a unit appears at
        // most once in `pending`, and nothing writes its row before this point
        const existing = records.find((r) => r.Migration === u.name);
        await this.upsertStart(u.name, existing);

        this.warnOnChecksumDrift(u, records);
        await migration.up(this.driver);
        await this.markFinished(u.name, batch, migrationChecksum(u.type));

        executed.push(migration);
        this.Log.info(`Migration ${u.name}:up() success !`);
      };

      /**
       * Only ever called once the transaction that was running the migration has unwound - a
       * failure row written inside it would be rolled back with everything else, leaving no
       * trace of what broke.
       */
      const recordFailure = async (name: string, err: unknown) => {
        try {
          // deliberately re-read rather than reuse the run's snapshot: this has to observe
          // post-rollback state, which may have lost the row `upsertStart` inserted
          const fresh = (await this.records()).find((r) => r.Migration === name);

          if (!fresh) {
            await this.upsertStart(name, undefined);
          }

          await this.markFailed(name, err as Error);
        } catch (bookkeeping) {
          // the likeliest reason up() died is a connection that is now gone, which kills this
          // write too. The migration error is what the caller needs; losing it to a secondary
          // failure would hide both the migration name and the root cause.
          this.Log.error(`Migration ${name} on connection ${this.driver.Options.Name} failed, and the failure row could not be written: ${(bookkeeping as Error).message}. The tracking table may not reflect that this migration is half-applied - verify it by hand.`);
        }
      };

      const failure = (name: string, err: unknown) => new OrmException(`Migration ${name} failed on connection ${this.driver.Options.Name}: ${(err as Error).message}`, undefined, undefined, undefined, err);

      const execute = async (u: IMigrationUnit, wrap: boolean) => {
        try {
          if (wrap) {
            await this.driver.transaction(async () => {
              await startAndRun(u);
            });
          } else {
            await startAndRun(u);
          }
        } catch (err) {
          await recordFailure(u.name, err);
          throw failure(u.name, err);
        }
      };

      const mode = this.transactionMode();

      if (mode === MigrationTransactionMode.PerRun) {
        // One transaction per run of consecutive non-opted-out migrations. An opted-out one
        // splits the run rather than being silently dragged into the shared transaction.
        const queue = [...pending];

        while (queue.length > 0) {
          const head = queue.shift() as IMigrationUnit;

          if (optedOut(head)) {
            await execute(head, false);
            continue;
          }

          const segment = [head];
          while (queue.length > 0 && !optedOut(queue[0])) {
            segment.push(queue.shift() as IMigrationUnit);
          }

          let current = head;

          try {
            await this.driver.transaction(async () => {
              for (const u of segment) {
                current = u;
                await startAndRun(u);
              }
            });
          } catch (err) {
            await recordFailure(current.name, err);
            throw failure(current.name, err);
          }
        }
      } else if (mode === MigrationTransactionMode.PerMigration) {
        for (const u of pending) {
          await execute(u, !optedOut(u));
        }
      } else {
        for (const u of pending) {
          await execute(u, false);
        }
      }

      return executed;
    });
  }

  public async down(units: IMigrationUnit[], options?: IMigrationDownOptions): Promise<OrmMigration[]> {
    await this.ensureStorage();

    return await this.withLock(async () => {
      const records = await this.records();
      const appliedRows = records.filter((r) => r.FinishedAt && !r.RolledBackAt);

      // a failed row is not applied, so it is simply absent from the set below. Deliberate -
      // down() is a recovery path and blocking it would leave operators with only resolve() -
      // but silently stepping around it hides that the connection stays blocked afterwards
      const failedRows = records.filter((r) => !r.FinishedAt && r.Logs);

      if (failedRows.length > 0) {
        // every one of them has to be cleared: assertNoFailed blocks on the first failed row it
        // finds, so resolving one of two leaves the connection just as blocked as before
        this.Log.warn(`Migration(s) ${failedRows.map((r) => r.Migration).join(', ')} on connection ${this.driver.Options.Name} are in failed state and are skipped by this rollback - the schema may end up reverted while every later up() stays blocked. Clear each of them with orm.Migration.resolve('${failedRows[0].Migration}', 'applied') or ('rolled-back').`);
      }

      if (appliedRows.length === 0) {
        return [];
      }

      // default is the last batch alone: one `up` run is one unit of work, so one `down`
      // undoes exactly that run rather than the whole history
      let target = appliedRows;

      if (!options?.all) {
        const lastBatch = Math.max(...appliedRows.map((r) => r.Batch ?? 0));
        target = appliedRows.filter((r) => (r.Batch ?? 0) === lastBatch);
      }

      // a row with no registered unit can never be rolled back - its class is gone, so there is
      // no down() to run and dropping the row alone would lie about the schema. Nothing can be
      // done about it here, but returning [] without a word leaves it applied forever
      const orphans = target.filter((r) => !units.some((u) => u.name === r.Migration));

      if (orphans.length > 0) {
        this.Log.warn(`Migration(s) ${orphans.map((r) => r.Migration).join(', ')} on connection ${this.driver.Options.Name} are recorded as applied but no registered migration matches them (file deleted or renamed). They cannot be rolled back and stay applied - restore the migration file, or remove the row by hand once the schema is undone.`);
      }

      // newest first - a migration has to be undone before the one it was built on top of.
      // Same-timestamp migrations fall back to reverse name, mirroring the forward order
      const toRun = units.filter((u) => target.some((r) => r.Migration === u.name)).sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : b.name.localeCompare(a.name)));

      if (toRun.length === 0) {
        return [];
      }

      // resolved up front, once each - `transaction = false` is an instance field, so the
      // segmentation below cannot be decided without instances, and resolving again at
      // execution time would construct every migration twice
      const instances = new Map<string, OrmMigration>();
      for (const u of toRun) {
        instances.set(u.name, await this.driver.Container.resolve<OrmMigration>(u.type, [this.driver]));
      }

      const optedOut = (u: IMigrationUnit) => this.optedOutOfTransaction(u, instances.get(u.name));
      const executed: OrmMigration[] = [];

      const runOne = async (u: IMigrationUnit) => {
        const migration = instances.get(u.name) as OrmMigration;

        if (!options?.fake) {
          await migration.down(this.driver);
        }

        try {
          // the row is dropped rather than stamped RolledBackAt: a deleted row and a
          // rolled-back one are both "pending" to `up()`, and dropping keeps the table
          // holding only migrations that are actually present in the database
          await this.driver.del().from(this.table).where({ Migration: u.name });
        } catch (err) {
          // down() already succeeded, so outside a transaction the schema is reverted while
          // the row still claims the migration is applied - the one state nothing downstream
          // can detect. Inside a transaction the wrapper unwinds both, so it is not a lie there
          if (!options?.fake && this.driver.CurrentTransaction === undefined) {
            this.Log.error(`Migration ${u.name} on connection ${this.driver.Options.Name}: down() completed but its tracking row could not be removed (${(err as Error).message}). The schema is reverted while the table still reports this migration as applied - delete the row from ${this.table} by hand, or every later up() will skip it.`);
          }

          throw err;
        }

        executed.push(migration);
        this.Log.info(`Migration ${u.name}: ${options?.fake ? 'faked (record removed without executing)' : 'down() success !'}`);
      };

      /**
       * No `Logs` row is written on a failed rollback, unlike `up()`: `Logs` set with a NULL
       * `FinishedAt` is the state `assertNoFailed` blocks on, and stamping it here would take a
       * connection whose only remaining recovery path is `down()` and lock that path shut too.
       * The name and connection are carried on the exception instead.
       */
      const failure = (name: string, err: unknown) => new OrmException(`Migration ${name} failed to roll back on connection ${this.driver.Options.Name}: ${(err as Error).message}`, undefined, undefined, undefined, err);

      const execute = async (u: IMigrationUnit, wrap: boolean) => {
        try {
          if (wrap) {
            await this.driver.transaction(async () => {
              await runOne(u);
            });
          } else {
            await runOne(u);
          }
        } catch (err) {
          throw failure(u.name, err);
        }
      };

      const mode = this.transactionMode();

      if (options?.fake) {
        // nothing is executed, so there is no schema change worth wrapping
        for (const u of toRun) {
          await execute(u, false);
        }
      } else if (mode === MigrationTransactionMode.PerRun) {
        // one transaction per stretch of consecutive non-opted-out migrations, exactly as `up()`
        // segments. Refusing the whole rollback instead would leave a PerRun connection holding
        // one `transaction = false` migration able to up() but never able to down() as a whole
        const queue = [...toRun];

        while (queue.length > 0) {
          const head = queue.shift() as IMigrationUnit;

          if (optedOut(head)) {
            await execute(head, false);
            continue;
          }

          const segment = [head];
          while (queue.length > 0 && !optedOut(queue[0])) {
            segment.push(queue.shift() as IMigrationUnit);
          }

          let current = head;

          try {
            await this.driver.transaction(async () => {
              for (const u of segment) {
                current = u;
                await runOne(u);
              }
            });
          } catch (err) {
            throw failure(current.name, err);
          }
        }
      } else if (mode === MigrationTransactionMode.PerMigration) {
        for (const u of toRun) {
          await execute(u, !optedOut(u));
        }
      } else {
        for (const u of toRun) {
          await execute(u, false);
        }
      }

      return executed;
    });
  }

  public async status(units: IMigrationUnit[]): Promise<IMigrationStatusEntry[]> {
    await this.ensureStorage();

    // deliberately unlocked, unlike up()/down(): this is a read-only report and taking the lock
    // would make it block for the whole Timeout behind any running migration - exactly when
    // somebody is asking what is going on
    const records = await this.records();

    // read once for the whole report rather than per entry: every row on this connection is
    // judged against the same "is anything running right now?", and asking N times would let the
    // answer change halfway down a single report
    const running = await this.runInProgress();

    return units.map((u) => {
      const rec = records.find((r) => r.Migration === u.name);
      const applied = !!(rec?.FinishedAt && !rec.RolledBackAt);
      const failed = !!(rec && !rec.FinishedAt && rec.Logs);

      return {
        name: u.name,
        connection: this.driver.Options.Name,
        applied,
        failed,
        rolledBack: !!rec?.RolledBackAt,
        pending: !applied && !failed,
        // a live run legitimately holds an open row, so it is only "interrupted" once nobody is
        // there to close it
        interrupted: !!rec && !running && this.isInterrupted(rec),
        batch: rec?.Batch ?? null,
        startedAt: rec?.StartedAt ?? null,
        finishedAt: rec?.FinishedAt ?? null,
        checksumMismatch: !!(rec?.Checksum && rec.Checksum !== migrationChecksum(u.type)),
      };
    });
  }

  public async resolve(name: string, action: MigrationResolveAction, unit?: IMigrationUnit): Promise<void> {
    await this.ensureStorage();

    // deliberately unlocked, unlike up()/down(): this is the recovery path for a run that died,
    // quite possibly while holding the lock. Blocking it behind that lock would shut the only
    // door left open
    const records = await this.records();
    const rec = records.find((r) => r.Migration === name);

    // Two shapes may be forced, and they are the two whose real outcome nobody recorded: FAILED
    // ( FinishedAt NULL, Logs set ) and INTERRUPTED ( StartedAt set, neither FinishedAt nor Logs -
    // a run killed before it could write either ). Anything else is healthy, rolled back or
    // absent, and rewriting it would destroy state nobody asked to lose.
    //
    // Deliberately without a lock check, exactly as the method comment above says: this is the
    // recovery path for a run that died, quite possibly still holding the lock. The cost is that
    // an operator who forces a row while a run is genuinely in progress overwrites it - in a
    // deployment running one migration process at a time, which is the supported shape, the run
    // in progress is the operator's own.
    if (!rec || (!(!rec.FinishedAt && rec.Logs) && !this.isInterrupted(rec))) {
      throw new OrmException(`Migration ${name} is not in failed state on connection ${this.driver.Options.Name}, and was not interrupted either - nothing to resolve`);
    }

    if (action === 'applied') {
      // A batch has to be stamped here, exactly as `markFinished` would have: `upsertStart`
      // inserts `Batch: 0` and a first-time failure never reached `markFinished`, so a row
      // resolved without this stays at 0. `down()`'s default target is max(Batch) among applied
      // rows, so a batch-0 row is silently excluded from every default rollback the moment any
      // other row carries a real batch - reachable only via `{ all: true }`. Same rule as `up()`:
      // one past the highest applied batch, which also puts it in the next default rollback.
      const batch = Math.max(0, ...records.filter((r) => r.FinishedAt && !r.RolledBackAt).map((r) => r.Batch ?? 0)) + 1;
      const patch: Partial<IMigrationRecord> = { FinishedAt: new Date(), Batch: batch };

      // The checksum can only come from the migration class, which this call does not have
      // unless the caller supplies it. Without it the column stays NULL and drift can never be
      // reported for this migration - a NULL is preferable to inventing a fingerprint for
      // source that was never verified against the database.
      if (unit) {
        patch.Checksum = migrationChecksum(unit.type);
      }

      await this.driver.update().in(this.table).update(patch).where({ Migration: name });
      this.Log.info(`Migration ${name} resolved as applied (batch ${batch})${unit ? '' : ' - Checksum left NULL, drift cannot be detected for it'}`);
    } else {
      // Logs is cleared, not merely annotated with RolledBackAt. Failed state is the pair
      // `FinishedAt` NULL *and* `Logs` set, and a rolled-back resolution leaves FinishedAt
      // NULL - so a row that kept its Logs would still trip `assertNoFailed` and block every
      // later run, which is the exact thing this call exists to undo.
      await this.driver.update().in(this.table).update({ RolledBackAt: new Date(), Logs: null }).where({ Migration: name });
      this.Log.info(`Migration ${name} resolved as rolled-back (pending again)`);
    }
  }
}
