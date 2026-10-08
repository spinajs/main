import { AccessDenied, CORE_FILTER_OPS, runWithPrincipal } from '@spinajs/authz';
import type { Permission, Principal, ResourceRef, ResourceType } from '@spinajs/authz';
import { FAKE_TUPLE_OP, hostHarness } from '@spinajs/authz-testing';
import type { BehaviourHarness, FakeRow, HarnessSession, OrmHandle, OrmModelSpec, OrmQuery, OrmResult, OrmScopeSpec, SqlPagesHandle, World } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { BelongsTo, DeleteQueryBuilder, HasManyToMany, ManyToManyRelationList, createQuery } from '@spinajs/orm';
import type { IWhereBuilder, InsertQueryBuilder, ModelBase, OrmDriver, UpdateQueryBuilder } from '@spinajs/orm';

import { OrmResourceAdapter } from '../../src/adapter.js';
import { AccessResource, OrmScope, OrmScopePolicy, Owner, ScopeColumn } from '../../src/index.js';
import { entryOf } from '../../src/registry.js';
import { findRow } from '../../src/rows.js';
import { OrmTables, SQL_TYPES, TupleTables, replaceRows, sqliteRow, useTupleCompiler } from './b06.js';
import type { ColumnKind, Row, TableSpec } from './b06.js';
import type { Dialect, TestDb } from './db.js';
import type { Model } from './residual.js';

const fail = (what: string): never => {
  throw new Error(`ormHarness: ${what}`);
};

const pk = (row: ModelBase): string => String((row as unknown as { id: unknown }).id);

function columnKind(values: readonly unknown[], what: string): ColumnKind {
  const kinds = new Set(values.filter((v) => v !== null && v !== undefined).map((v) => (typeof v === 'boolean' ? 'bool' : typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'real') : typeof v === 'string' ? 'text' : 'other')));
  if (kinds.has('other') || (kinds.size > 1 && !(kinds.size === 2 && kinds.has('int') && kinds.has('real')))) fail(`${what} holds values of several types`);
  return kinds.has('real') ? 'real' : (kinds.values().next().value as ColumnKind | undefined) ?? 'text';
}

const usesTuple = (world: World): boolean => (world.models ?? []).some((m) => m.kind === 'fake-tuple') || (world.adapters ?? []).some((a) => (a.compiles ?? []).includes(FAKE_TUPLE_OP));

// ---------------------------------------------------------------------------------------------
// Kit worlds with one FakeAdapter (B06): its rows as ORM tables

const MAPPED_OPS = new Set<string>([...CORE_FILTER_OPS, FAKE_TUPLE_OP]);

/** The world's permissions of `type`: a permission's `types` when it names them, else its `<type>:` prefix. */
function permissionsOf(world: World, type: string): string[] {
  return world.permissions.flatMap((p) => {
    const name = typeof p === 'string' ? p : p.name;
    const types = typeof p === 'string' ? undefined : (p as { types?: readonly string[] }).types;
    return (types ? types.includes(type) : name.startsWith(`${type}:`)) ? [name] : [];
  });
}

/**
 * The ORM tables a kit world's single adapter describes, and their rows. What it cannot map throws
 * rather than run another world: several adapters or types, adapter attributes or permission defs,
 * world-level relations or scope resolvers, ops beyond the core and native:fake.tuple, a compiles
 * list narrower than the ORM adapter's, a relation other than an owner column, several owner
 * columns, a parent that has a parent itself, a column of several value types.
 */
