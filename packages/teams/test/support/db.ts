import '@spinajs/log';
import '@spinajs/orm-sqlite';

import { AuthzAbac_2026_10_01_00_00_00 } from '@spinajs/authz-abac';
import { AuthzResourceAncestor_2026_10_14_00_00_00, AuthzScopeAttribute_2026_10_02_00_00_00 } from '@spinajs/authz-orm';
import { AuthzAudit_2026_10_01_00_00_00 } from '@spinajs/authz-orm/audit';
import { AuthzAdminIdempotency_2026_10_02_00_01_00, AuthzRbac_2026_10_01_00_00_00 } from '@spinajs/authz-rbac';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import type { OrmDriver, OrmMigration } from '@spinajs/orm';

// Imported before the Orm resolves: the decorators register the models under '__models__'.
import { Teams_2026_10_14_00_00_00, TeamsInvitations_2026_10_14_00_01_00 } from '../../src/index.js';
import './project.js';

export interface TeamsDb {
  readonly orm: Orm;
  readonly driver: OrmDriver;
  rows(table: string, where?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

const SILENT_LOGGER = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };

/** Run in order on connection `default` (the authz stores, the ancestor table and the teams tables share it). */
export const MIGRATIONS: (new () => OrmMigration)[] = [
  AuthzRbac_2026_10_01_00_00_00,
  AuthzAdminIdempotency_2026_10_02_00_01_00,
  AuthzAbac_2026_10_01_00_00_00,
  AuthzScopeAttribute_2026_10_02_00_00_00,
  AuthzAudit_2026_10_01_00_00_00,
  AuthzResourceAncestor_2026_10_14_00_00_00,
  Teams_2026_10_14_00_00_00,
  TeamsInvitations_2026_10_14_00_01_00,
];

let opened: Promise<TeamsDb> | undefined;
const closers: (() => Promise<void>)[] = [];

/** Runs before the database closes, last registered first. */
export function onClose(fn: () => Promise<void>): void {
  closers.push(fn);
}

async function open(): Promise<TeamsDb> {
  const cfg = await testHost.installHost();
  cfg.set('logger', SILENT_LOGGER);
  // Migration.OnStartup stays off: the list above runs by hand, so no other imported package's migration runs.
  cfg.set('db', { DefaultConnection: 'sqlite', Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite' }] });
  const orm = (await DI.resolve(Orm)) as Orm;
  const driver = orm.Connections.get('default');
  if (!driver) throw new Error('teams test db: no connection default');
  for (const M of MIGRATIONS) await new M().up(driver);
  await driver.schema().createTable('test_projects', (table) => {
    table.string('id', 36).notNull().primaryKey();
    table.string('team_id', 36).notNull();
    table.string('name', 128).notNull();
  });
  // The Orm read the table info before the tables existed.
  await orm.reloadTableInfo();
  return {
    orm,
    driver,
    rows: async (table, where = {}) => (await driver.select().from(table).where(where)) as Record<string, unknown>[],
  };
}

/** One in-memory database per mocha process, shared by every test file. */
export function teamsDb(): Promise<TeamsDb> {
  return (opened ??= open());
}

// A root hook: it runs once, after every test file.
after(async function () {
  this.timeout(60000);
  if (!opened) return;
  const db = await opened;
  for (const fn of closers.splice(0).reverse()) await fn();
  DI.RootContainer.uncache(Orm);
  await db.orm.dispose();
  await testHost.uninstallHost();
  opened = undefined;
});
