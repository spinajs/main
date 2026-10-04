/** Boots an Orm on sqlite `:memory:` in a child DI container and runs the authn-orm migrations on it. */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import '@spinajs/log';
import { Orm, QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import '@spinajs/authn-orm';

export interface SqliteDb {
  readonly container: IContainer;
  /** The `'default'` connection, which the authn-orm migrations and stores use. */
  readonly driver: OrmDriver;
  dispose(): Promise<void>;
}

export function rawQuery(driver: OrmDriver, sql: string, bindings: unknown[] = [], context: QueryContext = QueryContext.Select): Promise<any> {
  return (driver as unknown as { executeOnDb(sql: string, bindings: unknown[], context: QueryContext): Promise<any> }).executeOnDb(sql, bindings, context);
}

export async function bootSqlite(name: string): Promise<SqliteDb> {
  DI.setESMModuleSupport();
  const connection = { Name: `n5-${name}`, Driver: 'orm-driver-sqlite', Filename: ':memory:', Migration: { OnStartup: true } };

  class SqliteConfiguration extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      const config = this.Config as Record<string, unknown>;
      config.logger = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };
      config.db = { ...(config.db as object), DefaultConnection: connection.Name, Connections: [connection] };
    }
  }

  const container = DI.child();
  container.register(SqliteConfiguration).as(Configuration);
  container.register(SqliteOrmDriver).as('orm-driver-sqlite');
  // Without a registration here, an Orm another test registered in the root container makes the root cache this one.
  container.register(Orm).asSelf();
  await container.resolve(Configuration);
  const orm = await container.resolve(Orm);
  return { container, driver: orm.Connections.get('default')!, dispose: () => orm.dispose() };
}

export async function clearMfaTables(driver: OrmDriver): Promise<void> {
  await rawQuery(driver, 'DELETE FROM authn_mfa', [], QueryContext.Delete);
  await rawQuery(driver, 'DELETE FROM authn_recovery_code', [], QueryContext.Delete);
}