export function tablesOf(world: World): { spec: TableSpec; rows: Row[] } {
  const adapters = world.adapters ?? [];
  if (adapters.length !== 1 || adapters[0].types.length !== 1) fail('a world needs one adapter with one type');
  if ((world.relations ?? []).length > 0 || (world.scopes ?? []).length > 0) fail('world-level relations and scope resolvers do not map to the ORM');
  const a = adapters[0];
  const type = a.types[0];
  if (a.attributes !== undefined || a.permissions !== undefined) fail('adapter attributes and permission defs do not map to the ORM');
  // FakeAdapter's default when the key is absent.
  const compiles = 'compiles' in a ? a.compiles : CORE_FILTER_OPS;
  if (compiles === undefined) fail('an adapter that is not list-scoped does not map to the ORM');
  for (const op of compiles!) if (!MAPPED_OPS.has(op)) fail(`op ${op} has no compiler here`);
  // A narrower list makes the kit adapter refuse residuals at boot (B05 rule 4) that the ORM adapter accepts.
  const missing = [...CORE_FILTER_OPS, ...(usesTuple(world) ? [FAKE_TUPLE_OP] : [])].filter((op) => !compiles!.includes(op));
  if (missing.length > 0) fail(`the adapter compiles fewer ops than the ORM adapter (not ${missing.join(', ')}), so the world would boot here where the kit refuses it`);
  const source = a.rows?.[type] ?? [];
  const links = a.parents ?? [];
  if (links.some(([c]) => c.type !== type)) fail('parents of another type than the rows');
  if (links.some(([, p]) => links.some(([c]) => c.type === p.type && c.id === p.id))) fail('a parent with a parent of its own (the ORM adapter lists one level of scope columns)');
  const parents = new Map(links.map(([c, p]) => [String(c.id), p]));
  const scopeTypes = [...new Set([...parents.values()].map((p) => p.type))];
  const owners = [...new Set((a.relations ?? []).map((r) => (!('column' in r) || r.relation !== 'owner' || r.type !== type ? fail('only an owner column relation of the type maps to the ORM') : r.column)))];
  if (owners.length > 1) fail(`owner relations on several columns (${owners.join(', ')}): a model has one @Owner`);
  const owner = owners[0];

  const columns: Record<string, ColumnKind> = {};
  for (const field of new Set(source.flatMap((r) => Object.keys(r)))) {
    if (field !== 'id')
      columns[field] = columnKind(
        source.map((r) => r[field]),
        `column ${field}`,
      );
  }
  const scopeColumns = scopeTypes.map((scopeType) => ({ column: `${scopeType}_id`, scopeType }));
  for (const s of scopeColumns) {
    if (s.column in columns) fail(`the scope column ${s.column} is also a field of the rows`);
    columns[s.column] = 'text';
  }

  const rows = source.map((r): Row => {
    const parent = parents.get(r.id);
    return { ...r, ...(parent ? { [`${parent.type}_id`]: parent.id } : {}) };
  });
  const permissions = permissionsOf(world, type);
  if (permissions.length === 0) fail(`no permission of ${type}`);
  return { spec: { type, permissions, columns, ...(owner ? { owner } : {}), scopeColumns }, rows };
}

// ---------------------------------------------------------------------------------------------
// World.lane.orm: OrmModelSpecs as decorated ORM models

const JSON_TYPES: Readonly<Record<Dialect, string>> = { sqlite: 'JSON', postgres: 'JSONB' };

let policySeq = 0;

/** The OrmScopeSpec's policy: rows whose `column` equals the principal's `attribute`. */
function scopePolicy(spec: OrmScopeSpec): new () => OrmScopePolicy {
  const valueOf = (p: Principal): unknown => p.attributes?.[spec.attribute];
  const Policy = class extends OrmScopePolicy {
    scope(q: IWhereBuilder<never>, p: Principal): void {
      const v = valueOf(p);
      if (typeof v === 'string' || typeof v === 'number') q.where(spec.column as never, v as never);
      else q.where(false as never);
    }
  };
  const proto = Policy.prototype as OrmScopePolicy;
  // Only the hooks the spec asks for: the middleware treats a missing authorizeCreate as "cannot stamp".
  if (spec.onCreate === 'stamp')
    proto.authorizeCreate = (q: InsertQueryBuilder, p: Principal) => {
      const v = valueOf(p);
      if (v === undefined || v === null) throw new Forbidden(`${spec.relation}: the principal has no ${spec.attribute}`);
      q.forceColumn(spec.column, v);
    };
  else if (spec.onCreate === 'check')
    proto.authorizeCreate = (q: InsertQueryBuilder, p: Principal) => {
      const values = q.getColumnValues(spec.column);
      if (values.length !== q.Values.length || values.some((v) => v !== valueOf(p))) throw new Forbidden(`${spec.relation}: ${spec.column} must be the principal's ${spec.attribute}`);
    };
  if (spec.guardUpdate)
    proto.authorizeUpdate = (_q: UpdateQueryBuilder<ModelBase>, values: Record<string, unknown>, p: Principal) => {
      if (Object.hasOwn(values, spec.column) && values[spec.column] !== valueOf(p)) throw new Forbidden(`${spec.relation}: an update may not move ${spec.column} away from the principal's ${spec.attribute}`);
    };
  // DI keys classes by name.
  Object.defineProperty(Policy, 'name', { value: `OrmScope_${spec.relation}_${++policySeq}` });
  return Policy;
}

