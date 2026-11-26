import '@spinajs/log';
import '@spinajs/orm-pglite';
import '@spinajs/orm-sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';

import { DI } from '@spinajs/di';

import { ConnectionSessionSettings, MigrationTransactionMode, QueryContext } from '@spinajs/orm';
import type { Orm, SessionSettings } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
// registers the configuration schema, the query middleware and TenantSessionSettings before the Orm resolves
import '../../src/index.js';
import './rls-models.js';

const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };

const SQLITE = { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite', Migration: { Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } } };

// Roles are global to a PostgreSQL server: one pair per test process.
const ROLES = { app: `spina_tenant_app_${process.pid}`, other: `spina_tenant_other_${process.pid}` };

const acting = new AsyncLocalStorage<SessionSettings>();

/** Runs `fn` with its statements as `role`, and `extra` settings beside the tenant's, as another session could set them. */
export function actingAs<T>(role: string, fn: () => PromiseLike<T>, extra: Readonly<Record<string, string>> = {}): Promise<T> {
  return acting.run({ ...extra, role }, async () => await fn());
}

// The setting `role` is SET LOCAL ROLE. Answers nothing outside actingAs().
class ActingRole extends ConnectionSessionSettings {
  settings(): Promise<SessionSettings | undefined> {
    return Promise.resolve(acting.getStore());
  }
}

export interface RlsApp {
  readonly app: TestApp;
  readonly orm: Orm;
  /** The connection `rls`, which holds the RLS models. */
  readonly driver: PostgresOrmDriver;
  /** Neither superuser nor BYPASSRLS, so the policies apply to it; the bypass role of the suites' policies. */
  readonly appRole: string;
  /** Neither superuser nor the bypass role. */
  readonly otherRole: string;
  /** Runs `statement` on `rls` as the connecting superuser, past the model layer. */
  sql(statement: string): Promise<unknown>;
  dispose(): Promise<void>;
}

/** sqlite `default` beside `rls` on the given server, migrated, with the two roles created and granted. */
export async function bootWith(rls: Record<string, unknown>, cleanup: (app: RlsApp) => Promise<void> = () => Promise.resolve()): Promise<RlsApp> {
  const app = await createTestApp({
    config: { logger: SILENT, db: { DefaultConnection: 'sqlite', Connections: [SQLITE, { ...rls, Name: 'rls' }], Aliases: { tenancy: 'default' } } },
    register: (container) => container.register(ActingRole).as(ConnectionSessionSettings),
  });

  try {
    const orm = (await migrateTestDatabase(app.container)).orm;
    const driver = orm.Connections.get('rls');
    if (!(driver instanceof PostgresOrmDriver)) throw new Error('the connection rls is not PostgreSQL');
    const sql = async (statement: string): Promise<unknown> => {
      const rows: unknown = await driver.executeOnDb(statement, [], QueryContext.Schema);
      return rows;
    };
    const booted: RlsApp = {
      app,
      orm,
      driver,
      sql,
      appRole: ROLES.app,
      otherRole: ROLES.other,
      dispose: async () => {
        try {
          await app.dispose();
        } finally {
          await cleanup(booted);
        }
      },
    };
    for (const role of [booted.appRole, booted.otherRole]) {
      await sql(`DROP ROLE IF EXISTS "${role}"`);
      await sql(`CREATE ROLE "${role}" NOLOGIN`);
      await sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
      await sql(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
    }
    return booted;
  } catch (err) {
    await app.dispose();
    throw err;
  }
}

/** `rls` on an in-memory PGlite database of its own. */
export const bootRlsApp = (): Promise<RlsApp> => bootWith({ Driver: 'orm-driver-pglite', Filename: ':memory:' });

export const POSTGRES = { Host: 'localhost', Port: Number(process.env.ORM_TEST_POSTGRES_PORT ?? 15432), User: 'postgres', Password: 'postgres' };

function postgresReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: POSTGRES.Host, port: POSTGRES.Port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function onAdmin(statements: readonly string[]): Promise<void> {
  const admin = await DI.child().resolve<PostgresOrmDriver>(PostgresOrmDriver, [{ Name: 'tenancy-orm-pg-admin', Driver: 'orm-driver-postgres', ...POSTGRES, Database: 'postgres', Pool: { Max: 1 } }]);
  await admin.connect();
  try {
    for (const statement of statements) await admin.executeOnDb(statement, [], QueryContext.Schema);
  } finally {
    await admin.disconnect();
  }
}

/**
 * `rls` on a database of its own on the server at ORM_TEST_POSTGRES_PORT, dropped with the roles by dispose();
 * undefined when the server does not answer, unless ORM_TEST_POSTGRES_REQUIRED=1.
 */
export async function bootPostgresRlsApp(): Promise<RlsApp | undefined> {
  const where = `Postgres at ${POSTGRES.Host}:${POSTGRES.Port}`;
  if (!(await postgresReachable())) {
    if (process.env.ORM_TEST_POSTGRES_REQUIRED === '1') throw new Error(`${where} is unreachable and ORM_TEST_POSTGRES_REQUIRED=1`);
    console.warn(`      ${where} is unreachable, suite skipped`);
    return undefined;
  }
  const database = `td_04b_tenant_rls_${randomBytes(4).toString('hex')}`;
  // The database first: the roles hold privileges in it.
  const drop = (): Promise<void> => onAdmin([`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`, `DROP ROLE IF EXISTS "${ROLES.app}"`, `DROP ROLE IF EXISTS "${ROLES.other}"`]);
  await onAdmin([`CREATE DATABASE "${database}"`]);
  try {
    // A read replica on the same database: model selects run on a second driver, as in production.
    return await bootWith({ Driver: 'orm-driver-postgres', ...POSTGRES, Database: database, Pool: { Max: 6 }, Replicas: [{}] }, drop);
  } catch (err) {
    await drop();
    throw err;
  }
}
