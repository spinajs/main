/* eslint-disable @typescript-eslint/no-explicit-any */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm, QueryContext } from '@spinajs/orm';
// Orm types its logger as the abstract Log from log-common; this import registers the concrete one.
import '@spinajs/log';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as net from 'node:net';
import _ from 'lodash';
import 'mocha';
import pg from 'pg';

import { PostgresOrmDriver, pgEscapeIdentifier, toPositionalParameters } from '../../src/index.js';

export const PG = {
  Host: process.env.ORM_TEST_POSTGRES_HOST ?? '127.0.0.1',
  Port: Number(process.env.ORM_TEST_POSTGRES_PORT ?? 15432),
  User: process.env.ORM_TEST_POSTGRES_USER ?? 'postgres',
  Password: process.env.ORM_TEST_POSTGRES_PASSWORD ?? 'postgres',
  // Not the compose default `test`: authz-orm's tests create a schema named `test` there, which
  // would make a database-qualified table name resolve by accident.
  Database: process.env.ORM_TEST_POSTGRES_DATABASE ?? 'orm_postgres_it',
  Container: process.env.ORM_TEST_POSTGRES_CONTAINER ?? 'spinajs-orm-test-postgres',
};

export const CONNECTION = 'postgres';

const REQUIRED = process.env.ORM_TEST_POSTGRES_REQUIRED === '1';
const KEEP_SCHEMA = process.env.ORM_TEST_POSTGRES_KEEP_SCHEMA === '1';

export interface IPgSuiteOptions {
  name: string;
  pool?: { Max?: number; Min?: number; IdleTimeout?: number; AcquireTimeout?: number };
  resilience?: { HealthCheckInterval?: number; MaxRetries?: number; RetryDelay?: number; MaxRetryDelay?: number };
}

export interface IPgSuite {
  readonly schema: string;
  readonly orm: Orm;
  readonly driver: PostgresOrmDriver;
  /** Runs on the ORM's own pool, so inside `transaction()` it joins the transaction. */
  raw<T = any>(sql: string, params?: unknown[]): Promise<T>;
  /** Runs on a separate client outside the ORM: a second session for isolation tests. */
  external<T = any>(sql: string, params?: unknown[]): Promise<T>;
  reset(...tables: string[]): Promise<void>;
  close(): Promise<void>;
}

export function reachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: PG.Host, port: PG.Port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function withClient<T>(database: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ host: PG.Host, port: PG.Port, user: PG.User, password: PG.Password, database });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function ensureDatabase(): Promise<void> {
  await withClient('postgres', async (c) => {
    const found = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [PG.Database]);
    if (found.rowCount !== 0) {
      return;
    }
    try {
      await c.query(`CREATE DATABASE ${pgEscapeIdentifier(PG.Database)}`);
    } catch (err) {
      // 42P04: a parallel run created it between the probe and here
      if ((err as { code?: string }).code !== '42P04') {
        throw err;
      }
    }
  });
}

function configurationFor(schema: string, options: IPgSuiteOptions) {
  return class PgIntegrationConf extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();

      _.mergeWith(
        this.Config,
        {
          logger: {
            targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
            rules: [{ name: '*', level: 'error', target: 'Empty' }],
          },
          db: {
            Migration: { Startup: false },
            Connections: [
              {
                Driver: 'orm-driver-postgres',
                Name: CONNECTION,
                Host: PG.Host,
                Port: PG.Port,
                User: PG.User,
                Password: PG.Password,
                Database: PG.Database,
                Pool: { Max: 4, IdleTimeout: 5000, AcquireTimeout: 5000, ...options.pool },
                ...(options.resilience ? { Resilience: options.resilience } : {}),
                Options: { Schema: schema },
                Migration: { Table: 'orm_migrations', OnStartup: true },
              },
            ],
          },
        },
        (target: any, source: any) => (_.isArray(target) ? target.concat(source) : undefined),
      );
    }
  };
}