function checkSpecs(specs: readonly OrmModelSpec[]): void {
  const names = new Set<string>();
  for (const s of specs) {
    const where = `model ${s.name}`;
    if (typeof s.name !== 'string' || s.name === '' || names.has(s.name)) fail(`${where}: a model needs a name of its own`);
    names.add(s.name);
    const columns = new Set(s.columns);
    if (columns.size !== s.columns.length || columns.has('id')) fail(`${where}: columns repeat a name or list id`);
    const has = (c: string, what: string) => columns.has(c) || fail(`${where}: ${what} ${c} is not one of its columns`);
    if (s.type === undefined && (s.owner !== undefined || s.scopeColumns || s.scopes || s.attributes || s.relationScope)) fail(`${where}: owner, scope columns, scopes, attributes and relationScope need a type (@AccessResource)`);
    if (s.owner !== undefined) has(s.owner, 'the owner');
    for (const c of s.scopeColumns ?? []) has(c.column, 'the scope column');
    for (const c of s.attributes ?? []) has(c, 'the attribute');
    for (const c of s.json ?? []) has(c, 'the JSON column');
    const relations = new Set<string>(s.owner !== undefined ? ['owner'] : []);
    for (const sc of s.scopes ?? []) {
      has(sc.column, `the column of scope ${sc.relation}`);
      if (relations.has(sc.relation)) fail(`${where}: relation ${sc.relation} is declared twice`);
      relations.add(sc.relation);
    }
    const ids = new Set<string>();
    for (const r of s.rows ?? []) {
      if (typeof r.id !== 'string' || ids.has(r.id)) fail(`${where}: rows need distinct string ids`);
      ids.add(r.id);
      for (const k of Object.keys(r)) if (k !== 'id') has(k, 'the row field');
    }
    for (const b of s.belongsTo ?? []) {
      has(b.column, `the column of belongsTo ${b.name}`);
      if (columns.has(b.name)) fail(`${where}: belongsTo ${b.name} is also a column`);
      if (!specs.some((t) => t.name === b.target)) fail(`${where}: belongsTo ${b.name} names an unknown model ${b.target}`);
    }
    for (const j of s.junctions ?? []) {
      if (columns.has(j.name)) fail(`${where}: junction ${j.name} is also a column`);
      if (!specs.some((t) => t.name === j.target)) fail(`${where}: junction ${j.name} names an unknown model ${j.target}`);
    }
  }
}

/** A belongsTo target is defined before the model that names it. */
function belongsToOrder(specs: readonly OrmModelSpec[]): OrmModelSpec[] {
  const out: OrmModelSpec[] = [];
  while (out.length < specs.length) {
    const next = specs.find((s) => !out.includes(s) && (s.belongsTo ?? []).every((b) => out.some((o) => o.name === b.target)));
    if (next === undefined) return fail('belongsTo relations form a cycle (a model naming itself included)');
    out.push(next);
  }
  return out;
}

/** Every statement `fn` sends to `driver`, as the driver receives it. */
async function captured<T>(driver: OrmDriver, fn: () => Promise<T>): Promise<{ value: T; sql: string[] }> {
  const d = driver as unknown as { executeOnDb(sql: string, bindings: unknown[], ctx: unknown): Promise<unknown> };
  const executeOnDb = d.executeOnDb;
  const sql: string[] = [];
  d.executeOnDb = function (this: unknown, text: string, bindings: unknown[], ctx: unknown) {
    sql.push(text);
    return executeOnDb.call(this, text, bindings, ctx);
  };
  try {
    return { value: await fn(), sql };
  } finally {
    d.executeOnDb = executeOnDb;
  }
}

class OrmModels {
  private constructor(private readonly db: TestDb, private readonly dialect: Dialect, private readonly classes: ReadonlyMap<string, Model>) {}

