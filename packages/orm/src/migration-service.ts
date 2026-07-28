import { NewInstance, Class } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { DateTime } from 'luxon';
import { createHash } from 'node:crypto';
import { OrmDriver } from './driver.js';
import { MigrationTransactionMode, OrmMigration } from './interfaces.js';
import { OrmException } from './exceptions.js';

export const MIGRATION_TABLE_NAME = 'spinajs_migration';
export const MIGRATION_LOCK_POLL_INTERVAL = 500;
export const MIGRATION_LOCK_TIMEOUT = 30_000;
export const MIGRATION_LOCK_STALE_AFTER = 600_000;

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
   */
  public abstract ensureStorage(): Promise<void>;

  /**
   * Migrations that finished successfully and were not rolled back.
   */
  public abstract applied(): Promise<IMigrationRecord[]>;

  public abstract up(units: IMigrationUnit[], options?: IMigrationRunOptions): Promise<OrmMigration[]>;
  public abstract down(units: IMigrationUnit[], options?: IMigrationDownOptions): Promise<OrmMigration[]>;
  public abstract status(units: IMigrationUnit[]): Promise<IMigrationStatusEntry[]>;

  /**
   * Forces a migration's recorded state without running it - the escape hatch for a
   * run that died halfway and left the table lying.
   */
  public abstract resolve(name: string, action: MigrationResolveAction): Promise<void>;
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

  public async ensureStorage(): Promise<void> {
    // a builder executes at most once, so every statement needs a fresh SchemaQueryBuilder
    const schema = () => this.driver.schema();
    const db = this.driver.Options.Database;

    if (!(await schema().tableExists(this.table, db))) {
      await schema().createTable(this.table, (t) => {
        t.string('Migration').unique().notNull();
        t.dateTime('CreatedAt').notNull();
        t.dateTime('StartedAt').notNull();
        t.dateTime('FinishedAt');
        t.dateTime('RolledBackAt');
        t.text('Logs');
        t.string('Checksum', 64);
        t.int('Batch').notNull().default().value(1);
      });
    } else {
      const cols = (await this.driver.tableInfo(this.table, db)) ?? [];
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

        // legacy rows: applied long ago, treat CreatedAt as both start and finish
        await schema().raw(`UPDATE ${this.table} SET StartedAt = CreatedAt WHERE StartedAt IS NULL`);
        await schema().raw(`UPDATE ${this.table} SET FinishedAt = CreatedAt WHERE FinishedAt IS NULL AND Logs IS NULL`);
        await schema().raw(`UPDATE ${this.table} SET Batch = 1 WHERE Batch IS NULL`);
      }
    }

    if (!(await schema().tableExists(this.lockTable, db))) {
      await schema().createTable(this.lockTable, (t) => {
        t.int('Id').unique().notNull();
        t.dateTime('AcquiredAt').notNull();
        t.string('Owner', 255).notNull();
      });
    }
  }

  protected async records(): Promise<IMigrationRecord[]> {
    return ((await this.driver.select().from(this.table)) ?? []) as IMigrationRecord[];
  }

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
      throw new OrmException(`Migration ${failed.Migration} on connection ${this.driver.Options.Name} failed previously and blocks migration runs. Inspect Logs column, fix the database manually, then run orm.Migration.resolve('${failed.Migration}', 'applied') or ('rolled-back').`);
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

  /**
   * Concurrency guard around a whole run. A passthrough until the lock table is wired up.
   */
  protected async withLock<R>(fn: () => Promise<R>): Promise<R> {
    return fn();
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

        // the row is dropped rather than stamped RolledBackAt: a deleted row and a
        // rolled-back one are both "pending" to `up()`, and dropping keeps the table
        // holding only migrations that are actually present in the database
        await this.driver.del().from(this.table).where({ Migration: u.name });

        executed.push(migration);
        this.Log.info(`Migration ${u.name}: ${options?.fake ? 'faked (record removed without executing)' : 'down() success !'}`);
      };

      const mode = this.transactionMode();

      if (options?.fake) {
        // nothing is executed, so there is no schema change worth wrapping
        for (const u of toRun) {
          await runOne(u);
        }
      } else if (mode === MigrationTransactionMode.PerRun) {
        // checked before the transaction opens: discovering the opt-out halfway through
        // would mean running - and then rolling back - work that was never going to commit
        const blocker = toRun.find(optedOut);

        if (blocker) {
          throw new OrmException(`Migration ${blocker.name} has transaction=false and cannot take part in a PerRun rollback - roll it back on its own, or switch this connection to PerMigration.`);
        }

        await this.driver.transaction(async () => {
          for (const u of toRun) {
            await runOne(u);
          }
        });
      } else if (mode === MigrationTransactionMode.PerMigration) {
        for (const u of toRun) {
          if (optedOut(u)) {
            await runOne(u);
          } else {
            await this.driver.transaction(async () => {
              await runOne(u);
            });
          }
        }
      } else {
        for (const u of toRun) {
          await runOne(u);
        }
      }

      return executed;
    });
  }

  public async status(units: IMigrationUnit[]): Promise<IMigrationStatusEntry[]> {
    await this.ensureStorage();
    const records = await this.records();

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
        batch: rec?.Batch ?? null,
        startedAt: rec?.StartedAt ?? null,
        finishedAt: rec?.FinishedAt ?? null,
        checksumMismatch: !!(rec?.Checksum && rec.Checksum !== migrationChecksum(u.type)),
      };
    });
  }

  public async resolve(name: string, action: MigrationResolveAction): Promise<void> {
    await this.ensureStorage();
    const rec = (await this.records()).find((r) => r.Migration === name);

    // only a row in the failed state may be forced - anything else is either healthy or
    // absent, and rewriting it would destroy state nobody asked to lose
    if (!rec || rec.FinishedAt || !rec.Logs) {
      throw new OrmException(`Migration ${name} is not in failed state on connection ${this.driver.Options.Name} - nothing to resolve`);
    }

    if (action === 'applied') {
      await this.driver.update().in(this.table).update({ FinishedAt: new Date() }).where({ Migration: name });
      this.Log.info(`Migration ${name} resolved as applied`);
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
