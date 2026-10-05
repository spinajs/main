import { AccessDenied, AuthorizationModel, runWithPrincipal } from '@spinajs/authz';
import type { AuthzService, Principal, ResourceFilter } from '@spinajs/authz';
import { FAKE_TUPLE_OP, testHost } from '@spinajs/authz-testing';
import type { CombineConfig, FakeTupleSchema, Tuple } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IWhereBuilder, ModelBase } from '@spinajs/orm';

import { AccessResource, OrmNativeCompiler, Owner, ScopeColumn } from '../../src/index.js';
import { identifier, outerColumn, sql, whereSql } from '../../src/native.js';
import { relationPrincipalOf } from '../../src/principal.js';
import { entryOf } from '../../src/registry.js';
import { TestDb } from './db.js';
import type { Dialect } from './db.js';
import { allRows, sqlIds } from './residual.js';
import type { Model } from './residual.js';

export type ColumnKind = 'text' | 'int' | 'real' | 'bool';

export const SQL_TYPES: Readonly<Record<Dialect, Readonly<Record<ColumnKind, string>>>> = {
  sqlite: { text: 'TEXT', int: 'INTEGER', real: 'REAL', bool: 'BOOLEAN' },
  postgres: { text: 'TEXT', int: 'INTEGER', real: 'DOUBLE PRECISION', bool: 'BOOLEAN' },
};

/** An `@AccessResource` type as ORM tables: one model class (and table) per permission, whose select reads with that permission. */
export interface TableSpec {
  readonly type: string;
  readonly permissions: readonly string[];
  readonly columns: Readonly<Record<string, ColumnKind>>;
  /** The `@Owner` column. */
  readonly owner?: string;
  readonly scopeColumns?: readonly { readonly column: string; readonly scopeType: string }[];
}

export type Row = Readonly<Record<string, unknown>> & { readonly id: string };

const pk = (row: ModelBase): string => String((row as unknown as { id: unknown }).id);
const ids = (rows: readonly ModelBase[]): string[] => rows.map(pk).sort();

export class OrmTables {
  private constructor(private readonly db: TestDb, readonly spec: TableSpec, readonly dialect: Dialect, private readonly classes: ReadonlyMap<string, Model>) {}

  static async define(db: TestDb, spec: TableSpec, dialect: Dialect): Promise<OrmTables> {
    const classes = new Map<string, Model>();
    const columns = Object.fromEntries(Object.entries(spec.columns).map(([c, k]) => [c, SQL_TYPES[dialect][k]]));
    for (const permission of spec.permissions) {
      const cls = await db.define(
        {
          name: `B06${spec.type}`,
          columns,
          decorate: (model, proto) => {
            AccessResource(spec.type, { permissions: { read: permission } })(model);
            if (spec.owner !== undefined) Owner()(proto, spec.owner);
            for (const s of spec.scopeColumns ?? []) ScopeColumn(s.column, s.scopeType)(proto, s.column);
          },
        },
        dialect,
      );
      classes.set(permission, cls);
    }
    return new OrmTables(db, spec, dialect, classes);
  }

  classFor(permission: string): Model {
    const cls = this.classes.get(permission);
    if (cls === undefined) throw new Error(`OrmTables: no class reads ${this.spec.type} with ${permission}`);
    return cls;
  }

  /** Replaces the rows of every table of the type. */
  async load(rows: readonly Row[]): Promise<void> {
    for (const cls of this.classes.values()) await replaceRows(this.db, this.db.table(cls), this.dialect, this.dialect === 'sqlite' ? rows.map(sqliteRow) : rows);
  }

  /** The ids the middleware's select returns for the principal, or null when it throws AccessDenied. */
  async scoped(principal: Principal, permission: string): Promise<string[] | null> {
    try {
      return ids((await runWithPrincipal(principal, async () => (this.classFor(permission) as any).all())) as ModelBase[]);
    } catch (e) {
      if (e instanceof AccessDenied) return null;
      throw e;
    }
  }

  /** The ids a page of the middleware's select returns, ordered by id. */
  async page(principal: Principal, permission: string, limit: number, offset: number): Promise<string[]> {
    const rows = (await runWithPrincipal(principal, async () => (this.classFor(permission) as any).query().orderBy('id').take(limit).skip(offset))) as ModelBase[];
    return rows.map(pk);
  }
}

// node-sqlite3 binds a boolean as text; the orm writes 1 and 0.
export const sqliteRow = (row: Readonly<Record<string, unknown>>): Record<string, unknown> => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'boolean' ? (v ? 1 : 0) : v]));

