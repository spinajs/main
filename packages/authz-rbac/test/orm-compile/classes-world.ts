import { GLOBAL } from '@spinajs/authz';
import type { Principal, ResourceFilter } from '@spinajs/authz';
import { IdentifierQuoter, QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { expect } from 'chai';

import { RBAC_ASSIGNMENT_OP, RBAC_THRESHOLD_OP, parseRbacListArgs } from '../../src/index.js';
import type { RbacAssignmentArgsV2, RbacThresholdArgs } from '../../src/index.js';
import { RbacPathSql, RbacRulesSql, RbacScopeDefaults, ident, ormRbacScopeLayers, outer, rbacDialectOf, rsql } from '../../src/orm/index.js';
import type { RbacResourceField, RbacRulesSqlContext, RbacScopeLayer, RbacScopePath, RbacSql } from '../../src/orm/index.js';
import { rawQuery } from '../support/db.js';
import { RouteGraphSource, routeArgs, routeCurrent, thresholdArgs } from './route-world.js';
import type { RouteWorld } from './route-world.js';
import { select, three } from './rules-fixture.js';

/*
 * The class form of the rule list terms (S1, compile/classes.ts) against the per-row form, outside authz-orm: the
 * terms of a residual RouteWorld gives are compiled with `RbacRulesSql` over a table of this suite (more rows than
 * the world's docs, so classes hold several), with the world's model, rules and attributes, and run per row.
 */

/** Rows of the suite's table: `RouteWorld`'s doc columns, and `tenant`, which only a host `exists` reads. */
export const ROWS = 's1c_doc';
/** Project rows for the `exists` of a host layer (`tenantLayers`). */
export const NODES = 's1c_project';

/** The world's doc path as authz-orm reads it (`OrmRbacScopePathSource` of `RouteWorld`'s Doc). */
export const DOC_PATH: RbacScopePath = {
  type: 'doc',
  idColumn: 'id',
  idMode: 'number',
  scopes: [
    { column: 'project_id', scopeType: 'project', idMode: 'number' },
    { column: 'org_id', scopeType: 'org', idMode: 'string' },
  ],
  earlierKeys: [],
};

/** The string columns `resource.*` reads (as `rbacResourceFields` gives them for the world's Doc). */
export const FIELDS: readonly RbacResourceField[] = [
  { field: 'org_id', column: 'org_id' },
  { field: 'name', column: 'name' },
];

/** `numbers`: the type of the id and project columns; a DOUBLE PRECISION one may hold ids the adapter cannot find (10.5). */
export async function createTables(driver: OrmDriver, numbers: 'INT' | 'DOUBLE PRECISION' = 'INT'): Promise<void> {
  await rawQuery(driver, `CREATE TABLE "${ROWS}" ("id" ${numbers} PRIMARY KEY, "project_id" ${numbers}, "org_id" TEXT, "name" TEXT, "tenant" TEXT)`, [], QueryContext.Schema);
  await rawQuery(driver, `CREATE TABLE "${NODES}" ("id" INT PRIMARY KEY, "org_id" TEXT, "tenant" TEXT)`, [], QueryContext.Schema);
}

export async function dropTables(driver: OrmDriver, extra: readonly string[] = []): Promise<void> {
  for (const t of [ROWS, NODES, ...extra]) await rawQuery(driver, `DROP TABLE IF EXISTS "${t}"`, [], QueryContext.Schema);
}

/** A row of the suite's table: id, project, org, and optionally name and tenant. */
export type DocRow = readonly [id: number | string, project: number | string | null, org: string | null, name?: string | null, tenant?: string | null];

/** Replaces the rows of `table` (default the suite's table). */
export async function loadRows(driver: OrmDriver, rows: readonly DocRow[], table: string = ROWS): Promise<void> {
  await rawQuery(driver, `DELETE FROM "${table}"`, [], QueryContext.Delete);
  const values = rows.map(([id, project, org, name, tenant]) => ({ id, project_id: project, org_id: org, name: name ?? null, tenant: tenant ?? null }));
  for (let i = 0; i < values.length; i += 100)
    await driver
      .insert()
      .into(table)
      .values(values.slice(i, i + 100));
  await rawQuery(driver, `ANALYZE "${table}"`, [], QueryContext.Schema);
}

/**
 * The world's layers, with `project` read through `NODES` by an `exists` that also reads the row's `tenant` and
 * `org_id` (a host closure that depends on more than the node id, r3 N2).
 */
export function tenantLayers(driver: OrmDriver): Record<string, RbacScopeLayer> {
  const n = (c: string) => rsql`${ident('authz_np', c)}`;
  return {
    ...ormRbacScopeLayers(driver),
    project: { kind: 'adapter', attributes: [], exists: (nodeId) => rsql`EXISTS (SELECT 1 FROM ${ident(NODES)} ${ident('authz_np')} WHERE CAST(${n('id')} AS TEXT) = ${nodeId} AND ${n('tenant')} = ${outer('tenant')} AND ${n('org_id')} = ${outer('org_id')})` },
  };
}

export type Three = true | false | null;

/** A list term of a residual: its op and parsed args. */
export interface TermArgs {
  readonly name: string;
  readonly op: typeof RBAC_ASSIGNMENT_OP | typeof RBAC_THRESHOLD_OP;
  readonly args: RbacAssignmentArgsV2 | RbacThresholdArgs;
}

/** The terms `RbacRulesSql` compiles in `f` (route terms with rules or stored rules, every threshold term). */
export function termsOf(f: ResourceFilter): TermArgs[] {
  const out: TermArgs[] = [];
  for (const raw of routeArgs(f)) {
    const args = parseRbacListArgs(RBAC_ASSIGNMENT_OP, raw);
    if (args.rules.length > 0 || args.dbRules) out.push({ name: `route ${args.route.role}#${args.route.grant}`, op: RBAC_ASSIGNMENT_OP, args });
  }
  for (const raw of thresholdArgs(f)) {
    const args = parseRbacListArgs(RBAC_THRESHOLD_OP, raw);
    out.push({ name: 'rule' in args.threshold ? `threshold ${args.threshold.rule}` : 'threshold db', op: RBAC_THRESHOLD_OP, args });
  }
  return out;
}

export interface CompileOptions {
  /** The table the class form takes its representatives from and `compareForms` lists; default `ROWS`; null: none. */
  readonly rowTable?: string | null;
  readonly path?: RbacScopePath;
  readonly fields?: readonly RbacResourceField[];
  readonly layers?: Record<string, RbacScopeLayer>;
  /** The authz clock's time; default now. */
  readonly now?: Date;
  readonly testOnly?: RbacRulesSqlContext['testOnly'];
}

/** The term as `RbacListCompiler` builds it for the world's Doc model, its class form read from `options.rowTable`. */
export function compileTerm(world: RouteWorld, driver: OrmDriver, term: TermArgs, options: CompileOptions = {}): RbacSql {
  const dialect = rbacDialectOf(driver);
  const args = term.args;
  const sql = new RbacRulesSql({
    listing: new RouteGraphSource().listing(world.models.Doc)!,
    args,
    rowType: 'doc',
    path: new RbacPathSql(options.path ?? DOC_PATH, driver.Container.resolve(IdentifierQuoter), dialect),
    dialect,
    defaults: RbacScopeDefaults.of(routeCurrent.schemas ?? [], options.layers ?? ormRbacScopeLayers(driver)),
    fields: options.fields ?? FIELDS,
    now: options.now ?? new Date(),
    subjects: args.subjects.map((s) => ('set' in s ? { type: s.set.scope.type, id: s.set.scope.type === GLOBAL.type ? '' : s.set.scope.id ?? '', role: s.set.role } : { type: s.type, id: s.id, role: '' })),
    table: 'authz_assignment',
    ...(options.rowTable === null ? {} : { rowTable: options.rowTable ?? ROWS }),
    where: () => `s1 classes ${term.name}`,
    ...(options.testOnly ? { testOnly: options.testOnly } : {}),
  });
  if (term.op === RBAC_ASSIGNMENT_OP) return sql.route((args as RbacAssignmentArgsV2).route);
  const target = (args as RbacThresholdArgs).threshold;
  return 'rule' in target ? sql.threshold(target.rule) : sql.thresholdDb();
}

/** Each named term per row of `table` (outer alias `r`), three-valued, by row id text. */
export async function evaluate(driver: OrmDriver, terms: Readonly<Record<string, RbacSql>>, table: string = ROWS, where?: RbacSql): Promise<Map<string, Record<string, Three>>> {
  const names = Object.keys(terms);
  let columns = rsql`${outer('id')} AS ${ident('rid')}`;
  names.forEach((n, i) => (columns = rsql`${columns}, ${three(terms[n])} AS ${ident(`t${i}`)}`));
  const rows = await select(driver, rsql`SELECT ${columns} FROM ${ident(table)} r${where ? rsql` WHERE ${where}` : rsql``}`);
  const out = new Map<string, Record<string, Three>>();
  for (const row of rows) out.set(String(row.rid), Object.fromEntries(names.map((n, i) => [n, row[`t${i}`] === null || row[`t${i}`] === undefined ? null : Number(row[`t${i}`]) === 1])));
  return out;
}

/** κ of each row of `table` as one text, by row id text. */
export async function keysOf(driver: OrmDriver, keys: readonly RbacSql[], table: string = ROWS): Promise<Map<string, string>> {
  let columns = rsql`${outer('id')} AS ${ident('rid')}`;
  keys.forEach((k, i) => (columns = rsql`${columns}, ${k} AS ${ident(`k${i}`)}`));
  const rows = await select(driver, rsql`SELECT ${columns} FROM ${ident(table)} r`);
  return new Map(rows.map((row) => [String(row.rid), JSON.stringify(keys.map((_, i) => row[`k${i}`]))]));
}

export interface Compared {
  readonly term: TermArgs;
  /** The per-row form's value of each row, by id text. */
  readonly rows: Map<string, Three>;
  /** κ of each row; undefined when the class form was not chosen. */
  readonly keys?: Map<string, string>;
}

/**
 * Every term of `p`'s residual, per-row form against the class form with ASC and DESC representatives, row for
 * row three-valued (`expect`). Returns what each term gives per row and its class keys.
 */
export async function compareForms(world: RouteWorld, driver: OrmDriver, p: Principal, permission: string, options: CompileOptions = {}, why = ''): Promise<Compared[]> {
  const residual = await world.residual(p, permission);
  const table = options.rowTable ?? ROWS;
  const out: Compared[] = [];
  const now = options.now ?? new Date();
  for (const term of termsOf(residual)) {
    let keys: readonly RbacSql[] | undefined;
    const forms = {
      rows: compileTerm(world, driver, term, { ...options, now, testOnly: { rows: true } }),
      asc: compileTerm(world, driver, term, { ...options, now, testOnly: { order: 'asc', keys: (k) => (keys = k) } }),
      desc: compileTerm(world, driver, term, { ...options, now, testOnly: { order: 'desc' } }),
    };
    // One statement per form: three copies of a large term could pass the bound-value limit.
    const run = async (t: RbacSql) => new Map([...(await evaluate(driver, { t }, table))].map(([id, v]) => [id, v.t]));
    const rows = await run(forms.rows);
    const asc = await run(forms.asc);
    const desc = await run(forms.desc);
    const at = `${term.name} for ${p.type}:${p.id} ${permission}${why ? `, ${why}` : ''}: ${JSON.stringify(term.args)}`;
    for (const [id, v] of rows) {
      expect(asc.get(id), `row ${id}, class form (ASC) = per row, ${at}`).to.equal(v);
      expect(desc.get(id), `row ${id}, class form (DESC) = per row, ${at}`).to.equal(v);
    }
    out.push({ term, rows, ...(keys ? { keys: await keysOf(driver, keys, table) } : {}) });
  }
  return out;
}

/** The one term of `compared` whose name starts with `prefix`. */
export function termNamed(compared: readonly Compared[], prefix: string): Compared {
  const hits = compared.filter((c) => c.term.name.startsWith(prefix));
  expect(
    hits.map((c) => c.term.name),
    `one term named ${prefix}* of ${JSON.stringify(compared.map((c) => c.term.name))}`,
  ).to.have.length(1);
  return hits[0];
}

/** How many classes κ makes of `ids` (all rows when absent). */
export function classCount(keys: Map<string, string>, ids?: readonly (string | number)[]): number {
  return new Set((ids ?? [...keys.keys()]).map((id) => keys.get(String(id)))).size;
}
