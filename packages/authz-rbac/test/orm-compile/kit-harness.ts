import assert from 'node:assert/strict';

import { AccessDenied, AuthzAdminBackend, AuthzContributor, GLOBAL, SYSTEM, ScopeAttributeStore, WritableScopeAttributeStore, flattenAttributes, resourceKey, runWithPrincipal } from '@spinajs/authz';
import type { AuthzService, Permission, Principal, ResourceFilter, ResourceRef, ResourceType, ScopeAttributeSchema } from '@spinajs/authz';
import { AccessResource, AuthzScopeAttribute_2026_10_02_00_00_00, DbScopeAttributeStore, ScopeColumn } from '@spinajs/authz-orm';
import { hostHarness, testHost } from '@spinajs/authz-testing';
import type { BehaviourHarness, Facet, HarnessSession, HostSetup, SetupContext, World } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import type { ModelBase, OrmDriver } from '@spinajs/orm';

// Not a root export of authz-orm; the build the package resolves to, so one copy of the module.
import { OrmResourceAdapter } from '../../../authz-orm/lib/mjs/adapter.js';
import { compileResidual } from '../../../authz-orm/lib/mjs/compile/compiler.js';
import adminConfig from '../../src/config/admin.js';
import { AssignmentStore, AuthzAdminIdempotency_2026_10_02_00_01_00, AuthzRbac_2026_10_01_00_00_00, DbAuthzAdminBackend, createRbacExtensions, rbacAssignmentExtension, registerRbac } from '../../src/index.js';
import type { LadderDef, RbacModel, RoleDef } from '../../src/index.js';
import { RbacModelRoleGraphSource, RbacRoleGraphSource, RbacScopeAttributeSource, RbacScopeDefaults, ormRbacScopeLayers } from '../../src/orm/index.js';
import type { RbacListing } from '../../src/orm/index.js';
import type { RoleGraph } from '../../src/index.js';
import { ladderConfig, roleConfig } from '../integration/db-harness.js';
import { RootOrm } from '../orm/root-orm.js';
import { rawQuery } from '../support/db.js';
import type { Kind, ModelClass } from '../orm/root-orm.js';
import { withoutJit } from './route-world.js';

/*
 * The lane SQL harness (L4b, kit facet `sql`): a host test domain per case whose world rows live in SQL as
 * authz-orm models, listed by SQL alone. K1 may import it.
 *
 * - Each type of the world's adapters becomes an `@AccessResource` model: `id` TEXT, the rows' own fields, and a
 *   `@ScopeColumn` `<type>_id` per ancestor type of the `parents` chains, nearest first. The kit adapters are not
 *   registered: authz-orm's adapter (root) serves the types, loads the subjects and gives the ancestors.
 * - RBAC is wired as a host does (`registerRbac`): ConfigRoleStore (the world's roles and ladders as config),
 *   DbAssignmentStore (the world's assignments written through it), ConfigRuleStore (`world.rbac.rules`) and, for
 *   parts with the `admin` facet, DbRuleStore with AuthzAdmin on DbAuthzAdminBackend, so `rule.put` writes
 *   `authz_rule`; the list extension with `rules: true`.
 * - Scope attributes (the adapters' `attributes` and `world.scopeAttributes.values`) are written through
 *   DbScopeAttributeStore, the domain's store, which the SQL reads.
 * - `session.list` compiles the type-level residual with authz-orm's compiler and runs it as one statement; the
 *   query counter asserts exactly one statement ran and the rows it returned are the list ("no row is checked in
 *   Node"). For `<type>:read` the list also goes through authz-orm's middleware and must give the same rows.
 *   Lane handle `sqlPages` runs the same statement with ORDER BY id, LIMIT and OFFSET.
 *
 * Not mirrored (the setup throws): adapter relations, adapter permissions, an adapter that is not list-scoped
 * (`compiles: undefined`), `world.rbac.links`, row values other than strings, numbers and null, an ancestor chain
 * holding a type twice or the row's own type, and chains of one type that order two scope types both ways.
 */

export interface SqlKitStats {
  lists: number;
  pages: number;
  /** Lists and pages that ran SQL (a FALSE residual runs none). */
  queries: number;
  /** Statements those ran. */
  statements: number;
  /** Rows the lists returned. */
  listed: number;
  /** Lists whose residual held native:rbac.threshold or args v2 (rules in SQL). */
  ruleLists: number;
}

