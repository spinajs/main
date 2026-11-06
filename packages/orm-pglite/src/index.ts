import { readFile } from 'node:fs/promises';
import { PGlite, type PGliteOptions } from '@electric-sql/pglite';
import { Injectable, NewInstance } from '@spinajs/di';
import { ConnectionState, OrmException, SqlDialect, type ISupportedFeature, type OrmDriver } from '@spinajs/orm';
import { PostgresOrmDriver, pgEscapeIdentifier } from '@spinajs/orm-postgres';
import type pg from 'pg';

import { PglitePool, PglitePoolView, pgCompatibleParsers } from './pool-adapter.js';
import { acquireSharedPglite } from './shared.js';
import { PGLITE_SQL_DIALECT } from './sql-dialect.js';

export * from './pool-adapter.js';
export * from './shared.js';
export { PGLITE_SQL_DIALECT } from './sql-dialect.js';

/** `Options` of a PGlite connection entry. */
export interface IPgliteDriverOptions {
  /** Created when missing and made the session's search_path, as `Options.Schema` does on a server. */
  Schema?: string;
  /** A `dumpDataDir()` tarball to start from: a file path ( JSON-safe ) or the Blob itself. */
  LoadDataDir?: string | Blob;
  /** PGlite's relaxedDurability: a query does not wait for the file system flush. */
  RelaxedDurability?: boolean;
  /** The name of a process-wide PGlite instance to share ( created on first use ); this connection runs in `Schema`, default `public`. */
  Shared?: string;
}

/**
 * The postgres driver over an in-process PGlite: every compiler and converter of `PostgresOrmDriver` runs unchanged,
 * against one session. `Filename` is a data directory to keep the database in; unset or `:memory:`, it lives in memory.
 */
@SqlDialect(PGLITE_SQL_DIALECT)
@Injectable('orm-driver-pglite')
@NewInstance()
export class PgliteOrmDriver extends PostgresOrmDriver {
  public supportedFeatures(): ISupportedFeature {
    // One session: a second outermost transaction waits for the first instead of for the client it holds.
    return { ...super.supportedFeatures(), concurrentTransactions: false };
  }

  public async connect(): Promise<OrmDriver> {
    await this.closePool();

    const options = (this.Options.Options ?? {}) as IPgliteDriverOptions;
    if (options.Shared) {
      await this.connectShared(options.Shared, options.Schema ?? 'public');
    } else {
      await this.connectOwn(options);
    }

    this.setState(ConnectionState.Connected);
    return this;
  }

  public async disconnect(): Promise<OrmDriver> {
    this.stopHealthCheck();
    this.setState(ConnectionState.Disconnected);
    await this.closePool();
    return this;
  }

  /** The database as a tarball for `Options.LoadDataDir`. Waits for the session, so never call it inside a transaction. */
  public async dumpDataDir(): Promise<Blob> {
    const pool = this.Pool as unknown as PglitePool | PglitePoolView | undefined;
    if (!pool) {
      throw new OrmException(`connection ${this.Options.Name} is not connected`);
    }

    return pool.dumpDataDir();
  }

  // A reconnect would replace this database with an empty one.
  protected isRetryableError(_err: unknown): boolean {
    return false;
  }

  private async connectOwn(options: IPgliteDriverOptions): Promise<void> {
    const db = await PGlite.create(await this.pgliteOptions(options));

    try {
      // A server session gets both from the pool's connection options.
      await db.exec(`SET TimeZone TO 'UTC'`);
      if (options.Schema) {
        const schema = pgEscapeIdentifier(options.Schema);
        await db.exec(`CREATE SCHEMA IF NOT EXISTS ${schema}; SET search_path TO ${schema}`);
      }

      this.Pool = new PglitePool(db, await pgCompatibleParsers(db), this.resolvedPoolOptions().AcquireTimeout) as unknown as pg.Pool;
    } catch (err) {
      await db.close();
      throw err;
    }
  }

  private async connectShared(name: string, schema: string): Promise<void> {
    const { pool, release } = await acquireSharedPglite(name, this.resolvedPoolOptions().AcquireTimeout);
    const searchPath = pgEscapeIdentifier(schema);

    try {
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${searchPath}`);
      } finally {
        client.release();
      }
    } catch (err) {
      release();
      throw err;
    }

    this.Pool = new PglitePoolView(pool, searchPath, release) as unknown as pg.Pool;
  }

  private async closePool(): Promise<void> {
    const previous = this.Pool as unknown as PglitePool | PglitePoolView | undefined;
    this.Pool = undefined as unknown as pg.Pool;
    await previous?.end();
  }

  private async pgliteOptions(options: IPgliteDriverOptions): Promise<PGliteOptions> {
    const filename = this.Options.Filename;
    const loadDataDir = typeof options.LoadDataDir === 'string' ? new Blob([new Uint8Array(await readFile(options.LoadDataDir))]) : options.LoadDataDir;

    return {
      ...(filename && filename !== ':memory:' ? { dataDir: filename } : {}),
      ...(loadDataDir ? { loadDataDir } : {}),
      relaxedDurability: options.RelaxedDurability ?? false,
    };
  }
}