  /** Tables, decorated classes and rows for `specs`; `policies` collects the policy classes (the caller uncaches them). */
  static async define(db: TestDb, dialect: Dialect, specs: readonly OrmModelSpec[], policies: (new () => OrmScopePolicy)[]): Promise<OrmModels> {
    checkSpecs(specs);
    const classes = new Map<string, Model>();
    for (const s of belongsToOrder(specs)) {
      const rows: readonly FakeRow[] = s.rows ?? [];
      const columns = Object.fromEntries(
        s.columns.map((c) => [
          c,
          s.json?.includes(c)
            ? JSON_TYPES[dialect]
            : SQL_TYPES[dialect][
                columnKind(
                  rows.map((r) => r[c]),
                  `${s.name}.${c}`,
                )
              ],
        ]),
      );
      const cls = await db.define(
        {
          name: s.name,
          columns,
          decorate: (model, proto) => {
            for (const b of s.belongsTo ?? []) BelongsTo(classes.get(b.target) as never, b.column, 'id')(proto, b.name);
            if (s.type === undefined) return;
            AccessResource(s.type, { ...(s.relationScope ? { relationScope: s.relationScope } : {}), ...(s.attributes ? { attributes: [...s.attributes] } : {}) })(model);
            if (s.owner !== undefined) Owner()(proto, s.owner);
            for (const c of s.scopeColumns ?? []) ScopeColumn(c.column, c.type)(proto, c.column);
            for (const sc of s.scopes ?? []) {
              const policy = scopePolicy(sc);
              policies.push(policy);
              OrmScope(model as never, sc.relation)(policy);
            }
          },
        },
        dialect,
      );
      await replaceRows(db, db.table(cls), dialect, dialect === 'sqlite' ? rows.map(sqliteRow) : rows);
      classes.set(s.name, cls);
    }

    let junctions = false;
    for (const s of specs) {
      for (const j of s.junctions ?? []) {
        const source = classes.get(s.name)!;
        const target = classes.get(j.target)!;
        const link = await db.define(
          {
            name: `${s.name}_${j.name}`,
            columns: { source_id: 'TEXT', target_id: 'TEXT' },
            decorate: (_model, proto) => {
              BelongsTo(source as never, 'source_id', 'id')(proto, 'source');
              BelongsTo(target as never, 'target_id', 'id')(proto, 'target');
            },
          },
          dialect,
        );
        await replaceRows(
          db,
          db.table(link),
          dialect,
          j.pairs.map(([from, to], i) => ({ id: `j${i}`, source_id: from, target_id: to })),
        );
        HasManyToMany(link as never, target as never, { targetModelPKey: 'id', sourceModelPKey: 'id', junctionModelTargetPk: 'target_id', junctionModelSourcePk: 'source_id', type: ManyToManyRelationList as never })(source.prototype, j.name);
        junctions = true;
      }
    }
    if (junctions) (db.orm as unknown as { wireRelations(): void }).wireRelations();
    return new OrmModels(db, dialect, classes);
  }

  private classOf(name: string): any {
    return this.classes.get(name) ?? fail(`no model ${name} in the world (models: ${[...this.classes.keys()].join(', ')})`);
  }

  /** Ids of the rows of `type` the middleware's selects return, over every model that reads it with `permission`. */
  async list(principal: Principal, permission: Permission, type: ResourceType): Promise<string[]> {
    const readers = [...this.classes.values()].filter((c) => entryOf(c)?.type === type && entryOf(c)?.permissions.read === permission);
    if (readers.length === 0) fail(`no model reads ${type} with ${permission}`);
    const out = new Set<string>();
    for (const cls of readers) {
      try {
        for (const row of (await runWithPrincipal(principal, async () => (cls as any).all())) as ModelBase[]) out.add(pk(row));
      } catch (e) {
        if (!(e instanceof AccessDenied)) throw e;
      }
    }
    return [...out];
  }

  handle(): OrmHandle {
    return {
      run: async (q: OrmQuery): Promise<OrmResult> => {
        const cls = this.classOf(q.model);
        const { value, sql } = await captured(this.db.driver(this.dialect), () => this.execute(cls, q));
        return { ...value, sql };
      },
      rows: (model) => this.db.rows(this.classOf(model)),
    };
  }