export interface SqlKitHarnessOptions {
  readonly kind: Kind;
  /** The test domain, default 'l4bkit'. */
  readonly domain?: string;
  /** Added to the harness's facets. */
  readonly facets?: readonly Facet[];
  /** After the RBAC wiring, before the domain boots. */
  register?(host: HostSetup, wiring: SqlKitWiring): void | Promise<void>;
  extend?(host: HostSetup, session: HarnessSession): Partial<HarnessSession> | Promise<Partial<HarnessSession>>;
}

export interface SqlKitWiring {
  readonly db: RootOrm;
  readonly kind: Kind;
  readonly driver: OrmDriver;
  readonly model: RbacModel;
  /** The ORM model of each world type. */
  readonly models: ReadonlyMap<ResourceType, ModelClass>;
}

const SQL_KIT_FACETS: readonly Facet[] = ['rbac', 'ladders', 'rules', 'conditions', 'list', 'sql', 'admin'];

const ADMIN_PERMISSIONS = ['authz:assignments.manage', 'authz:links.manage', 'authz:rules.manage'];

const CLEARED = ['authz_rule_subject', 'authz_rule', 'authz_link', 'authz_assignment', 'authz_version', 'authz_admin_idempotency', 'authz_scope_attribute'];

interface Current {
  readonly model: RbacModel;
  readonly models: ReadonlySet<unknown>;
  readonly schemas: readonly ScopeAttributeSchema[];
}

/** The case's RbacModel serves the compiler (resolved in root) for the case's ORM models only. */
const state: { current?: Current } = {};

class KitGraphSource extends RbacRoleGraphSource {
  graph(model: unknown): RoleGraph | undefined {
    return this.source()?.graph(model as never);
  }

  listing(model: unknown): RbacListing | undefined {
    return this.source()?.listing(model as never);
  }

  private source(): RbacModelRoleGraphSource | undefined {
    const c = state.current;
    return c ? new RbacModelRoleGraphSource(c.model, (m) => c.models.has(m)) : undefined;
  }
}

class KitAttributeSource extends RbacScopeAttributeSource {
  defaults(model: unknown, driver: OrmDriver): RbacScopeDefaults | undefined {
    const c = state.current;
    if (!c || !c.models.has(model)) return undefined;
    return RbacScopeDefaults.of(c.schemas, ormRbacScopeLayers(driver));
  }
}

/** DbAuthzAdminBackend over the root container (the test host's configuration and the root Orm). */
export class L4bKitAdminBackend extends DbAuthzAdminBackend {
  constructor() {
    super({ container: DI.RootContainer });
  }
}

class SchemaContributor extends AuthzContributor {
  constructor(private readonly schemas: readonly ScopeAttributeSchema[]) {
    super();
  }

  contribute() {
    return { scopeAttributeSchemas: [...this.schemas] };
  }
}

interface Statement {
  readonly sql: string;
  readonly result: unknown;
}

/**
 * Runs `fn` and records every statement `driver` runs meanwhile (its `executeOnDb`, which every query of the
 * connection goes through).
 */
export async function countStatements<T>(driver: OrmDriver, fn: () => Promise<T>): Promise<{ value: T; statements: readonly Statement[] }> {
  const d = driver as unknown as { executeOnDb(sql: string, bindings: unknown[], context: unknown): Promise<unknown> };
  const own = Object.prototype.hasOwnProperty.call(d, 'executeOnDb');
  const before = d.executeOnDb;
  const statements: Statement[] = [];
  d.executeOnDb = async function (this: unknown, sql: string, bindings: unknown[], context: unknown) {
    const result = await before.call(this, sql, bindings, context);
    statements.push({ sql, result });
    return result;
  };
  try {
    return { value: await fn(), statements };
  } finally {
    if (own) d.executeOnDb = before;
    else delete (d as Partial<typeof d>).executeOnDb;
  }
}

const idsOf = (rows: unknown): string[] => (rows as ModelBase[]).map((r) => String((r as unknown as { id: unknown }).id));

const columnName = (type: string): string => `${type.replace(/[^A-Za-z0-9_]/g, '_')}_id`;

