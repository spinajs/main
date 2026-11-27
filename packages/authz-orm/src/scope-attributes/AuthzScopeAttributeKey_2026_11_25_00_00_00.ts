import { randomUUID } from 'node:crypto';

import { AUTHZ_CONNECTION, AuthzConfigError } from '@spinajs/authz';
import { Migration, OrmMigration, sqlDialectOf } from '@spinajs/orm';
import type { ColumnQueryBuilder, OrmDriver, TableQueryBuilder } from '@spinajs/orm';

import { SCOPE_ATTRIBUTE_TABLE, SCOPE_ATTRIBUTE_VERSION_TABLE, scopeAttributeId } from './records.js';

const LEAF_INDEX = 'authz_scope_attribute_leaf';
const LEAF_COLUMNS = ['scope_type', 'scope_id', 'path'];
const ROW_COLUMNS = [...LEAF_COLUMNS, 'value_json', 'value_text', 'value_num', 'updated_by', 'updated_at'];
const PAGE = 500;
const BIN_0900 = 'utf8mb4_0900_bin';

/** A row as the driver returns it; the value columns are copied as they come. */
interface StoredRow extends Readonly<Record<string, unknown>> {
  readonly scope_type: string;
  readonly scope_id: string;
  readonly path: string;
}

interface Shape {
  /** One name per direction: Postgres keeps a primary key constraint under the name of the table it was created on. */
  readonly building: string;
  readonly keyed: boolean;
  readonly create: (table: TableQueryBuilder, collation: string | undefined) => void;
}

function valueColumns(table: TableQueryBuilder): void {
  table.string('value_json', 1024).notNull();
  table.string('value_text', 255);
  table.decimal('value_num', 20, 6);
  table.string('updated_by', 100);
  table.dateTime('updated_at').notNull();
}

const exact = (column: ColumnQueryBuilder, collation: string | undefined): ColumnQueryBuilder => (collation === undefined ? column : column.charset('utf8mb4').collation(collation));

const KEYED: Shape = {
  building: `${SCOPE_ATTRIBUTE_TABLE}_rebuilt`,
  keyed: true,
  create: (table, collation) => {
    exact(table.string('id', 64), collation).notNull().primaryKey();
    exact(table.string('scope_type', 64), collation).notNull();
    exact(table.string('scope_id', 64), collation).notNull();
    exact(table.string('path', 160), collation).notNull();
    valueColumns(table);
  },
};

/** The shape AuthzScopeAttribute_2026_10_02_00_00_00 creates, with the database's default collation. */
const BY_LEAF: Shape = {
  building: `${SCOPE_ATTRIBUTE_TABLE}_restored`,
  keyed: false,
  create: (table) => {
    table.string('scope_type', 64).notNull().primaryKey();
    table.string('scope_id', 64).notNull().primaryKey();
    table.string('path', 160).notNull().primaryKey();
    valueColumns(table);
  },
};

/**
 * MySQL's default collations fold case and accents, so `org:O1` would read the leaves of `org:o1`; the other dialects
 * compare text exactly. utf8mb4_0900_bin keeps trailing blanks apart as the 0900 default does; utf8mb4_bin, on servers
 * without it (5.7, MariaDB), pads them as their defaults do.
 */
async function exactCollation(connection: OrmDriver): Promise<string | undefined> {
  if (sqlDialectOf(connection.constructor as abstract new (...args: never[]) => unknown)?.grammar !== 'MySQL') return undefined;
  const found = await connection.select().from('COLLATIONS').database('information_schema').columns(['COLLATION_NAME']).where({ COLLATION_NAME: BIN_0900 }).asRaw<{ readonly COLLATION_NAME: string }[]>();
  return found.length > 0 ? BIN_0900 : 'utf8mb4_bin';
}

async function copyRows(connection: OrmDriver, to: Shape): Promise<void> {
  let offset = 0;
  let rows: StoredRow[];
  // spinajs-orm-ignore ORM102: pages through the table being rebuilt, one select per page of PAGE rows
  do {
    rows = await connection.select().from(SCOPE_ATTRIBUTE_TABLE).columns(ROW_COLUMNS).orderBy('scope_type').orderBy('scope_id').orderBy('path').skip(offset).take(PAGE).asRaw<StoredRow[]>();
    if (rows.length > 0) await connection.insert().into(to.building).values(rows.map((r) => (to.keyed ? { id: scopeAttributeId(r.scope_type, r.scope_id, r.path), ...r } : r)));
    offset += PAGE;
  } while (rows.length === PAGE);
}

/**
 * Every store write updates this row first (DbScopeAttributeStore.bump, in 3.x too), so another value after the copy
 * means a write the copy may have missed. Without the table or the row no store can write.
 */
async function versionOf(connection: OrmDriver): Promise<string | undefined> {
  if (!(await connection.schema().tableExists(SCOPE_ATTRIBUTE_VERSION_TABLE))) return undefined;
  const rows = await connection.select().from(SCOPE_ATTRIBUTE_VERSION_TABLE).columns(['version']).where({ id: 1 }).asRaw<{ readonly version: string }[]>();
  return rows.length === 0 ? undefined : rows[0].version;
}

/**
 * Replaces the version only while it still holds `version`. A second read would see committed values only; this UPDATE
 * waits for a writer whose transaction holds the row and then judges the value that writer committed.
 */
async function versionUnchanged(connection: OrmDriver, version: string): Promise<boolean> {
  const { RowsAffected } = await connection.update().in(SCOPE_ATTRIBUTE_VERSION_TABLE).update({ version: randomUUID(), updated_at: new Date() }).where({ id: 1, version });
  return RowsAffected === 1;
}

/**
 * The schema builder cannot change a primary key, so the table is rebuilt beside itself and renamed over. Every step
 * can run again after a failure: the old table is dropped only after the copy is complete.
 */
async function rebuild(connection: OrmDriver, to: Shape): Promise<void> {
  const schema = connection.schema();
  if (await schema.tableExists(SCOPE_ATTRIBUTE_TABLE)) {
    const columns = (await connection.tableInfo(SCOPE_ATTRIBUTE_TABLE, connection.Options.Database)).map((c) => c.Name);
    if (columns.includes('id') === to.keyed) return;
    const collation = to.keyed ? await exactCollation(connection) : undefined;
    await schema.dropTable(to.building).ifExists();
    await schema.createTable(to.building, (table) => to.create(table, collation));
    if (to.keyed) await connection.index().table(to.building).name(LEAF_INDEX).unique().columns(LEAF_COLUMNS);
    const version = to.keyed ? await versionOf(connection) : undefined;
    await copyRows(connection, to);
    if (version !== undefined && !(await versionUnchanged(connection, version))) throw new AuthzConfigError(`${SCOPE_ATTRIBUTE_TABLE} changed while it was copied: stop every writer, then run npx spinajs migrate-resolve --name AuthzScopeAttributeKey_2026_11_25_00_00_00 --rolled-back and npx spinajs migrate-up`);
    await schema.dropTable(SCOPE_ATTRIBUTE_TABLE);
  }
  if (await schema.tableExists(to.building)) {
    await schema.alterTable(to.building, (table) => {
      table.rename(SCOPE_ATTRIBUTE_TABLE);
    });
  }
}

/**
 * authz_scope_attribute gets the one key column `id` (scopeAttributeId) that the write capture and row history
 * need; scope_type, scope_id and path stay unique together (index authz_scope_attribute_leaf).
 */
@Migration(AUTHZ_CONNECTION)
export class AuthzScopeAttributeKey_2026_11_25_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await rebuild(connection, KEYED);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await rebuild(connection, BY_LEAF);
  }
}