/**
 * Deletes every row of the table and inserts `rows` in one statement (a missing key is NULL),
 * unscoped. On Postgres it also analyses the table: without statistics the planner estimates a
 * correlated sub-query high enough to JIT-compile it, which takes seconds per query.
 */
export async function replaceRows(db: TestDb, table: string, dialect: Dialect, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
  await db.raw(`DELETE FROM "${table}"`, [], dialect);
  if (rows.length > 0) {
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    let n = 0;
    const marks = rows.map(() => `(${keys.map(() => (dialect === 'postgres' ? `$${++n}` : '?')).join(', ')})`);
    const params = rows.flatMap((r) => keys.map((k) => r[k] ?? null));
    await db.raw(`INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES ${marks.join(', ')}`, params, dialect);
  }
  if (dialect === 'postgres') await db.raw(`ANALYZE "${table}"`, [], dialect);
}

// ---------------------------------------------------------------------------------------------
// native:fake.tuple

/** The tuples and the schema of the current world, as tables the compiler below reads. */
export class TupleTables {
  private constructor(private readonly db: TestDb, private readonly dialect: Dialect, private readonly tuples: Model, private readonly rules: Model) {}

  static async define(db: TestDb, dialect: Dialect): Promise<TupleTables> {
    const tuples = await db.define({ name: 'B06Tuple', columns: { object_type: 'TEXT', object_id: 'TEXT', relation: 'TEXT', subject_type: 'TEXT', subject_id: 'TEXT', subject_relation: 'TEXT' } }, dialect);
    const rules = await db.define({ name: 'B06TupleRule', columns: { type: 'TEXT', name: 'TEXT', kind: 'TEXT', a: 'TEXT', b: 'TEXT' } }, dialect);
    return new TupleTables(db, dialect, tuples, rules);
  }

  async load(tuples: readonly Tuple[], schema: FakeTupleSchema): Promise<void> {
    const tupleRows = tuples.map((t, i) => {
      const subject = 'object' in t.subject ? { subject_type: t.subject.object.type, subject_id: t.subject.object.id, subject_relation: t.subject.relation } : { subject_type: t.subject.type, subject_id: t.subject.id, subject_relation: null };
      return { id: `t${i}`, object_type: t.object.type, object_id: t.object.id, relation: t.relation, ...subject };
    });
    // The terms as FakeTupleModel parses them: 'relation' declares a relation, 'self' and 'arrow' are permission terms.
    const rules: Record<string, unknown>[] = [];
    for (const [type, ns] of Object.entries(schema)) {
      for (const name of Object.keys(ns.relations ?? {})) rules.push({ type, name, kind: 'relation', a: null, b: null });
      for (const [name, expr] of Object.entries(ns.permissions ?? {})) {
        for (const term of expr.split('|').map((x) => x.trim())) {
          const at = term.indexOf('->');
          rules.push(at < 0 ? { type, name, kind: 'self', a: term, b: null } : { type, name, kind: 'arrow', a: term.slice(0, at).trim(), b: term.slice(at + 2).trim() });
        }
      }
    }
    await replaceRows(this.db, this.db.table(this.tuples), this.dialect, tupleRows);
    await replaceRows(
      this.db,
      this.db.table(this.rules),
      this.dialect,
      rules.map((r, i) => ({ id: `r${i}`, ...r })),
    );
    current = { tuples: this.db.table(this.tuples), rules: this.db.table(this.rules) };
  }
}

// The compiler is one DI instance, so it reads the tables of the world loaded last: load one world at a time.
let current: { readonly tuples: string; readonly rules: string } | undefined;

/**
 * `native:fake.tuple` in SQL: a correlated EXISTS over a recursive walk of the tuples table. The
 * kit's FakeTupleModel walks forward from the row to the principal; this walks back from the
 * principal's direct tuples, through usersets, `self` terms and arrows, to every object#name that
 * reaches it. Both are the least fixpoint of the same rules. The walk here has no depth cap, so the
 * two agree while the graph stays within the model's maxDepth (the kit's tupleGraph keeps it there).
 */
export class B06TupleCompiler extends OrmNativeCompiler {
  readonly op = FAKE_TUPLE_OP;