  private async execute(cls: any, q: OrmQuery): Promise<Omit<OrmResult, 'sql'>> {
    const where = (b: any, w: Readonly<Record<string, unknown>> | undefined) => Object.entries(w ?? {}).reduce((x, [k, v]) => x.where(k, v), b);
    switch (q.op) {
      case 'select': {
        const populate = q.populate;
        let b = where(cls.query(), q.where);
        // Without a column list the orm selects only the populated relation's columns.
        if (populate !== undefined) b = b.select('*').populate(populate);
        const rows = (await (q.clone ? b.clone() : b)) as ModelBase[];
        const target = (row: ModelBase): string | null => {
          const id = (row as unknown as Record<string, { Value?: { id?: unknown } } | undefined>)[populate!]?.Value?.id;
          return id === undefined || id === null ? null : String(id);
        };
        return { ids: rows.map(pk), count: rows.length, ...(populate !== undefined ? { populated: Object.fromEntries(rows.map((r) => [pk(r), target(r)])) } : {}) };
      }
      case 'related': {
        // Through the source row's populate: the static Model.populate joins the target directly, which the middleware refuses for a scoped target.
        const row = await cls.where('id', q.id).populate(q.relation).first();
        return { ids: row ? [...((row[q.relation] ?? []) as Iterable<ModelBase>)].map(pk) : [] };
      }
      case 'insert':
        await cls.insert({ ...q.values });
        return {};
      case 'update':
        await where(cls.update({ ...q.values }), q.where);
        return {};
      case 'delete':
        await where(createQuery(cls, DeleteQueryBuilder).query, q.where);
        return {};
      default:
        return fail(`unknown query ${JSON.stringify(q)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The harness

interface Built {
  readonly session: Partial<HarnessSession>;
  dispose(): Promise<void>;
}

async function build(db: TestDb, dialect: Dialect, world: World): Promise<Built> {
  const releaseCompiler = usesTuple(world) ? useTupleCompiler() : undefined;
  const policies: (new () => OrmScopePolicy)[] = [];
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await db.clear();
    } finally {
      for (const p of policies) DI.uncache(p as never);
      releaseCompiler?.();
    }
  };
  try {
    for (const key of Object.keys(world.lane ?? {})) if (key !== 'orm') fail(`lane.${key} is another lane's`);
    let session: Partial<HarnessSession>;
    const orm = world.lane?.orm;
    if (orm) {
      const models = await OrmModels.define(db, dialect, orm.models, policies);
      session = { list: (principal, permission, type) => models.list(principal, permission, type), load: (ref: ResourceRef) => findRow(ref), lane: { orm: models.handle() } };
    } else {
      const { spec, rows } = tablesOf(world);
      const tables = await OrmTables.define(db, spec, dialect);
      await tables.load(rows);
      const sqlPages: SqlPagesHandle = { page: (principal, permission, _type, p) => tables.page(principal, permission, p.limit, p.offset) };
      session = { list: async (principal, permission) => (await tables.scoped(principal, permission)) ?? [], load: (ref: ResourceRef) => findRow(ref), lane: { sqlPages } };
    }
    const tuple = (world.models ?? []).find((m) => m.kind === 'fake-tuple');
    if (tuple?.kind === 'fake-tuple') await (await TupleTables.define(db, dialect)).load(tuple.tuples ?? [], tuple.schema);
    return { session, dispose };
  } catch (e) {
    await dispose();
    throw e;
  }
}

/**
 * hostHarness with the world's ORM side built on `dialect`. `World.lane.orm` becomes decorated
 * models (`@AccessResource`, `@Owner`, `@ScopeColumn`, `@OrmScope` policies, junctions) with the
 * `orm` handle; a world with one kit adapter (B06) becomes ORM tables in its place, with `list` the
 * middleware's select and `sqlPages`. `authz.orm.domain` names the test domain, so the middleware
 * asks it; a FakeTupleModel's tuples are loaded for the test tuple compiler.
 */
export function ormHarness(db: () => TestDb, dialect: Dialect): BehaviourHarness {
  let world: World | undefined;
  let built: Built | undefined;
  const release = async () => {
    const b = built;
    built = undefined;
    await b?.dispose();
  };
  const base = hostHarness({
    facets: ['orm', 'list', 'sql'],
    // Before the domain boots, so the adapter serves the types when the boot checks run.
    async register(host) {
      host.setConfig(['authz', 'orm', 'domain'], host.domain);
      // What a case that failed half-way left behind.
      await db().clear();
      built = await build(db(), dialect, world!);
      // The host registers an adapter's permissions when the domain that owns it boots: root, which
      // boots once, before the case's classes exist. So the case's types come in through the test
      // domain's config, as they would through root's in an app whose models load before boot.
      const declared = new Set(world!.permissions.map((p) => (typeof p === 'string' ? p : p.name)));
      const types = new Set((world!.lane?.orm?.models ?? []).flatMap((m) => (m.type === undefined ? [] : [m.type])));
      for (const { name, ...def } of new OrmResourceAdapter().permissions()) {
        if (!declared.has(name) && def.types?.some((t) => types.has(t))) host.setConfig(['authz', 'domains', host.domain, 'permissions', name], { ...def, types: [...(def.types ?? [])] });
      }
    },
    extend: () => ({ ...built!.session, dispose: release }),
  });
  return {
    ...base,
    async setup(w, ctx) {
      world = w;
      try {
        // The kit's FakeAdapter would serve a B06 world's type too: the ORM tables take its place.
        return await base.setup(w.lane?.orm ? w : { ...w, adapters: [] }, ctx);
      } catch (e) {
        await release();
        throw e;
      }
    },
  };
}
