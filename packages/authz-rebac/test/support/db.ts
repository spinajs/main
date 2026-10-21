/** Test DB fixture: an Orm in a child DI container on SQLite `:memory:`, with authz_rebac_tuple on the alias `authz`. */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import '@spinajs/log';
import { Orm, QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

import { AuthzRebac_2026_10_21_00_00_00 } from '../../src/index.js';

export interface TestDb {
  readonly orm: Orm;
  readonly container: IContainer;
  /** The connection db.Aliases.authz names, with authz_rebac_tuple. */
  readonly driver: OrmDriver;
  dispose(): Promise<void>;
}

/** Runs plain SQL (`?` placeholders); `executeOnDb` lives on the SQL drivers, not on `OrmDriver`. */
export function rawQuery(driver: OrmDriver, sql: string, bindings: unknown[] = [], context: QueryContext = QueryContext.Select): Promise<any> {
  return (driver as unknown as { executeOnDb(sql: string, bindings: unknown[], context: QueryContext): Promise<any> }).executeOnDb(sql, bindings, context);
}

/** Call from a `before()` hook: boots an Orm whose alias `authz` names a fresh SQLite connection and runs the migration there. */
export async function bootDb(suite: string): Promise<TestDb> {
  DI.setESMModuleSupport();
  const name = `rebac-${suite}`;
  const connections = [{ Name: name, Driver: 'orm-driver-sqlite', Filename: ':memory:', Migration: { OnStartup: false } }];

  class TestDbConfiguration extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      // Replaced, not merged: package configs must not add connections here.
      const config = this.Config;
      const db = (config.db ?? {}) as { Aliases?: Record<string, string> };
      config.db = { ...db, DefaultConnection: name, Connections: connections, Aliases: { ...db.Aliases, authz: name }, StrictTableCheck: false };
    }
  }

  const container = DI.child();
  container.register(TestDbConfiguration).as(Configuration);
  container.register(SqliteOrmDriver).as('orm-driver-sqlite');

  await container.resolve(Configuration);
  const orm = await container.resolve(Orm);
  const driver = orm.Connections.get('authz')!;
  // By hand: the boot migration pass is not what these suites test.
  await new AuthzRebac_2026_10_21_00_00_00().up(driver);
  // The Orm read the table info before authz_rebac_tuple existed.
  await orm.reloadTableInfo();

  return { orm, container, driver, dispose: () => orm.dispose() };
}
