import { NewInstance, Class } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { DateTime } from 'luxon';
import { createHash } from 'node:crypto';
import { OrmDriver } from './driver.js';
import { OrmMigration } from './interfaces.js';
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

  // up/down/status/resolve/locking implemented in later tasks
  public async up(): Promise<OrmMigration[]> {
    throw new OrmException('not implemented');
  }

  public async down(): Promise<OrmMigration[]> {
    throw new OrmException('not implemented');
  }

  public async status(): Promise<IMigrationStatusEntry[]> {
    throw new OrmException('not implemented');
  }

  public async resolve(): Promise<void> {
    throw new OrmException('not implemented');
  }
}