  compile(args: unknown, builder: IWhereBuilder<unknown>, model: never): void {
    const { relation, principal } = args as { relation: string; principal: { type: string; id: string } };
    if (current === undefined) throw new Error('B06TupleCompiler: no tuple tables loaded');
    const type = entryOf(model)?.type;
    if (type === undefined) throw new Error('B06TupleCompiler: not an @AccessResource model');
    const T = identifier(current.tuples);
    const R = identifier(current.rules);
    const edges = sql`
      SELECT us.subject_type AS ft, us.subject_id AS fi, us.subject_relation AS fn, us.object_type AS t, us.object_id AS i, us.relation AS n
        FROM ${T} us JOIN ${R} ur ON ur.kind = 'relation' AND ur.type = us.object_type AND ur.name = us.relation
       WHERE us.subject_relation IS NOT NULL
      UNION ALL
      SELECT sr.type, NULL, sr.a, sr.type, NULL, sr.name FROM ${R} sr WHERE sr.kind = 'self'
      UNION ALL
      SELECT ax.subject_type, ax.subject_id, ar.b, ax.object_type, ax.object_id, ar.name
        FROM ${R} ar JOIN ${T} ax ON ax.object_type = ar.type AND ax.relation = ar.a
       WHERE ar.kind = 'arrow'`;
    whereSql(
      builder,
      sql`EXISTS (
        WITH RECURSIVE reach (t, i, n) AS (
          SELECT tp.object_type, tp.object_id, tp.relation
            FROM ${T} tp JOIN ${R} rl ON rl.kind = 'relation' AND rl.type = tp.object_type AND rl.name = tp.relation
           WHERE tp.subject_relation IS NULL AND tp.subject_type = ${principal.type} AND tp.subject_id = ${principal.id}
          UNION
          SELECT e.t, CASE WHEN e.fi IS NULL THEN reach.i ELSE e.i END, e.n
            FROM reach JOIN (${edges}) e ON e.ft = reach.t AND e.fn = reach.n AND (e.fi IS NULL OR e.fi = reach.i)
        )
        SELECT 1 FROM reach WHERE reach.t = ${type} AND reach.i = ${outerColumn(builder, 'id')} AND reach.n = ${relation}
      )`,
    );
  }
}

let compilerUsers = 0;

/** Registers the tuple compiler in root DI (the adapter's `compiles` reads it from there); the returned undo unregisters it once nobody uses it. */
export function useTupleCompiler(): () => void {
  if (compilerUsers++ === 0) DI.register(B06TupleCompiler).as(OrmNativeCompiler);
  return () => {
    if (--compilerUsers > 0) return;
    DI.unregister(B06TupleCompiler);
    DI.uncache(B06TupleCompiler);
    DI.uncache(OrmNativeCompiler);
  };
}

// ---------------------------------------------------------------------------------------------
// Domains and the agreement

let domainSeq = 0;

/** A test domain (child of root) running `models`, which the authz middleware scopes queries with. */
export async function bootDomain(models: readonly AuthorizationModel[], opts: { readonly permissions: Readonly<Record<string, unknown>>; readonly combine: CombineConfig }): Promise<{ service: AuthzService; dispose(): Promise<void> }> {
  const ds = await testHost.domains();
  const cfg = testHost.config();
  const name = `b06_${++domainSeq}`;
  const undo: (() => void)[] = [];
  const set = (path: string[], value: unknown) => {
    const before = cfg.get<unknown>(path);
    cfg.set(path, value);
    undo.push(() => (before === undefined ? cfg.unset(path) : cfg.set(path, before)));
  };
  set(['authz', 'domains', name], { permissions: opts.permissions, combine: opts.combine, cache: { maxEntries: 0 } });
  set(['authz', 'orm', 'domain'], name);
  const container = ds.create(name, 'root');
  const dispose = async () => {
    if (ds.names().includes(name)) await container.dispose();
    for (const fn of undo.splice(0).reverse()) fn();
  };
  try {
    for (const m of models) container.register(testHost.instance(m)).as(AuthorizationModel);
    return { service: (await ds.service(name)) as AuthzService, dispose };
  } catch (e) {
    await dispose();
    throw e;
  }
}

export interface Agreement {
  /** Row checks made. */
  checks: number;
  allowed: number;
  /** Selects the middleware refused with AccessDenied. */
  refused: number;
  /** Rows the check allows and the selects leave out, where only ⊆ is asserted (a sound-only leaf). */
  narrower: number;
  /** Row checks of intersect agents asserted ⇔ whose delegate's residual held no relation or native op. */
  intersectExact: number;
  /** Row checks of intersect agents asserted ⇔ whose delegate's residual held a relation or native op the engine strips. */
  intersectStripped: number;
  /** Row checks of intersect agents asserted ⇔ whose delegate's residual held a native op the engine keeps (`principalInArgs`). */
  intersectKept: number;
  /** Row checks of intersect agents the check allows. */
  intersectAllowed: number;
}

