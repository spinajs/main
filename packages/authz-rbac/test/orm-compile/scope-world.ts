import { AuthorizationModel, AuthzContributor, BUILTIN_CONDITION_FUNCTIONS, DefaultConditionCompiler, SCOPE_CONDITION_FILTER, SCOPE_CONDITION_OP, SYSTEM, ScopeAttributeStore, flattenAttributes, runWithPrincipal } from '@spinajs/authz';
import type { Assignment, AuthzContribution, AuthzService, EvaluationContext, Policy, Principal, ResourceFilter, ResourceRef, ScopeAttributeSchema } from '@spinajs/authz';
import { AbacModel, ConfigPolicyStore } from '@spinajs/authz-abac';
import { AccessResource, AuthzScopeAttribute_2026_10_02_00_00_00, DbScopeAttributeStore, ScopeColumn } from '@spinajs/authz-orm';
import { accessResourceTypeOf } from '@spinajs/authz-orm/native';
import { evaluateFilter, fakeEvaluationContext, testHost } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';
import type { IWhereBuilder, OrmDriver } from '@spinajs/orm';

// The engine merges attribute layers with these but does not export them; read its build directly.
import { mergeAttributes, schemaIndex } from '../../../authz/lib/mjs/engine/attributes.js';
// Not a root export of authz-orm; the build the package resolves to, so one copy of the module.
import { OrmResourceAdapter } from '../../../authz-orm/lib/mjs/adapter.js';
import { compileResidual } from '../../../authz-orm/lib/mjs/compile/compiler.js';
import { MemoryAssignmentStore, MemoryRoleStore, RbacContributor, RbacModel, rbacAssignmentExtension } from '../../src/index.js';
import type { RbacModelOptions } from '../../src/index.js';
import { RbacScopeAttributeSource, RbacScopeDefaults, ormRbacScopeLayers } from '../../src/orm/index.js';
import { ROLES, createAssignmentTable, current, idsOf, insertAssignments } from '../orm/orm-world.js';
import { RootOrm } from '../orm/root-orm.js';
import type { Kind, ModelClass } from '../orm/root-orm.js';
import { withoutJit } from './route-world.js';

/*
 * The world of the `native:condition.scope` SQL tests: docs under a project (an adapter type without attributes), an
 * org (an adapter type with the adapter attribute `tier`) and a team (no model: a `store` type), scope attributes in
 * authz_scope_attribute and schema defaults. Doc rows: their nodes exist, are missing ('o9'), have the id '' or are
 * absent (NULL); on SQLite also a doc the adapter cannot find by its id ('x9').
 */

export const NOW = new Date('2026-10-01T12:00:00.000Z');

export const SCOPE_DOCS: readonly Readonly<Record<string, unknown>>[] = [
  { id: 1, project_id: 10, org_id: 'o1', team_id: 't1' },
  { id: 2, project_id: 11, org_id: 'o2', team_id: 't2' },
  { id: 3, project_id: 12, org_id: 'o1', team_id: null },
  { id: 4, project_id: null, org_id: 'o2', team_id: 't1' },
  { id: 5, project_id: 13, org_id: null, team_id: null },
  { id: 6, project_id: 10, org_id: '', team_id: 't2' },
  { id: 7, project_id: 11, org_id: 'o9', team_id: 't1' },
];
export const SQLITE_LOST_DOC = { id: 'x9', project_id: 10, org_id: 'o1', team_id: 't1' };

/** The scope nodes the docs name (and that exist where a model holds the type). */
export const NODES: readonly ResourceRef[] = [{ type: 'org', id: 'o1' }, { type: 'org', id: 'o2' }, ...['10', '11', '12', '13'].map((id) => ({ type: 'project', id })), { type: 'team', id: 't1' }, { type: 'team', id: 't2' }, ...SCOPE_DOCS.map((d) => ({ type: 'doc', id: String(d.id) }))];

export const PERMISSION = 'doc:read';

