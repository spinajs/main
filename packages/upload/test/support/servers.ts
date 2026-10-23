import { createConnection } from 'node:net';
import { DI } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { MySqlOrmDriver } from '@spinajs/orm-mysql';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';

// The docker-compose `test` profile (docker-compose.yml: postgres 16.6 on 15432, mysql 8.4 on 13306).
export const POSTGRES = { Host: '127.0.0.1', Port: Number(process.env.ORM_TEST_POSTGRES_PORT ?? 15432), User: 'postgres', Password: 'postgres' };
export const MYSQL = { Host: '127.0.0.1', Port: Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306), User: 'root', Password: 'root' };

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Skips the suite when the server is down, or fails it with UPLOAD_REQUIRE_DB=1 (as users/test/password-store-dialects.test.ts:74-82). */
export async function requireServer(ctx: Mocha.Context, name: string, host: string, port: number): Promise<void> {
  if (await reachable(host, port)) return;
  if (process.env.UPLOAD_REQUIRE_DB === '1') throw new Error(`${name} at ${host}:${port} is unreachable`);
  console.warn(`      ${name} is unreachable, suite skipped (set UPLOAD_REQUIRE_DB=1 to fail instead)`);
  ctx.skip();
}

export function run(driver: OrmDriver, sql: string): Promise<unknown> {
  return (driver as unknown as { executeOnDb(s: string, b: unknown[], c: QueryContext): Promise<unknown> }).executeOnDb(sql, [], QueryContext.Schema);
}

export async function connectPostgres(database: string, max = 4): Promise<OrmDriver> {
  const driver = await DI.child().resolve<OrmDriver>(PostgresOrmDriver, [{ Name: `upload-pg-${database}`, Driver: 'orm-driver-postgres', ...POSTGRES, Database: database, Pool: { Max: max, AcquireTimeout: 15000 } }]);
  await driver.connect();
  return driver;
}

export async function connectMysql(database?: string): Promise<OrmDriver> {
  const driver = await DI.child().resolve<OrmDriver>(MySqlOrmDriver, [{ Name: `upload-mysql-${database ?? 'admin'}`, Driver: 'orm-driver-mysql', ...MYSQL, Database: database, Pool: { Max: 2, AcquireTimeout: 15000 } }]);
  await driver.connect();
  return driver;
}

export async function postgresAdmin(sql: string): Promise<void> {
  const admin = await connectPostgres('postgres', 1);
  try {
    await run(admin, sql);
  } finally {
    await admin.disconnect();
  }
}

export async function mysqlAdmin(sql: string): Promise<void> {
  const admin = await connectMysql();
  try {
    await run(admin, sql);
  } finally {
    await admin.disconnect();
  }
}