export const emptyAgreement = (): Agreement => ({ checks: 0, allowed: 0, refused: 0, narrower: 0, intersectExact: 0, intersectStripped: 0, intersectKept: 0, intersectAllowed: 0 });

interface PrincipalOps {
  kept: boolean;
  stripped: boolean;
}

const principalOps = (f: ResourceFilter, keep: ReadonlySet<string>, into: PrincipalOps = { kept: false, stripped: false }): PrincipalOps => {
  if (f.op === 'relation') into.stripped = true;
  else if (f.op.startsWith('native:')) (keep.has(f.op) ? (into.kept = true) : (into.stripped = true));
  else if (f.op === 'and' || f.op === 'or') for (const a of f.args) principalOps(a, keep, into);
  else if (f.op === 'not') principalOps(f.arg, keep, into);
  return into;
};

/**
 * The engine replaces `relation` and `native:*` in an intersect delegate's type-level residual
 * fail-closed (`stripPrincipalOps`), except natives whose filter declares `principalInArgs` (`keep`),
 * and a check with a subject also needs the row to pass that stripped residual, so the two agree either
 * way. The cases are counted apart to show the worlds reach them.
 */
async function delegateOps(service: AuthzService, p: Principal, permission: string, type: string, keep: ReadonlySet<string>): Promise<PrincipalOps> {
  if (p.onBehalfOf === undefined || p.delegation !== 'intersect') return { kept: false, stripped: false };
  return principalOps(await service.filter(p.onBehalfOf, permission, type), keep);
}

/**
 * For every principal and permission, and every row: `check` with the row as subject is allowed iff
 * the row is in the middleware's select and in the select of `service.filter` compiled to SQL. With
 * `sound` (residuals with conventions §5 "sound only" leaves) the two selects are equal and hold only
 * rows the check allows.
 */
export async function agree(service: AuthzService, tables: OrmTables, principals: readonly Principal[], opts: { readonly sound?: boolean; readonly keep?: ReadonlySet<string> } = {}, into: Agreement = emptyAgreement()): Promise<Agreement> {
  const type = tables.spec.type;
  for (const permission of tables.spec.permissions) {
    const cls = tables.classFor(permission);
    const rows = await allRows(cls);
    for (const principal of principals) {
      const who = `${tables.dialect} ${principal.type}:${principal.id} ${permission}`;
      const scoped = await tables.scoped(principal, permission);
      if (scoped === null) into.refused++;
      const residual: ResourceFilter = await service.filter(principal, permission, type);
      const filtered = new Set(await sqlIds(cls, residual, relationPrincipalOf(principal, service)));
      const listed = new Set(scoped ?? []);
      const ops = await delegateOps(service, principal, permission, type, opts.keep ?? new Set());
      const sound = opts.sound === true;
      // As in a request: the adapter keeps a row's ancestors for the request.
      const decisions = await runWithPrincipal(principal, async () => {
        const out = [];
        for (const row of rows) out.push(await service.check({ principal, permission, resource: { type, id: pk(row) }, subject: row }));
        return out;
      });
      for (const [k, row] of rows.entries()) {
        const id = pk(row);
        const d = decisions[k];
        const what = `${who} ${id}: check ${d.allowed}, residual ${JSON.stringify(residual)}, check residual ${JSON.stringify(d.residual)}`;
        if (listed.has(id) !== filtered.has(id)) throw new Error(`middleware select ${listed.has(id) ? 'lists' : 'leaves out'} the row (${scoped === null ? 'AccessDenied' : 'scoped'}), the filter in SQL does not: ${what}`);
        if (sound ? filtered.has(id) && !d.allowed : d.allowed !== filtered.has(id)) throw new Error(`the selects ${filtered.has(id) ? 'list' : 'leave out'} the row: ${what}`);
        if (d.residual.op !== 'true' && d.residual.op !== 'false') throw new Error(`a check with a subject left a residual: ${what}`);
        into.checks++;
        if (d.allowed) into.allowed++;
        if (d.allowed && !filtered.has(id)) into.narrower++;
        if (principal.delegation === 'intersect' && !sound) {
          if (ops.kept) into.intersectKept++;
          if (ops.stripped) into.intersectStripped++;
          if (!ops.kept && !ops.stripped) into.intersectExact++;
          if (d.allowed) into.intersectAllowed++;
        }
      }
    }
  }
  return into;
}