function sqlType(kind: Kind, values: readonly unknown[], where: string): string {
  const present = values.filter((v) => v !== null && v !== undefined);
  if (present.every((v) => typeof v === 'string')) return 'TEXT';
  if (present.every((v) => typeof v === 'number' && Number.isSafeInteger(v))) return 'INTEGER';
  if (present.every((v) => typeof v === 'number' && Number.isFinite(v))) return kind === 'postgres' ? 'DOUBLE PRECISION' : 'REAL';
  throw new Error(`sqlKitHarness: ${where} holds values other than strings, numbers and null, which the harness does not mirror`);
}

/**
 * The scope types of `type`'s rows in one order, nearest first, that keeps every row's ancestor chain in its order
 * (authz-orm reads a row's ancestors as its non-NULL `@ScopeColumn`s in declaration order). Types no chain orders
 * against each other keep their first-seen order.
 * @throws when a chain holds a type twice or holds `type` itself (one column per type cannot mirror it), or when
 *   two chains order two types differently (no one column order mirrors both)
 */
export function scopeColumnOrder(type: ResourceType, chains: readonly (readonly ResourceRef[])[]): ResourceType[] {
  const seen: ResourceType[] = [];
  const before = new Map<ResourceType, Set<ResourceType>>();
  for (const chain of chains) {
    const types = chain.map((r) => r.type);
    const twice = types.find((t, i) => types.indexOf(t) !== i);
    if (twice !== undefined) throw new Error(`sqlKitHarness: an ancestor chain of '${type}' holds '${twice}' twice (${chain.map(resourceKey).join(' → ')}); one scope column per type cannot mirror it`);
    if (types.includes(type)) throw new Error(`sqlKitHarness: an ancestor chain of '${type}' holds the row's own type (${chain.map(resourceKey).join(' → ')}); one scope column per type cannot mirror it`);
    types.forEach((t, i) => {
      if (!seen.includes(t)) seen.push(t);
      const set = before.get(t) ?? new Set<ResourceType>();
      for (const later of types.slice(i + 1)) {
        if (before.get(later)?.has(t)) throw new Error(`sqlKitHarness: the ancestor chains of '${type}' order '${t}' and '${later}' both ways; no one scope column order mirrors them`);
        set.add(later);
      }
      before.set(t, set);
    });
  }
  // Kahn's order over "nearer than", first-seen order among the ready ones.
  const out: ResourceType[] = [];
  const left = [...seen];
  while (left.length > 0) {
    const i = left.findIndex((t) => !left.some((u) => u !== t && before.get(u)?.has(t)));
    if (i < 0) throw new Error(`sqlKitHarness: the ancestor chains of '${type}' order ${left.map((t) => `'${t}'`).join(', ')} in a cycle; no one scope column order mirrors them`);
    out.push(...left.splice(i, 1));
  }
  return out;
}

/**
 * The world's adapter types as authz-orm models on `kind`'s connection, with their rows: `id` TEXT, the rows'
 * fields, one scope column per ancestor type (from `parents`, transitively), nearest first (`scopeColumnOrder`).
 */