/** The schemas the current world's SQL and engine read. */
export const scopeCurrent: { schemas: readonly ScopeAttributeSchema[]; active: boolean } = { schemas: [], active: false };

/** authz-orm's layers, and `team` as a store type. */
export class ScopeWorldAttributeSource extends RbacScopeAttributeSource {
  defaults(model: unknown, driver: OrmDriver): RbacScopeDefaults | undefined {
    if (!scopeCurrent.active || accessResourceTypeOf(model as never) !== 'doc') return undefined;
    return RbacScopeDefaults.of(scopeCurrent.schemas, { ...ormRbacScopeLayers(driver), team: { kind: 'store' } });
  }
}

class SchemaContributor extends AuthzContributor {
  constructor(private readonly schemas: readonly ScopeAttributeSchema[]) {
    super();
  }

  contribute(): AuthzContribution {
    return { scopeAttributeSchemas: [...this.schemas] };
  }
}

export interface DomainOptions {
  readonly policies: readonly Policy[];
  readonly algorithm: 'deny-overrides' | 'permit-overrides' | 'first-applicable';
  /** An RBAC model beside ABAC (before or after it), over these assignments. */
  readonly rbac?: { readonly first: boolean; readonly assignments: readonly Assignment[] };
}

let seq = 0;

export class ScopeWorld {
  readonly adapter = new OrmResourceAdapter();
  service?: AuthzService;
  private readonly store: DbScopeAttributeStore;
  private undo?: () => Promise<void>;

  private constructor(readonly db: RootOrm, readonly kind: Kind, readonly Doc: ModelClass, private readonly lost: boolean) {
    this.store = new DbScopeAttributeStore({ connection: RootOrm.connectionOf(kind) });
  }

  /** `lostDoc`: on SQLite also 'x9' (authz-orm lists it under a TRUE residual while check() refuses it: L4 hand-off F3). */
  static async open(db: RootOrm, kind: Kind, lostDoc = true): Promise<ScopeWorld> {
    const lost = lostDoc && kind === 'sqlite';
    await new AuthzScopeAttribute_2026_10_02_00_00_00().up(db.driver(kind));
    await createAssignmentTable(db.driver(kind), kind);
    if (kind === 'postgres') await withoutJit(db);
    await db.define(
      {
        name: 'SOrg',
        columns: { id: 'TEXT', tier: 'TEXT' },
        rows: [
          { id: 'o1', tier: 'gold' },
          { id: 'o2', tier: null },
        ],
        decorate: (cls) => AccessResource('org', { attributes: ['tier'] })(cls),
      },
      kind,
    );
    await db.define(
      {
        name: 'SProject',
        columns: { id: 'INT', org_id: 'TEXT' },
        rows: [10, 11, 12, 13].map((id) => ({ id, org_id: 'o1' })),
        decorate: (cls, proto) => {
          AccessResource('project')(cls);
          ScopeColumn('org_id', 'org')(proto, 'org_id');
        },
      },
      kind,
    );
    const Doc = await db.define(
      {
        name: 'SDoc',
        columns: { id: 'INT', project_id: 'INT', org_id: 'TEXT', team_id: 'TEXT' },
        rows: [...SCOPE_DOCS, ...(lost ? [SQLITE_LOST_DOC] : [])],
        decorate: (cls, proto) => {
          AccessResource('doc')(cls);
          ScopeColumn('project_id', 'project')(proto, 'project_id');
          ScopeColumn('org_id', 'org')(proto, 'org_id');
          ScopeColumn('team_id', 'team')(proto, 'team_id');
        },
      },
      kind,
    );
    return new ScopeWorld(db, kind, Doc, lost);
  }

