import { AUTHZ_CONFIGURATION_SCHEMA } from '@spinajs/authz';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import '@spinajs/log';
import { Orm, QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
// The @Migration classes register at import: authz-rbac's tables (AuthzRbac_*, AuthzAdminIdempotency_*) and
// authz-orm's authz_scope_attribute (AuthzScopeAttribute_*).
import '@spinajs/authz-orm';
import '@spinajs/authz-rbac';

/** Every table the canvas load writes; authz_scope_attribute_version keeps its one row (the store only updates it). */
export const CANVAS_AUTHZ_TABLES = ['authz_rule_subject', 'authz_rule', 'authz_link', 'authz_assignment', 'authz_scope_attribute', 'authz_version', 'authz_admin_idempotency'] as const;

export interface CanvasDb {
  readonly orm: Orm;
  /** The connection the stores, the admin backend and the scope attribute store use ('default'). */
  readonly driver: OrmDriver;
  /** The child container the Orm was resolved in. */
  readonly container: IContainer;
  dispose(): Promise<void>;
}

const CONNECTION = { Name: 'k1-canvas', Driver: 'orm-driver-sqlite', Filename: ':memory:', Migration: { OnStartup: true } };

class CanvasDbConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    // Replaced, not merged: package configs must not add connections here.
    const config = this.Config as Record<string, unknown>;
    config.db = { ...(config.db as object), DefaultConnection: CONNECTION.Name, Connections: [CONNECTION] };
  }
}

/** `executeOnDb` lives on the SQL drivers, not on `OrmDriver`. */
export function rawQuery(driver: OrmDriver, sql: string, bindings: unknown[] = [], context: QueryContext = QueryContext.Select): Promise<any> {
  return (driver as unknown as { executeOnDb(sql: string, bindings: unknown[], context: QueryContext): Promise<any> }).executeOnDb(sql, bindings, context);
}

/** One SQLite `:memory:` database with the real authz migrations, in a DI child of root. */
export async function bootCanvasDb(): Promise<CanvasDb> {
  DI.setESMModuleSupport();
  const container = DI.child();
  // The test database boots as an app does: the core schema gives authz.admin.connection its default.
  container.register(AUTHZ_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  container.register(CanvasDbConfiguration).as(Configuration);
  container.register(SqliteOrmDriver).as('orm-driver-sqlite');
  await container.resolve(Configuration);
  const orm = (await container.resolve(Orm)) as Orm;
  return { orm, container, driver: orm.Connections.get('default')!, dispose: () => orm.dispose() };
}

export async function clearCanvasTables(driver: OrmDriver): Promise<void> {
  for (const table of CANVAS_AUTHZ_TABLES) await rawQuery(driver, `DELETE FROM ${table}`, [], QueryContext.Delete);
}

export async function countRows(driver: OrmDriver, table: string): Promise<number> {
  const rows = (await rawQuery(driver, `SELECT COUNT(*) AS n FROM ${table}`)) as { n: number | string }[];
  return Number(rows[0].n);
}