export async function openSuite(ctx: Mocha.Context, options: IPgSuiteOptions): Promise<IPgSuite> {
  if (!(await reachable())) {
    if (REQUIRED) {
      throw new Error(`ORM_TEST_POSTGRES_REQUIRED=1 but PostgreSQL at ${PG.Host}:${PG.Port} is unreachable`);
    }
    console.warn(`      PostgreSQL at ${PG.Host}:${PG.Port} is unreachable, suite skipped (set ORM_TEST_POSTGRES_REQUIRED=1 to fail instead)`);
    ctx.skip();
  }

  await ensureDatabase();
  const schema = `it_${options.name}_${process.pid}_${randomBytes(3).toString('hex')}`.toLowerCase();
  await withClient(PG.Database, (c) => c.query(`CREATE SCHEMA ${pgEscapeIdentifier(schema)}`));

  DI.clearCache();
  DI.register(configurationFor(schema, options)).as(Configuration);
  DI.register(PostgresOrmDriver).as('orm-driver-postgres');

  await DI.resolve(Orm);
  const orm = DI.get(Orm)!;
  await orm.Migration.up();
  // model descriptors take their columns from the live schema
  await orm.reloadTableInfo();
  const driver = orm.Connections.get(CONNECTION) as PostgresOrmDriver;

  return {
    schema,
    orm,
    driver,
    raw: (sql: string, params: unknown[] = []) => driver.executeOnDb(sql, params as any[], QueryContext.Select),
    external: (sql: string, params: unknown[] = []) =>
      withClient(PG.Database, async (c) => {
        await c.query(`SET search_path TO ${pgEscapeIdentifier(schema)}`);
        return (await c.query(toPositionalParameters(sql), params as any[])).rows as any;
      }),
    reset: async (...tables: string[]) => {
      await driver.executeOnDb(`TRUNCATE TABLE ${tables.map((t) => pgEscapeIdentifier(t)).join(', ')} RESTART IDENTITY CASCADE`, [], QueryContext.Schema);
    },
    close: async () => {
      await orm.dispose();
      DI.clearCache();
      if (KEEP_SCHEMA) {
        console.warn(`      kept schema ${schema} (ORM_TEST_POSTGRES_KEEP_SCHEMA=1)`);
        return;
      }
      await withClient(PG.Database, (c) => c.query(`DROP SCHEMA IF EXISTS ${pgEscapeIdentifier(schema)} CASCADE`));
    },
  };
}

/** The SQLSTATE of a driver error, looked up through OrmException's `inner` / `cause` chain. */
export function sqlState(err: unknown): string | undefined {
  let current: any = err;
  for (let depth = 0; current && depth < 6; depth++) {
    if (typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code)) {
      return current.code;
    }
    current = current.inner ?? current.cause;
  }
  return undefined;
}

/**
 * A test for a logged finding that is not fixed yet. It passes while the body fails, and fails
 * once the body passes, so a fixed finding cannot stay marked as broken.
 */
export function knownFailure(finding: string, title: string, fn: () => Promise<void>): void {
  it(`[known failure ${finding}] ${title}`, async () => {
    let failed = false;
    try {
      await fn();
    } catch {
      failed = true;
    }
    if (!failed) {
      throw new Error(`${finding} no longer fails: turn this back into it() and close the finding`);
    }
  });
}

/** Switches the process time zone (Date, pg-types, luxon 'system'); returns the restore function. */
export function useProcessTimeZone(zone: string): () => void {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  if (new Date('2026-07-01T00:00:00Z').getTimezoneOffset() === 0) {
    throw new Error(`process.env.TZ=${zone} did not take effect; run the suite with TZ=${zone} in the environment instead`);
  }
  return () => {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  };
}

export function dockerContainerAvailable(): boolean {
  try {
    execSync(`docker inspect ${PG.Container}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