  /** Every earlier row removed, then the nodes' attributes as AuthzAdmin writes them; `schemas` become current. */
  async attributes(nodes: ReadonlyArray<readonly [ResourceRef, Readonly<Record<string, unknown>>]>, schemas: readonly ScopeAttributeSchema[] = []): Promise<void> {
    scopeCurrent.schemas = schemas;
    scopeCurrent.active = true;
    await this.db.raw(this.kind, 'DELETE FROM "authz_scope_attribute"');
    const written = nodes.filter(([, a]) => Object.keys(flattenAttributes(a).set).length > 0);
    if (written.length === 0) return;
    await this.db.driver(this.kind).transaction(async (tx: OrmDriver) => {
      for (const [ref, a] of written) await this.store.write(ref, { set: flattenAttributes(a).set, remove: [] }, { type: 'user', id: 'root' }, { driver: tx });
    });
  }

  async close(): Promise<void> {
    try {
      await this.undo?.();
    } finally {
      scopeCurrent.active = false;
      await this.db.clear();
      await new AuthzScopeAttribute_2026_10_02_00_00_00().down(this.db.driver(this.kind));
      await this.db.raw(this.kind, 'DROP TABLE "authz_assignment"');
    }
  }

  /** The docs of the table, the one the adapter cannot find included. */
  docIds(): string[] {
    return [...SCOPE_DOCS.map((d) => String(d.id)), ...(this.lost ? [SQLITE_LOST_DOC.id] : [])].sort();
  }

  /** The rows `filter` selects through authz-orm's compiler: one statement. */
  sql(filter: ResourceFilter, principal: Principal): Promise<string[]> {
    return runWithPrincipal(SYSTEM, async () => {
      const q = (this.Doc as unknown as { query(): any }).query();
      compileResidual(filter, q, { model: this.Doc, principal, op: 'read' });
      return idsOf(await q);
    });
  }

  /** As SYSTEM: a query of the docs, `build` adds its conditions, then the rows it lists. */
  run(build: (q: IWhereBuilder<unknown>) => void): Promise<string[]> {
    return runWithPrincipal(SYSTEM, async () => {
      const q = (this.Doc as unknown as { query(): any }).query();
      build(q);
      return idsOf(await q);
    });
  }

  /** An evaluation context as the engine's: the adapter's ancestors, schema defaults ⊕ adapter ⊕ store; memoised. */
  context(): EvaluationContext {
    const base = fakeEvaluationContext({ now: NOW, adapters: [this.adapter], nativeFilters: [SCOPE_CONDITION_FILTER], conditions: new DefaultConditionCompiler(BUILTIN_CONDITION_FUNCTIONS) });
    const memo = new Map<string, Promise<Readonly<Record<string, unknown>> | null>>();
    const defaults = schemaIndex(scopeCurrent.schemas);
    const layered = async (ref: ResourceRef): Promise<Readonly<Record<string, unknown>> | null> => {
      const own = this.adapter.types.includes(ref.type) ? await runWithPrincipal(SYSTEM, async () => this.adapter.scopeAttributes(ref)) : {};
      if (own === null) return null;
      return mergeAttributes([defaults.get(ref.type) ?? {}, own, await this.store.get(ref)]) as Readonly<Record<string, unknown>>;
    };
    const attributes = (ref: ResourceRef) => {
      const key = JSON.stringify([ref.type, ref.id ?? null]);
      let hit = memo.get(key);
      if (!hit) memo.set(key, (hit = layered(ref)));
      return hit;
    };
    const ancestors = (ref: ResourceRef) => runWithPrincipal(SYSTEM, async () => base.ancestors(ref));
    return { ...base, attributes, ancestors } as EvaluationContext;
  }

  /** The leaf's two-valued answer in memory (`SCOPE_CONDITION_FILTER`, the check's own read and comparison). */
  memory(args: unknown, id: string, ctx: EvaluationContext): Promise<boolean> {
    return SCOPE_CONDITION_FILTER.matches(args, undefined, { type: 'doc', id }, ctx);
  }