export async function defineWorldModels(db: RootOrm, kind: Kind, world: World): Promise<Map<ResourceType, ModelClass>> {
  const out = new Map<ResourceType, ModelClass>();
  const parentOf = new Map<string, ResourceRef>();
  for (const a of world.adapters ?? []) {
    if (a.relations?.length) throw new Error('sqlKitHarness: adapter relations are not mirrored');
    // The kit's FakeAdapter takes `compiles: undefined` as "not list-scoped"; authz-orm's adapter lists every type in SQL.
    if ('compiles' in a && a.compiles === undefined) throw new Error(`sqlKitHarness: an adapter of ${a.types.map((t) => `'${t}'`).join(', ')} is not list-scoped (compiles: undefined), which the harness does not mirror`);
    if (a.permissions?.length) throw new Error(`sqlKitHarness: adapter permissions (${a.permissions.map((p) => p.name).join(', ')}) are not mirrored; declare them in world.permissions`);
    for (const [child, parent] of a.parents ?? []) parentOf.set(resourceKey(child), parent);
  }
  const chain = (ref: ResourceRef): ResourceRef[] => {
    const up: ResourceRef[] = [];
    const seen = new Set<string>([resourceKey(ref)]);
    for (let at = parentOf.get(resourceKey(ref)); at; at = parentOf.get(resourceKey(at))) {
      if (seen.has(resourceKey(at))) throw new Error(`sqlKitHarness: parent cycle at ${resourceKey(at)}`);
      seen.add(resourceKey(at));
      up.push(at);
    }
    return up;
  };
  for (const a of world.adapters ?? []) {
    for (const type of a.types) {
      if (out.has(type)) throw new Error(`sqlKitHarness: two adapters serve '${type}'`);
      const rows = a.rows?.[type] ?? [];
      const scopes = scopeColumnOrder(
        type,
        rows.map((row) => chain({ type, id: row.id })),
      );
      const fields = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((f) => f !== 'id');
      const columns: Record<string, string> = { id: 'TEXT' };
      for (const f of fields)
        columns[f] = sqlType(
          kind,
          rows.map((r) => r[f]),
          `field '${f}' of '${type}'`,
        );
      for (const s of scopes) {
        if (columns[columnName(s)] !== undefined) throw new Error(`sqlKitHarness: the scope column ${columnName(s)} of '${type}' clashes with a field`);
        columns[columnName(s)] = 'TEXT';
      }
      const values = rows.map((row) => {
        const up = chain({ type, id: row.id });
        const v: Record<string, unknown> = { id: row.id };
        for (const f of fields) v[f] = row[f] ?? null;
        for (const s of scopes) v[columnName(s)] = up.find((r) => r.type === s)?.id ?? null;
        return v;
      });
      const model = await db.define(
        {
          name: `Kit_${type.replace(/[^A-Za-z0-9_]/g, '_')}`,
          columns,
          rows: values,
          decorate: (cls, proto) => {
            AccessResource(type)(cls);
            for (const s of scopes) ScopeColumn(columnName(s), s)(proto, columnName(s));
          },
        },
        kind,
      );
      out.set(type, model);
    }
  }
  return out;
}

const hasRuleTerms = (f: ResourceFilter): boolean => {
  const json = JSON.stringify(f);
  return json.includes('native:rbac.threshold') || json.includes('"v":2');
};

/**
 * The lane SQL harness on SQLite or Postgres (see the module comment). `stats` counts what the lists and pages ran.
 */
