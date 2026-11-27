import { InvalidArgument } from '@spinajs/exceptions';
import { extractModelDescriptor } from '@spinajs/orm';

import { rlsModels, tenantModelOf } from './registry.js';

/** The transaction-local settings `TenantSessionSettings` sends and the tenant policy reads. */
export const TENANT_RLS_SETTINGS = Object.freeze({
  /** The tenant id of the scope; '' across tenants. */
  tenant: 'spina.tenant',
  /** 'on' across tenants; the policy honours it for members of the bypass role only. */
  all: 'spina.tenant_all',
} as const);

export const TENANT_ISOLATION_POLICY = 'spina_tenant_isolation';
export const TENANT_OPEN_POLICY = 'spina_tenant_open';

export interface TenantRlsTable {
  readonly table: string;
  readonly column: string;
  /** The model's `@Connection`, as written there. */
  readonly connection: string;
}

export interface TenantRlsOptions {
  /** The database role the all-tenants scope lets through; without it that scope sees no row of the table. */
  readonly bypassRole?: string;
}

export interface TenantRlsOutput {
  readonly up: readonly string[];
  readonly down: readonly string[];
}

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const setting = (name: string): string => `current_setting(${literal(name)}, true)`;

function isolation(t: TenantRlsTable, options: TenantRlsOptions): string {
  // A transaction-local setting reads '' once a transaction that set it has ended, NULL before: both match no row.
  const own = `${ident(t.table)}.${ident(t.column)} = NULLIF(${setting(TENANT_RLS_SETTINGS.tenant)}, '')`;
  if (options.bypassRole === undefined) return own;
  return `(${own} OR (${setting(TENANT_RLS_SETTINGS.all)} = 'on' AND pg_has_role(${literal(options.bypassRole)}, 'MEMBER')))`;
}

/**
 * Under FORCE a row needs a permissive policy too. This one grants while the table has no other permissive policy (an
 * `authz:rls` one, say), in whichever order the two migrations ran.
 */
function alone(regclass: string): string {
  return `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = ${regclass} AND p.polpermissive AND p.polname <> ${literal(TENANT_OPEN_POLICY)})`;
}

/** The row level security of one row-mode tenant table on PostgreSQL or PGlite. */
export function tenantRlsStatements(t: TenantRlsTable, options: TenantRlsOptions = {}): TenantRlsOutput {
  // down runs inside a dollar-quoted block, which a '$' in the name could end
  if (t.table === '' || t.table.includes('$') || t.column === '') {
    throw new InvalidArgument(`tenant:rls: cannot write row level security for table ${JSON.stringify(t.table)}, column ${JSON.stringify(t.column)}`);
  }
  const table = ident(t.table);
  const regclass = `${literal(table)}::regclass`;
  const check = isolation(t, options);
  const open = alone(regclass);
  return {
    up: [
      `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
      // The grant goes first and comes back last: without it the table shows no row, with it alone every row.
      `DROP POLICY IF EXISTS ${ident(TENANT_OPEN_POLICY)} ON ${table}`,
      `DROP POLICY IF EXISTS ${ident(TENANT_ISOLATION_POLICY)} ON ${table}`,
      `CREATE POLICY ${ident(TENANT_ISOLATION_POLICY)} ON ${table} AS RESTRICTIVE FOR ALL USING (${check}) WITH CHECK (${check})`,
      `CREATE POLICY ${ident(TENANT_OPEN_POLICY)} ON ${table} AS PERMISSIVE FOR ALL USING (${open}) WITH CHECK (${open})`,
    ],
    down: [
      `DROP POLICY IF EXISTS ${ident(TENANT_OPEN_POLICY)} ON ${table}`,
      `DROP POLICY IF EXISTS ${ident(TENANT_ISOLATION_POLICY)} ON ${table}`,
      // Another package's policies keep the table under row level security.
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = ${regclass}) THEN ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY; ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY; END IF; END $$`,
    ],
  };
}

export function generateTenantRls(tables: readonly TenantRlsTable[], options: TenantRlsOptions = {}): TenantRlsOutput {
  const up: string[] = [];
  const down: string[] = [];
  for (const t of tables) {
    const out = tenantRlsStatements(t, options);
    up.push(...out.up);
    down.unshift(...out.down);
  }
  return { up, down };
}

/** One entry per table and connection of a row-mode tenant model with `rls`. */
export function tenantRlsTables(): TenantRlsTable[] {
  const out = new Map<string, TenantRlsTable>();
  for (const model of rlsModels()) {
    const entry = tenantModelOf(model);
    // A schema-mode table holds one tenant and has no column to compare.
    if (entry === undefined || entry.isolation !== 'row' || !entry.rls || entry.table === '') continue;
    const connection = extractModelDescriptor(model)?.Connection ?? 'default';
    const key = JSON.stringify([connection, entry.table]);
    const seen = out.get(key);
    if (seen !== undefined && seen.column !== entry.column) {
      throw new InvalidArgument(`tenant:rls: table ${entry.table} on connection ${connection} is mapped with two tenant columns, ${seen.column} and ${entry.column}`);
    }
    out.set(key, { table: entry.table, column: entry.column, connection });
  }
  return [...out.values()];
}

/** The migration file for `output`: a class `className` on `connection`. */
export function tenantRlsMigrationSource(output: TenantRlsOutput, className: string, connection: string): string {
  const list = (statements: readonly string[]): string => statements.map((s) => `  ${JSON.stringify(s)},`).join('\n');
  return [
    '// Generated by `spinajs tenant:rls`. Regenerate it after a tenant model changes instead of editing it.',
    "import { Migration, OrmMigration } from '@spinajs/orm';",
    "import type { OrmDriver } from '@spinajs/orm';",
    '',
    `const UP = [\n${list(output.up)}\n];`,
    '',
    `const DOWN = [\n${list(output.down)}\n];`,
    '',
    `@Migration(${JSON.stringify(connection)})`,
    `export class ${className} extends OrmMigration {`,
    '  public async up(connection: OrmDriver): Promise<void> {',
    '    for (const sql of UP) await connection.schema().raw(sql);',
    '  }',
    '',
    '  public async down(connection: OrmDriver): Promise<void> {',
    '    for (const sql of DOWN) await connection.schema().raw(sql);',
    '  }',
    '}',
    '',
  ].join('\n');
}