  /** A residual evaluated per row in memory, its natives through their filters. */
  async inMemory(residual: ResourceFilter, p: Principal, ctx: EvaluationContext): Promise<string[]> {
    const out: string[] = [];
    for (const id of this.docIds()) {
      const row = await runWithPrincipal(SYSTEM, async () => this.adapter.load({ type: 'doc', id }));
      if ((await evaluateFilter(residual, row, { principal: p, ref: { type: 'doc', id }, context: ctx, nativeFilters: [SCOPE_CONDITION_FILTER] })) === true) out.push(id);
    }
    return out.sort();
  }

  /**
   * A domain over this world (`authz.orm.domain` names it): an AbacModel with `scopeResiduals` on, the store as its
   * ScopeAttributeStore and the current schemas, optionally an RbacModel beside it.
   */
  async domain(opts: DomainOptions): Promise<AuthzService> {
    await this.undo?.();
    this.undo = undefined;
    const ds = await testHost.domains();
    const cfg = testHost.config();
    const name = `a4scope${++seq}`;
    const abac = new AbacModel({ stores: [new ConfigPolicyStore(opts.policies)], scopeResiduals: true });
    const models: AuthorizationModel[] = [abac];
    let rbac: RbacModel | undefined;
    await this.db.raw(this.kind, 'DELETE FROM "authz_assignment"');
    if (opts.rbac) {
      await insertAssignments(this.db.driver(this.kind), opts.rbac.assignments);
      const options: RbacModelOptions = { roles: new MemoryRoleStore(ROLES), assignments: new MemoryAssignmentStore(opts.rbac.assignments) };
      rbac = new RbacModel({ ...options, extensions: [rbacAssignmentExtension(options)] });
      models.splice(opts.rbac.first ? 0 : 1, 0, rbac);
    }
    cfg.set(['authz', 'domains', name], { permissions: { [PERMISSION]: { types: ['doc'] }, 'doc:edit': { types: ['doc'] } }, combine: { default: { algorithm: opts.algorithm, models: models.map((m) => m.name) } }, cache: { maxEntries: 0 }, engine: { modelTimeoutMs: 120000 } });
    const before = cfg.get<unknown>(['authz', 'orm', 'domain']);
    cfg.set(['authz', 'orm', 'domain'], name);
    const container: IContainer = ds.create(name, 'root');
    for (const m of models) container.register(testHost.instance(m)).as(AuthorizationModel);
    if (rbac) container.register(testHost.instance(new RbacContributor(rbac))).as(AuthzContributor);
    container.register(testHost.instance(new SchemaContributor(scopeCurrent.schemas))).as(AuthzContributor);
    container.register(testHost.instance(this.store)).as(ScopeAttributeStore);
    const restore = async () => {
      current.model = undefined;
      if (ds.names().includes(name)) await container.dispose();
      cfg.unset(['authz', 'domains', name]);
      if (before === undefined) cfg.unset(['authz', 'orm', 'domain']);
      else cfg.set(['authz', 'orm', 'domain'], before);
    };
    this.undo = restore;
    current.model = rbac;
    this.service = await ds.service(name);
    return this.service;
  }

  /** The docs check() allows, by the ref the adapter gives the row and with the row as subject. */
  async allowed(p: Principal): Promise<string[]> {
    const out: string[] = [];
    for (const id of this.docIds()) {
      const subject = await runWithPrincipal(SYSTEM, async () => this.adapter.load({ type: 'doc', id }));
      if ((await this.service!.check({ principal: p, permission: PERMISSION, resource: { type: 'doc', id }, subject })).allowed) out.push(id);
    }
    return out.sort();
  }
}

/** The `native:condition.scope` leaves of a residual. */
export function scopeLeaves(f: ResourceFilter): unknown[] {
  if (f.op === SCOPE_CONDITION_OP) return [(f as { args: unknown }).args];
  if (f.op === 'and' || f.op === 'or') return f.args.flatMap(scopeLeaves);
  if (f.op === 'not') return scopeLeaves(f.arg);
  return [];
}
