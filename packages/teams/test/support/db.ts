import '@spinajs/log';
import '@spinajs/orm-sqlite';

import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { Orm, OrmMigrationGuard, OrmMigrator } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
// Side-effect imports: the migrations and the models register themselves, and must before the Orm resolves.
import '@spinajs/authz-abac';
import '@spinajs/authz-orm';
import '@spinajs/authz-orm/audit';
import '@spinajs/authz-rbac';
import '../../src/index.js';
import './project.js';

export interface TeamsDb {
  readonly orm: Orm;
  readonly driver: OrmDriver;
  rows(table: string, where?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

const SILENT_LOGGER = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };

let opened: Promise<TeamsDb> | undefined;
const closers: (() => Promise<void>)[] = [];

/** Runs before the database closes, last registered first. */
export function onClose(fn: () => Promise<void>): void {
  closers.push(fn);
}

async function open(): Promise<TeamsDb> {
  const cfg = await testHost.installHost();
  cfg.set('logger', SILENT_LOGGER);
  cfg.set('db', { DefaultConnection: 'sqlite', Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite' }], Aliases: { authz: 'default' }, StrictTableCheck: false });
  // test_projects has no migration: it is created after, and the boot cannot require it.
  const { orm } = await migrateTestDatabase();
  const driver = orm.Connections.get('default');
  if (!driver) throw new Error('teams test db: no connection default');
  await driver.schema().createTable('test_projects', (table) => {
    table.string('id', 36).notNull().primaryKey();
    table.string('team_id', 36).notNull();
    table.string('name', 128).notNull();
  });
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
  DI.RootContainer.uncache(OrmMigrator);
  DI.RootContainer.uncache(OrmMigrationGuard);
  await db.orm.dispose();
  await testHost.uninstallHost();
  opened = undefined;
});
