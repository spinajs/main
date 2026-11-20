import '@spinajs/log';
import '@spinajs/orm-mysql';
import '@spinajs/orm-postgres';
import '@spinajs/orm-sqlite';
import { createConnection } from 'node:net';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { createTestDatabase } from '@spinajs/testing-orm';
import type { TestDatabase } from '@spinajs/testing-orm';

import { AuditTrailTableMigration } from './migration.js';

export type Dialect = 'sqlite' | 'pglite' | 'postgres' | 'mysql';
export const DIALECTS: readonly Dialect[] = ['sqlite', 'pglite', 'postgres', 'mysql'];

const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };
const POSTGRES = {
  Driver: 'orm-driver-postgres',
  Name: 'postgres',
  Host: 'localhost',
  Port: Number(process.env.ORM_TEST_POSTGRES_PORT ?? 15432),
  User: 'postgres',
  Password: 'postgres',
  Database: process.env.ORM_TEST_POSTGRES_DATABASE ?? 'postgres',
};
const MYSQL = {
  Driver: 'orm-driver-mysql',
  Name: 'mysql',
  Host: process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1',
  Port: Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306),
  User: process.env.ORM_TEST_MYSQL_USER ?? 'root',
  Password: process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root',
  Database: process.env.ORM_TEST_MYSQL_DATABASE ?? 'test',
};

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

class TrailTable extends AuditTrailTableMigration {
  constructor(private readonly name: string) {
    super();
  }

  protected table(): string {
    return this.name;
  }
}

export interface TestDbOptions {
  /** More entries for `db.Connections`; each is reached with `driver(<its Name>)`. */
  readonly connections?: readonly Record<string, unknown>[];
}

/** One ORM over sqlite `:memory:` (the default connection, migrated on startup), PGlite, and the Postgres and MySQL servers that answer. */
export class TestDb {
  private constructor(private readonly app: TestApp, private readonly orm: Orm, private readonly pglite: TestDatabase, private readonly reached: readonly Dialect[]) {}

  /** `audit` is the suite's `audit` configuration. */
  static async open(audit: Record<string, unknown> = {}, options: TestDbOptions = {}): Promise<TestDb> {
    const pglite = await createTestDatabase({ connection: 'pglite', migrate: false });
    const connections: unknown[] = [{ Driver: 'orm-driver-sqlite', Name: 'sqlite', Filename: ':memory:', Migration: { OnStartup: true } }, pglite.config, ...(options.connections ?? [])];
    const reached: Dialect[] = ['sqlite', 'pglite'];
    if (await reachable(POSTGRES.Host, POSTGRES.Port)) {
      connections.push(POSTGRES);
      reached.push('postgres');
    }
    if (await reachable(MYSQL.Host, MYSQL.Port)) {
      connections.push(MYSQL);
      reached.push('mysql');
    }
    try {
      const app = await createTestApp({ config: { logger: SILENT, db: { DefaultConnection: 'sqlite', StrictTableCheck: false, Connections: connections }, audit }, resolve: [Orm] });
      return new TestDb(app, await app.resolve(Orm), pglite, reached);
    } catch (err) {
      await pglite.dispose();
      throw err;
    }
  }

  /**
   * The dialects a suite declares its cases for, known when the file loads: sqlite and PGlite always, a server when the
   * environment names it (ORM_TEST_POSTGRES_PORT; ORM_TEST_MYSQL_HOST or ORM_TEST_MYSQL_PORT), as the dialect CI jobs do.
   * A suite that loops over DIALECTS and skips by has() also runs on a server that merely answers on its default port.
   */
  static dialects(): readonly Dialect[] {
    const env = process.env;
    const named: Record<Dialect, boolean> = { sqlite: true, pglite: true, postgres: env.ORM_TEST_POSTGRES_PORT !== undefined, mysql: env.ORM_TEST_MYSQL_HOST !== undefined || env.ORM_TEST_MYSQL_PORT !== undefined };
    return DIALECTS.filter((dialect) => named[dialect]);
  }

  has(dialect: Dialect): boolean {
    return this.reached.includes(dialect);
  }

  /** The driver of a dialect, or of a connection the suite added through `options.connections`. */
  driver(connection: string): OrmDriver {
    const driver = this.orm.Connections.get(connection);
    if (!driver) throw new Error(`TestDb: no connection ${connection}`);
    return driver;
  }

  /** The ORM connection name of a dialect: what a trail's `connection`, `AuditFilter.source` and `AuditBatch.source` take. */
  connectionName(dialect: Dialect): string {
    return this.driver(dialect).Options.Name;
  }

  /** Creates the trail table `table` on `dialect`, dropping what an earlier run left. */
  async migrate(dialect: Dialect, table: string): Promise<void> {
    await this.drop(dialect, table);
    await new TrailTable(table).up(this.driver(dialect));
  }

  async drop(dialect: Dialect, table: string): Promise<void> {
    await new TrailTable(table).down(this.driver(dialect));
  }

  async rows(dialect: Dialect, table: string): Promise<Record<string, unknown>[]> {
    const rows: unknown = await this.driver(dialect).select().from(table).orderBy('seq');
    return Array.isArray(rows) ? rows.filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object') : [];
  }

  async close(): Promise<void> {
    await this.app.dispose();
    await this.pglite.dispose();
  }
}
