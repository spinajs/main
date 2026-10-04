import { GLOBAL, resourceKey } from '@spinajs/authz';
import type { EvaluationContext, ResourceRef } from '@spinajs/authz';
import { IdentifierQuoter, QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { expect } from 'chai';

import { resourcePath } from '../../src/model/evaluate.js';
import { scopeMatcher } from '../../src/model/native.js';
import { scopeFromColumns } from '../../src/stores/columns.js';
import { RbacPathSql, ident, notSql, outer, renderSql, rsql } from '../../src/orm/index.js';
import type { RbacScopePath, RbacSql } from '../../src/orm/index.js';
import { bootPostgres, bootSqlite } from '../orm/fixture.js';
import type { BootedDb } from '../orm/fixture.js';
import { rawQuery } from '../support/db.js';

export type Cell = string | number | null;
export type Row = Readonly<Record<string, Cell>>;

export interface ScopeRow {
  readonly id: number;
  readonly scope_type: string | null;
  readonly scope_id: string | null;
}

/** Rows of a scoped table, candidate scopes in a scope table, and the path that reads the rows. */
export interface World {
  readonly path: RbacScopePath;
  readonly table: string;
  readonly scopeTable: string;
  readonly rows: readonly Row[];
  readonly scopes: readonly ScopeRow[];
}

export type Dialect = readonly [name: string, boot: () => Promise<BootedDb | null>];

export const DIALECTS: readonly Dialect[] = [
  ['sqlite', bootSqlite],
  ['postgres', bootPostgres],
];

/** Boots the dialect; postgres skips the suite when unreachable, or fails it under L2_REQUIRE_PG=1. */
export async function bootDialect(ctx: Mocha.Context, [name, boot]: Dialect): Promise<BootedDb> {
  const db = await boot();
  if (db) return db;
  if (process.env.L2_REQUIRE_PG === '1') throw new Error(`L2_REQUIRE_PG=1 but ${name} at 127.0.0.1:15432 is unreachable`);
  console.warn(`    skipped: ${name} is unreachable (set L2_REQUIRE_PG=1 to fail instead)`);
  ctx.skip();
}

export const OUTER = 'r';

/** Runs a whole statement built as a fragment; `outer(column)` names the row of the scoped table under alias `r`. */
export async function select(driver: OrmDriver, statement: RbacSql): Promise<Array<Record<string, unknown>>> {
  const quoter = driver.Container.resolve(IdentifierQuoter);
  const { text, bindings } = renderSql(statement, { driver, outer: (column) => `${quoter.quote(OUTER)}.${quoter.quote(column)}`, outerName: OUTER });
  return (await rawQuery(driver, text, [...bindings])) as Array<Record<string, unknown>>;
}

export async function load(driver: OrmDriver, world: World): Promise<void> {
  const quoter = driver.Container.resolve(IdentifierQuoter);
  for (const table of [world.table, world.scopeTable]) await rawQuery(driver, `DELETE FROM ${quoter.quote(table)}`, [], QueryContext.Delete);
  if (world.rows.length > 0)
    await driver
      .insert()
      .into(world.table)
      .values(world.rows.map((r) => ({ ...r })));
  if (world.scopes.length > 0)
    await driver
      .insert()
      .into(world.scopeTable)
      .values(world.scopes.map((s) => ({ ...s })));
  // Without statistics postgres guesses large tables, prices the cross joins high and JIT-compiles
  // the CASE blocks, about half a second per query.
  for (const table of [world.table, world.scopeTable]) await rawQuery(driver, `ANALYZE ${quoter.quote(table)}`, [], QueryContext.Schema);
}

// ---- reference: the evaluator's own functions ----

/** The row's path as the evaluator builds it: `resourcePath` over the ancestors authz-orm's adapter gives (a NULL column is no ancestor). */
export async function evaluatorPath(path: RbacScopePath, row: Row): Promise<readonly ResourceRef[]> {
  const ref: ResourceRef = { type: path.type, id: String(row[path.idColumn]) };
  const ancestors: ResourceRef[] = [ref];
  for (const s of path.scopes) {
    const value = row[s.column];
    if (value !== null && value !== undefined) ancestors.push({ type: s.scopeType, id: String(value) });
  }
  ancestors.push(GLOBAL);
  return resourcePath(ref, { ancestors: async () => ancestors } as unknown as EvaluationContext);
}

/** The scope a scope-table row names, as the stores read it back. The §9.1 columns are NOT NULL; a NULL here names no scope. */
export const scopeOf = (x: ScopeRow): ResourceRef | null => (x.scope_type === null || x.scope_id === null ? null : scopeFromColumns(x.scope_type, x.scope_id));

/** The rule steps' `index.get(resourceKey(scope))`. */
export function evaluatorIndex(path: readonly ResourceRef[], scope: ResourceRef | null): number | undefined {
  if (scope === null) return undefined;
  const index = new Map(path.map((n, i) => [resourceKey(n), i]));
  return index.get(resourceKey(scope));
}

/** Node `i` of `RbacPathSql.nodes` as the adapter would give it for this row; null when its column is NULL. */
export function staticNode(path: RbacScopePath, row: Row, i: number): ResourceRef | null {
  if (i === 0) return { type: path.type, id: String(row[path.idColumn]) };
  if (i === path.scopes.length + 1) return GLOBAL;
  const s = path.scopes[i - 1];
  const value = row[s.column];
  return value === null || value === undefined ? null : { type: s.scopeType, id: String(value) };
}

interface RowRef {
  readonly row: Row;
  readonly id: string;
  readonly path: readonly ResourceRef[];
}

async function rowRefs(world: World): Promise<RowRef[]> {
  const out: RowRef[] = [];
  for (const row of world.rows) out.push({ row, id: String(row[world.path.idColumn]), path: await evaluatorPath(world.path, row) });
  return out;
}

// ---- block checks: SQL result set = reference, and NOT (block) = its complement ----

const sorted = (s: Iterable<string>): string[] => [...s].sort();

const fromRowAnd = (world: World, aliases: readonly string[]): RbacSql => {
  // The outer alias is plain text: as an ident() renderSql would refuse it, being the outer name.
  let from = rsql`FROM ${ident(world.table)} r`;
  for (const a of aliases) from = rsql`${from}, ${ident(world.scopeTable)} ${ident(a)}`;
  return from;
};

async function tuples(driver: OrmDriver, world: World, aliases: readonly string[], block: RbacSql): Promise<Set<string>> {
  let columns = rsql`${outer(world.path.idColumn)} AS rid`;
  aliases.forEach((a, i) => (columns = rsql`${columns}, ${ident(a, 'id')} AS ${ident(`s${i}`)}`));
  const rows = await select(driver, rsql`SELECT ${columns} ${fromRowAnd(world, aliases)} WHERE ${block}`);
  return new Set(rows.map((r) => [r.rid, ...aliases.map((_, i) => r[`s${i}`])].map(String).join('/')));
}

/** Compares a predicate over (row, x) or (row, a, x) with the reference, and its NOT with the complement (two-valued). */
async function expectPredicate(driver: OrmDriver, world: World, name: string, aliases: readonly string[], block: RbacSql, holds: (r: RowRef, scopes: readonly ScopeRow[]) => boolean): Promise<number> {
  const want: string[] = [];
  const rest: string[] = [];
  const refs = await rowRefs(world);
  const combos: ScopeRow[][] = aliases.reduce<ScopeRow[][]>((acc) => acc.flatMap((c) => world.scopes.map((s) => [...c, s])), [[]]);
  for (const r of refs) {
    for (const c of combos) (holds(r, c) ? want : rest).push([r.id, ...c.map((s) => s.id)].join('/'));
  }
  expect(sorted(await tuples(driver, world, aliases, block)), name).to.deep.equal(sorted(want));
  expect(sorted(await tuples(driver, world, aliases, notSql(block))), `NOT (${name})`).to.deep.equal(sorted(rest));
  return want.length;
}

export interface BlockCheck {
  readonly name: string;
  /** Runs the check on the loaded world; returns how many tuples the block holds for (non-vacuity). */
  run(driver: OrmDriver, world: World): Promise<number>;
}

const blocks = (driver: OrmDriver, world: World): RbacPathSql => new RbacPathSql(world.path, driver.Container.resolve(IdentifierQuoter));

export const CHECK_AT_NODE: BlockCheck = {
  name: 'atNode(x, i) holds when node i of the row is the scope x names',
  async run(driver, world) {
    const p = blocks(driver, world);
    let n = 0;
    for (let i = 0; i < p.nodes.length; i++) {
      n += await expectPredicate(driver, world, `atNode(x, ${i})`, ['x'], p.atNode('x', i), (r, [x]) => {
        const node = staticNode(world.path, r.row, i);
        const scope = scopeOf(x);
        return node !== null && scope !== null && resourceKey(node) === resourceKey(scope);
      });
    }
    return n;
  },
};

export const CHECK_PATH_INDEX: BlockCheck = {
  name: "pathIndex(x) names x's node in the evaluator's order, NULL off the path",
  async run(driver, world) {
    const p = blocks(driver, world);
    const rows = await select(driver, rsql`SELECT ${outer(world.path.idColumn)} AS rid, ${ident('x', 'id')} AS xid, ${p.pathIndex('x')} AS px ${fromRowAnd(world, ['x'])}`);
    const got = new Map(rows.map((r) => [`${String(r.rid)}/${String(r.xid)}`, r.px === null ? null : Number(r.px)]));
    let n = 0;
    for (const r of await rowRefs(world)) {
      const seen: Array<{ x: ScopeRow; px: number; ei: number }> = [];
      for (const x of world.scopes) {
        const px = got.get(`${r.id}/${x.id}`);
        const ei = evaluatorIndex(r.path, scopeOf(x));
        const at = JSON.stringify({ row: r.row, x, px, ei });
        expect(px, `pathIndex ${at}`).to.not.equal(undefined);
        expect(px === null, `pathIndex is NULL exactly off the path ${at}`).to.equal(ei === undefined);
        if (px === null || px === undefined || ei === undefined) continue;
        const node = staticNode(world.path, r.row, px);
        expect(node, `pathIndex names a node of the row ${at}`).to.not.equal(null);
        expect(evaluatorIndex(r.path, node), `pathIndex names x's node ${at}`).to.equal(ei);
        for (let j = 0; j < px; j++) {
          const nearer = staticNode(world.path, r.row, j);
          expect(nearer !== null && resourceKey(nearer) === resourceKey(node!), `pathIndex names the nearest occurrence of x's node ${at}`).to.equal(false);
        }
        seen.push({ x, px, ei });
        n++;
      }
      for (const a of seen) for (const b of seen) expect(Math.sign(a.px - b.px), `pathIndex keeps the evaluator's order ${JSON.stringify({ row: r.row, a, b })}`).to.equal(Math.sign(a.ei - b.ei));
    }
    return n;
  },
};

export const CHECK_ON_PATH_NODE: BlockCheck = {
  name: 'onPathNode(x) holds when x is a node of the evaluator path',
  run: (driver, world) => expectPredicate(driver, world, 'onPathNode(x)', ['x'], blocks(driver, world).onPathNode('x'), (r, [x]) => evaluatorIndex(r.path, scopeOf(x)) !== undefined),
};

export const CHECK_ON_PATH: BlockCheck = {
  name: 'onPath(x) holds when scopeMatcher accepts x',
  run: (driver, world) =>
    expectPredicate(driver, world, 'onPath(x)', ['x'], blocks(driver, world).onPath('x'), (r, [x]) => {
      const scope = scopeOf(x);
      return scope !== null && scopeMatcher(world.path.type, r.path)(scope);
    }),
};

export const CHECK_BELOW: BlockCheck = {
  name: "below(a, x) holds when x is a node strictly below a's node",
  run: (driver, world) =>
    expectPredicate(driver, world, 'below(a, x)', ['a', 'x'], blocks(driver, world).below('a', 'x'), (r, [a, x]) => {
      const ia = evaluatorIndex(r.path, scopeOf(a));
      const ix = evaluatorIndex(r.path, scopeOf(x));
      return ia !== undefined && ix !== undefined && ix < ia;
    }),
};

export const CHECK_NOT_ABOVE: BlockCheck = {
  name: 'notAbove(a, n) holds when restrict at n keeps an assignment at a',
  run: (driver, world) =>
    expectPredicate(driver, world, 'notAbove(a, n)', ['a', 'n'], blocks(driver, world).notAbove('a', 'n'), (r, [a, n]) => {
      // applyRestrict: a rule whose scope is no node does not apply; `index.get(a)! <= at` is false for an undefined index.
      const at = evaluatorIndex(r.path, scopeOf(n));
      const ia = evaluatorIndex(r.path, scopeOf(a));
      return at !== undefined && ia !== undefined && ia <= at;
    }),
};

export function checkNearestId(types: readonly string[]): BlockCheck {
  return {
    name: 'nearestId(type) is the id of the nearest node of that type, NULL when none',
    async run(driver, world) {
      const p = blocks(driver, world);
      let columns = rsql`${outer(world.path.idColumn)} AS rid`;
      types.forEach((t, i) => (columns = rsql`${columns}, ${p.nearestId(t)} AS ${ident(`n${i}`)}`));
      const rows = await select(driver, rsql`SELECT ${columns} ${fromRowAnd(world, [])}`);
      const got = new Map(rows.map((r) => [String(r.rid), r]));
      let n = 0;
      for (const r of await rowRefs(world)) {
        types.forEach((t, i) => {
          const want = r.path.find((node) => node.type === t && node.id != null)?.id ?? null;
          if (want !== null) n++;
          expect(got.get(r.id)?.[`n${i}`], `nearestId(${t}) ${JSON.stringify(r.row)}`).to.equal(want);
        });
      }
      return n;
    },
  };
}