export function sqlKitHarness(opts: SqlKitHarnessOptions): BehaviourHarness & { readonly stats: SqlKitStats } {
  const domain = opts.domain ?? 'l4bkit';
  const stats: SqlKitStats = { lists: 0, pages: 0, queries: 0, statements: 0, listed: 0, ruleLists: 0 };
  let db: RootOrm | undefined;
  let undo: (() => void)[] = [];
  let models = new Map<ResourceType, ModelClass>();
  // The case's adapters: hostHarness gets the world without them.
  let adapters: World['adapters'] = [];
  const adapter = new OrmResourceAdapter();
  const driver = (): OrmDriver => db!.driver(opts.kind);

  const modelOf = (type: ResourceType): ModelClass => {
    const m = models.get(type);
    if (!m) throw new Error(`sqlKitHarness: no world type '${type}'`);
    return m;
  };

  /** The residual as one statement on the type's table, outside any principal's scope; asserts the counter. */
  async function run(residual: ResourceFilter, principal: Principal, type: ResourceType, page?: { readonly limit: number; readonly offset: number }): Promise<string[]> {
    if (residual.op === 'false') return [];
    const Model = modelOf(type);
    const { value, statements } = await countStatements(driver(), () =>
      runWithPrincipal(SYSTEM, async () => {
        const q = (Model as unknown as { query(): any }).query();
        compileResidual(residual, q, { model: Model, principal, op: 'read' });
        if (page) q.order('id', 'ASC').take(page.limit).skip(page.offset);
        return idsOf(await q);
      }),
    );
    assert.equal(statements.length, 1, `a list of ${type} ran ${statements.length} statements: ${statements.map((s) => s.sql).join(' | ')}`);
    assert.match(statements[0].sql.trimStart(), /^(WITH|SELECT)\b/i, 'the list statement');
    const returned = statements[0].result as unknown[];
    assert.ok(Array.isArray(returned) && returned.length === value.length, `the list keeps every row the statement returned (${Array.isArray(returned) ? returned.length : 'no rows array'} returned, ${value.length} listed)`);
    stats.queries++;
    stats.statements += statements.length;
    return value;
  }

  async function list(session: HarnessSession, principal: Principal, permission: Permission, type: ResourceType): Promise<readonly string[]> {
    const authz = session.authz as unknown as AuthzService;
    const residual = await authz.filter(principal, permission, type);
    const ids = await run(residual, principal, type);
    stats.lists++;
    stats.listed += ids.length;
    if (hasRuleTerms(residual)) stats.ruleLists++;
    if (permission === `${type}:read`) {
      // authz-orm's middleware filters the type's read permission itself; a FALSE residual is refused before SQL (H16).
      let viaMiddleware: string[];
      try {
        viaMiddleware = idsOf(await runWithPrincipal(principal, async () => (modelOf(type) as unknown as { query(): any }).query()));
      } catch (e) {
        if (!(e instanceof AccessDenied && residual.op === 'false')) throw e;
        viaMiddleware = [];
      }
      assert.deepEqual([...viaMiddleware].sort(), [...ids].sort(), `${permission}: authz-orm's middleware lists other rows than the compiled residual`);
    }
    return ids;
  }

  const inner = hostHarness({
    domain,
    facets: [...SQL_KIT_FACETS, ...(opts.facets ?? [])],
    kitScopeAttributes: false,
    async register(host) {
      const world = host.world;
      const rbac = world.rbac ?? {};
      if (rbac.links?.length) throw new Error('sqlKitHarness: world.rbac.links are not mirrored');
      const admin = host.ctx.facets.includes('admin');
      const c = host.container;
      const connection = RootOrm.connectionOf(opts.kind);
      host.setConfig(['authz', 'orm', 'domain'], domain);
      if (rbac.roles) host.setConfig(['authz', 'rbac', 'roles'], roleConfig(rbac.roles as readonly RoleDef[]));
      if (rbac.ladders) host.setConfig(['authz', 'rbac', 'ladders'], ladderConfig(rbac.ladders as readonly LadderDef[]));
      host.setConfig(['authz', 'rbac', 'rules'], rbac.rules ?? []);
      host.setConfig(['authz', 'rbac', 'connection'], connection);
      host.setConfig(['authz', 'rbac', 'stores'], { roles: ['ConfigRoleStore'], assignments: ['DbAssignmentStore'], rules: admin ? ['ConfigRuleStore', 'DbRuleStore'] : ['ConfigRuleStore'], links: [] });

      const attributes = new DbScopeAttributeStore({ connection });
      c.register(testHost.instance(attributes)).as(ScopeAttributeStore);
      c.register(testHost.instance(attributes)).as(WritableScopeAttributeStore);
      const schemas = world.scopeAttributes?.schemas ?? [];
      if (schemas.length > 0) c.register(testHost.instance(new SchemaContributor(schemas))).as(AuthzContributor);

      if (admin) {
        const declared = new Set(world.permissions.map((p) => (typeof p === 'string' ? p : p.name)));
        // AuthzAdmin checks a command's permission on its scope (a rule's), SYSTEM included.
        const types = [...new Set([...(adapters ?? []).flatMap((a) => a.types), ...world.permissions.flatMap((p) => (typeof p === 'string' ? [] : p.types ?? []))])];
        for (const p of ADMIN_PERMISSIONS) if (!declared.has(p)) host.setConfig(['authz', 'domains', domain, 'permissions', p], { types });
        const own = world.config?.admin as { guard?: object } | undefined;
        host.setConfig(['authz', 'admin'], { connection, ...adminConfig.authz.admin, ...own, guard: { ...adminConfig.authz.admin.guard, ...(own?.guard ?? {}) }, backend: 'L4bKitAdminBackend' });
        c.register(L4bKitAdminBackend).as(AuthzAdminBackend);
      }

      const configuration = (await c.resolve(Configuration)) as Configuration;
      const wired = await registerRbac(c, configuration, { extensions: (o) => [...createRbacExtensions(o), rbacAssignmentExtension(o, { rules: true })], clock: host.kit.clock });

      // Written as AuthzAdmin's commands write them: through the stores, in one transaction on the store's connection.
      const assignments = (await c.resolve(AssignmentStore)) as unknown as { assign(a: object, actor: object, tx: object): Promise<unknown> };
      const writeAttributes = new Map<string, { ref: ResourceRef; attrs: Record<string, unknown> }>();
      const addAttributes = (ref: ResourceRef, attrs: Readonly<Record<string, unknown>>) => {
        const at = writeAttributes.get(resourceKey(ref)) ?? { ref, attrs: {} };
        Object.assign(at.attrs, attrs);
        writeAttributes.set(resourceKey(ref), at);
      };
      for (const a of adapters ?? []) for (const [ref, attrs] of a.attributes ?? []) addAttributes(ref, attrs);
      for (const v of world.scopeAttributes?.values ?? []) addAttributes(v.scope, v.attributes);
      await driver().transaction(async (tx: OrmDriver) => {
        for (const a of rbac.assignments ?? []) await assignments.assign({ subject: a.subject, role: a.role, scope: a.scope ?? GLOBAL, ...(a.tags ? { tags: a.tags } : {}), ...(a.expiresAt !== undefined ? { expiresAt: a.expiresAt } : {}) }, SYSTEM, { driver: tx });
        for (const { ref, attrs } of writeAttributes.values()) await attributes.write(ref, { set: flattenAttributes(attrs).set, remove: [] }, SYSTEM, { driver: tx });
      });

      state.current = { model: wired.model, models: new Set(models.values()), schemas };
      await opts.register?.(host, { db: db!, kind: opts.kind, driver: driver(), model: wired.model, models });
    },
    async extend(host, session) {
      const extra = (await opts.extend?.(host, session)) ?? {};
      return {
        list: (principal, permission, type) => list(session, principal, permission, type),
        load: (ref) => runWithPrincipal(SYSTEM, async () => adapter.load(ref)),
        ...(host.ctx.facets.includes('admin') ? { admin: (session.authz as unknown as AuthzService).admin() } : {}),
        ...extra,
        lane: {
          ...session.lane,
          sqlPages: {
            page: async (principal: Principal, permission: Permission, type: ResourceType, page: { readonly limit: number; readonly offset: number }) => {
              const residual = await (session.authz as unknown as AuthzService).filter(principal, permission, type);
              stats.pages++;
              return run(residual, principal, type, page);
            },
          },
          ...extra.lane,
        },
      };
    },
  });

  async function clearCase(): Promise<void> {
    state.current = undefined;
    models = new Map();
    if (!db) return;
    await db.clear();
    for (const table of CLEARED) await rawQuery(driver(), `DELETE FROM "${table}"`, [], QueryContext.Delete);
  }

  return {
    facets: inner.facets,
    domain,
    stats,
    async beforeAll() {
      db = await RootOrm.open(
        {
          skip: () => {
            throw new Error('sqlKitHarness: Postgres is unreachable');
          },
        } as unknown as Mocha.Context,
        `l4b_kit_${opts.kind}`,
      );
      const d = driver();
      await new AuthzRbac_2026_10_01_00_00_00().up(d);
      await new AuthzAdminIdempotency_2026_10_02_00_01_00().up(d);
      await new AuthzScopeAttribute_2026_10_02_00_00_00().up(d);
      if (opts.kind === 'postgres') await withoutJit(db);
      undo = [testHost.registerInRoot(RbacRoleGraphSource, testHost.instance(new KitGraphSource())), testHost.registerInRoot(RbacScopeAttributeSource, testHost.instance(new KitAttributeSource()))];
      await inner.beforeAll?.();
    },
    async afterAll() {
      try {
        await inner.afterAll?.();
      } finally {
        for (const u of undo.splice(0)) u();
        DI.uncache(RbacRoleGraphSource);
        DI.uncache(RbacScopeAttributeSource);
        await db?.close();
        db = undefined;
      }
    },
    async setup(world: World, ctx: SetupContext): Promise<HarnessSession> {
      assert.ok(db, 'sqlKitHarness: beforeAll did not run');
      try {
        adapters = world.adapters ?? [];
        models = await defineWorldModels(db, opts.kind, world);
        // The kit adapters stay out: authz-orm's adapter serves these types.
        const session = await inner.setup({ ...world, adapters: [] }, ctx);
        return {
          ...session,
          async dispose() {
            try {
              await session.dispose();
            } finally {
              await clearCase();
            }
          },
        };
      } catch (e) {
        await clearCase();
        throw e;
      }
    },
  };
}
