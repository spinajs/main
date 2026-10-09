import { AccessDenied, AuthorizationModel, AuthzContributor, BUILTIN_CONDITION_FUNCTIONS, DefaultConditionCompiler, SYSTEM, ScopeAttributeStore, flattenAttributes, runWithPrincipal } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, AuthzContribution, AuthzService, Principal, ResourceFilter, ResourceRef, RuleDef, ScopeAttributeSchema } from '@spinajs/authz';
import { AuthzScopeAttribute_2026_10_02_00_00_00, DbScopeAttributeStore } from '@spinajs/authz-orm';
import { accessResourceTypeOf } from '@spinajs/authz-orm/native';
import { evaluateFilter, fakeEvaluationContext, testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';

// The engine merges attribute layers with these but does not export them; read its build directly.
import { mergeAttributes, schemaIndex } from '../../../authz/lib/mjs/engine/attributes.js';
// Not a root export of authz-orm; the build the package resolves to, so one copy of the module.
import { OrmResourceAdapter } from '../../../authz-orm/lib/mjs/adapter.js';
import { compileResidual } from '../../../authz-orm/lib/mjs/compile/compiler.js';
import { AuthzRbac_2026_10_01_00_00_00, ConfigRuleStore, DbRuleStore, MemoryAssignmentStore, MemoryRoleStore, RBAC_ASSIGNMENT_OP, RBAC_THRESHOLD_OP, RbacContributor, RbacModel, createRbacExtensions, rbacAssignmentExtension, rbacTables } from '../../src/index.js';
import type { LadderDef, RbacModelOptions, RoleDef, RoleGraph, RuleStore } from '../../src/index.js';
import { RbacRoleGraphSource, RbacScopeAttributeSource, RbacScopeDefaults, ormRbacScopeLayers } from '../../src/orm/index.js';
import type { RbacListing } from '../../src/orm/index.js';
import { createAssignmentTable, defineDocModels, idsOf, insertAssignments } from '../orm/orm-world.js';
import type { DocModels } from '../orm/orm-world.js';
import { RootOrm } from '../orm/root-orm.js';
import type { Kind } from '../orm/root-orm.js';

/*
 * A world for args v2 routes and rules (`configure`: config rules, scope attribute schemas and rows): ladders,
 * an off-ladder role extending into one, implied roles
 * ('self-and-descendants' and 'descendants', tags, bypass), a subject set, scope types, an unassignable
 * role, config roles of a service principal, grants with requiresTag and grantedAt on and off a ladder.
 * Doc rows and their org/project models come from the task "orm" harness (orm-world.ts).
 */

export const PERMISSIONS = ['doc:read', 'doc:comment', 'doc:edit', 'doc:inspect', 'doc:audit', 'doc:export', 'doc:review', 'doc:org'] as const;

export const LADDERS: readonly LadderDef[] = [
  { name: 'project', roles: ['viewer', 'commenter', 'editor', 'maintainer'] },
  // Its grants do not apply on docs.
  { name: 'org', roles: ['org.guest', 'org.owner', 'org.admin'], resourceTypes: ['org', 'project'] },
];

const role = (name: string, grants: RoleDef['grants'], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', grants, ...extra });

export const ROLES: readonly RoleDef[] = [
  role('viewer', [{ permission: 'doc:read' }, { permission: 'doc:inspect', requiresTag: 'inspect' }], { ladder: 'project' }),
  role('commenter', [{ permission: 'doc:comment' }], { ladder: 'project' }),
  role('editor', [{ permission: 'doc:edit' }, { permission: 'doc:audit', grantedAt: ['project', '$global'] }], { ladder: 'project' }),
  role('maintainer', [{ permission: 'doc:review', requiresTag: 'review', grantedAt: ['org', 'project'] }], { ladder: 'project' }),
  // Off the ladder, holding commenter (and viewer) through extends.
  role('auditor', [{ permission: 'doc:export', grantedAt: ['org'] }], { extends: ['commenter'] }),
  // Off the ladder, holding editor: a holder of editor's grants without a rank for their grantedAt.
  role('senior', [], { extends: ['editor'] }),
  role('org.guest', [{ permission: 'doc:org' }], { ladder: 'org' }),
  role('org.owner', [], { ladder: 'org', scopeTypes: ['org'], implies: [{ role: 'maintainer', at: 'self-and-descendants', tags: ['inspect'] }] }),
  role('team.lead', [], { implies: [{ role: 'editor', at: 'descendants', tags: ['review'] }] }),
  role('lead.plus', [{ permission: 'doc:export', grantedAt: ['project'] }], { extends: ['team.lead'] }),
  role('support', [], { implies: [{ role: 'viewer', at: 'self-and-descendants', bypass: ['restrict', 'cap'] }] }),
  // Bypasses restrict, not cap: it outlives a source the restrict drops, and caps still act on it.
  role('skipper', [], { implies: [{ role: 'commenter', at: 'self-and-descendants', bypass: ['restrict'] }] }),
  role('robot', [], { implies: [{ role: 'commenter', at: 'descendants', tags: ['inspect'] }] }),
  role('projectOnly', [{ permission: 'doc:edit' }], { scopeTypes: ['project'] }),
  role('ghost', [{ permission: 'doc:read' }], { assignable: false }),
  role('team.member', [], { subjectSet: true, scopeTypes: ['team'] }),
  // Above org.owner on its ladder: inherits its implies through the ladder edge, and may be assigned at a doc.
  role('org.admin', [], { ladder: 'org' }),
  // A tag with ',' can be on no stored row (normaliseTags refuses it), only on an implied entry.
  role('tagger', [{ permission: 'doc:read', requiresTag: 'a,b' }]),
];

export const SERVICE = 's1';
// s2's team.lead implies editor below GLOBAL: a config role meeting doc:audit's grantedAt ['$global', 'project'].
export const SERVICE_ROLES = { [`service:${SERVICE}`]: ['robot', 'support'], 'service:s2': ['team.lead'] };

export const at = (type: string, id?: string): ResourceRef => (id === undefined ? { type } : { type, id });
export const u = (id: string): AssignmentSubject => ({ type: 'user', id });
export const team = (id: string): AssignmentSubject => ({ set: { role: 'team.member', scope: at('team', id) } });

export const user = (id: string, ceiling?: readonly string[]): Principal => ({ type: 'user', id, authenticated: true, source: 'session', attributes: {}, ...(ceiling ? { ceiling: { roles: [...ceiling] } } : {}) } as Principal);
export const service = (id: string = SERVICE, ceiling?: readonly string[]): Principal => ({ type: 'service', id, authenticated: true, source: 'token', attributes: {}, ...(ceiling ? { ceiling: { roles: [...ceiling] } } : {}) } as Principal);

/** The model whose graph and tables the compiler reads; the test registers this source in the root container. */
export const routeCurrent: { model?: RbacModel; schemas?: readonly ScopeAttributeSchema[] } = {};

export class RouteGraphSource extends RbacRoleGraphSource {
  graph(model: unknown): RoleGraph | undefined {
    return this.serves(model) ? routeCurrent.model!.roleGraph() : undefined;
  }

  listing(model: unknown): RbacListing | undefined {
    if (!this.serves(model)) return undefined;
    const m = routeCurrent.model!;
    const roles = m.roleGraph();
    const grants = m.grantIndex();
    return { roles, grants, ...rbacTables(m.extensions, roles, grants) };
  }

  private serves(model: unknown): boolean {
    return routeCurrent.model !== undefined && accessResourceTypeOf(model as never) === 'doc';
  }
}

/** The schema defaults and layers the compiler reads scope attributes with, for the current world's docs. */
export class RouteAttributeSource extends RbacScopeAttributeSource {
  defaults(model: unknown, driver: OrmDriver): RbacScopeDefaults | undefined {
    if (routeCurrent.model === undefined || accessResourceTypeOf(model as never) !== 'doc') return undefined;
    return RbacScopeDefaults.of(routeCurrent.schemas ?? [], ormRbacScopeLayers(driver));
  }
}

/** Registers the role graph and scope attribute sources in the root container; returns their undo. */
export function registerRouteSources(): () => void {
  const undo = [testHost.registerInRoot(RbacRoleGraphSource, testHost.instance(new RouteGraphSource())), testHost.registerInRoot(RbacScopeAttributeSource, testHost.instance(new RouteAttributeSource()))];
  return () => {
    for (const u of undo) u();
  };
}

/** Docs with a string `name` column, for thresholds over `resource.name`. */
export const DOC_NAMES: Readonly<Record<string, string | null>> = { '1': 'release/1', '2': 'notes', '3': 'release/2/fix', '4': 'Release/3', '5': 'release/', '6': 'releasе/1', '7': 'release_1', '8': null };

/** Scope attribute schemas through a contributor, as a host's models give them. */
class SchemaContributor extends AuthzContributor {
  constructor(private readonly schemas: readonly ScopeAttributeSchema[]) {
    super();
  }

  contribute(): AuthzContribution {
    return { scopeAttributeSchemas: [...this.schemas] };
  }
}

export interface RouteWorldOptions {
  /** Config rules of the model (ConfigRuleStore); the list extension binds them into args v2. */
  readonly rules?: readonly Omit<RuleDef, 'source'>[];
  readonly schemas?: readonly ScopeAttributeSchema[];
  /** Scope attributes written to authz_scope_attribute (DbScopeAttributeStore, the domain's store). */
  readonly attributes?: ReadonlyArray<readonly [ResourceRef, Readonly<Record<string, unknown>>]>;
  /** Stored rules: the model gets a DbRuleStore beside its ConfigRuleStore, and these are written through it (`putWithLadders`). */
  readonly dbRules?: readonly Omit<RuleDef, 'source'>[];
  /** The role definitions, default ROLES (the ladders stay LADDERS). */
  readonly roles?: readonly RoleDef[];
}

/** An `authz_rule` row as a test writes it past the store (raw columns and its subject rows). */
export interface RawRuleRow {
  readonly rule: Readonly<Record<string, unknown>>;
  readonly subjects?: readonly Readonly<Record<string, unknown>>[];
}

/**
 * Postgres JIT-compiles a query whose estimated cost passes jit_above_cost, and the rule terms of a dozen rules
 * take it seconds per query (L4b task "rules" report): these suites measure the SQL, not the JIT. New sessions of
 * the database start without it; the open ones are ended, and the pool replaces them.
 */
export async function withoutJit(db: RootOrm): Promise<void> {
  await db.raw('postgres', `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET jit = off', current_database()); END $$`);
  await db.raw('postgres', 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()');
  await db.raw('postgres', 'SET jit = off');
}

let seq = 0;
let ids = 0;

export const DAY = 24 * 3600 * 1000;

export function assignment(subject: AssignmentSubject, assigned: string, scope: ResourceRef, extra: Partial<Assignment> = {}): Assignment {
  return { id: `r${++ids}`, subject, role: assigned, scope, source: 'db', expiresAt: null, ...extra };
}

/**
 * A domain over `kind` with this world's model (rbacAssignmentExtension with rules: true), `authz.orm.domain`
 * naming it; `configure` replaces the domain and model (rules, scope attributes) over the same tables.
 */
export class RouteWorld {
  readonly adapter = new OrmResourceAdapter();
  model!: RbacModel;
  store!: MemoryAssignmentStore;
  service!: AuthzService;
  private undo?: () => Promise<void>;
  private readonly attributes: DbScopeAttributeStore;
  /** The model's DbRuleStore when `dbRules` is given: the root container, whose configuration names this kind's connection. */
  readonly ruleStore = new DbRuleStore(DI.RootContainer);

  private constructor(readonly db: RootOrm, readonly kind: Kind, readonly models: DocModels) {
    this.attributes = new DbScopeAttributeStore({ connection: RootOrm.connectionOf(kind) });
  }

  static async open(db: RootOrm, kind: Kind, opts: RouteWorldOptions = {}): Promise<RouteWorld> {
    // The rule tables of the real migration; authz_assignment as the orm harness makes it.
    await new AuthzRbac_2026_10_01_00_00_00().up(db.driver(kind));
    await db.raw(kind, 'DROP TABLE "authz_assignment"');
    await createAssignmentTable(db.driver(kind), kind);
    await new AuthzScopeAttribute_2026_10_02_00_00_00().up(db.driver(kind));
    if (kind === 'postgres') await withoutJit(db);
    const world = new RouteWorld(db, kind, await defineDocModels(db, kind, [], DOC_NAMES));
    await world.configure(opts);
    return world;
  }

  /** A new domain and model with these rules, schemas and scope attributes; the assignments stay. */
  async configure(opts: RouteWorldOptions = {}): Promise<void> {
    await this.undo?.();
    this.undo = undefined;
    const ds = await testHost.domains();
    const cfg = testHost.config();
    const name = `l4broute${++seq}`;
    const permissions = Object.fromEntries(PERMISSIONS.map((p) => [p, { types: ['doc'] }]));
    // A Postgres busy with other suites can take seconds per query: a check past the default model timeout
    // refuses, which a test would read as SQL listing a row the check refuses.
    cfg.set(['authz', 'domains', name], { permissions, combine: { default: { algorithm: 'deny-overrides', models: ['rbac'] } }, cache: { maxEntries: 0 }, engine: { modelTimeoutMs: 120000 } });
    const before = { domain: cfg.get<unknown>(['authz', 'orm', 'domain']), rbac: cfg.get<unknown>(['authz', 'rbac']) };
    cfg.set(['authz', 'orm', 'domain'], name);
    cfg.set(['authz', 'rbac'], { serviceRoles: SERVICE_ROLES, cache: { assignmentsTtlSeconds: 0 }, connection: RootOrm.connectionOf(this.kind) });
    const store = new MemoryAssignmentStore(this.store?.all() ?? []);
    const ruleStores: RuleStore[] = [...(opts.rules ? [new ConfigRuleStore(opts.rules as RuleDef[])] : []), ...(opts.dbRules ? [this.ruleStore] : [])];
    const options: RbacModelOptions = { roles: new MemoryRoleStore(opts.roles ?? ROLES, LADDERS), assignments: store, log: { warn: () => undefined }, ...(ruleStores.length > 0 ? { rules: ruleStores } : {}) };
    const model = new RbacModel({ ...options, extensions: [...createRbacExtensions(options), rbacAssignmentExtension(options, { rules: true })] });
    const container: IContainer = ds.create(name, 'root');
    container.register(testHost.instance(model)).as(AuthorizationModel);
    container.register(testHost.instance(new RbacContributor(model))).as(AuthzContributor);
    container.register(testHost.instance(new SchemaContributor(opts.schemas ?? []))).as(AuthzContributor);
    container.register(testHost.instance(this.attributes)).as(ScopeAttributeStore);
    const restore = async () => {
      routeCurrent.model = undefined;
      routeCurrent.schemas = undefined;
      if (ds.names().includes(name)) await container.dispose();
      cfg.unset(['authz', 'domains', name]);
      for (const [key, value] of [
        [['authz', 'orm', 'domain'], before.domain],
        [['authz', 'rbac'], before.rbac],
      ] as const) {
        if (value === undefined) cfg.unset([...key]);
        else cfg.set([...key], value);
      }
    };
    try {
      await this.writeAttributes(opts.attributes ?? []);
      await this.writeRules(opts.dbRules ?? []);
      this.service = await ds.service(name);
      this.model = model;
      this.store = store;
      routeCurrent.model = model;
      routeCurrent.schemas = opts.schemas ?? [];
      this.undo = restore;
    } catch (e) {
      await restore();
      throw e;
    }
  }

  async close(): Promise<void> {
    try {
      await this.undo?.();
    } finally {
      await this.db.clear();
      await new AuthzRbac_2026_10_01_00_00_00().down(this.db.driver(this.kind));
      await new AuthzScopeAttribute_2026_10_02_00_00_00().down(this.db.driver(this.kind));
    }
  }

  /** As AuthzAdmin writes them: every earlier row removed, then flattenAttributes in one transaction. */
  private async writeAttributes(nodes: NonNullable<RouteWorldOptions['attributes']>): Promise<void> {
    const driver = this.db.driver(this.kind);
    await this.db.raw(this.kind, 'DELETE FROM "authz_scope_attribute"');
    if (nodes.length === 0) return;
    await driver.transaction(async (tx: OrmDriver) => {
      for (const [ref, attributes] of nodes) await this.attributes.write(ref, { set: flattenAttributes(attributes).set, remove: [] }, { type: 'user', id: 'root' }, { driver: tx });
    });
  }

  /** As AuthzAdmin's rule.put writes them: every earlier rule removed, then DbRuleStore.putWithLadders in one transaction. */
  private async writeRules(rules: readonly Omit<RuleDef, 'source'>[]): Promise<void> {
    const driver = this.db.driver(this.kind);
    await this.db.raw(this.kind, 'DELETE FROM "authz_rule_subject"');
    await this.db.raw(this.kind, 'DELETE FROM "authz_rule"');
    if (rules.length === 0) return;
    await driver.transaction(async (tx: OrmDriver) => {
      for (const rule of rules) await this.ruleStore.putWithLadders(rule, LADDERS, { type: 'user', id: 'root' }, { driver: tx });
    });
  }

  /** Writes rule rows past the store: what no AuthzAdmin write gives (a stale rank, a definition beyond the columns). */
  async writeRawRules(rows: readonly RawRuleRow[]): Promise<void> {
    const driver = this.db.driver(this.kind);
    for (const r of rows) {
      await driver
        .insert()
        .into('authz_rule')
        .values({ created_by: 'user:root', created_at: new Date(), ...r.rule });
      for (const s of r.subjects ?? [])
        await driver
          .insert()
          .into('authz_rule_subject')
          .values({ ...s });
    }
  }

  /** Replaces every assignment, in the model's store and in `authz_assignment`. */
  async assign(rows: readonly Assignment[]): Promise<void> {
    for (const a of this.store.all()) this.store.remove(a.id);
    for (const a of rows) this.store.add(a);
    await this.db.raw(this.kind, 'DELETE FROM "authz_assignment"');
    await insertAssignments(this.db.driver(this.kind), rows);
  }

  query(): any {
    return (this.models.Doc as unknown as { query(): any }).query();
  }

  async docIds(): Promise<string[]> {
    return ((await this.db.raw(this.kind, `SELECT "id" FROM "${this.db.table(this.models.Doc)}"`)) as Array<{ id: unknown }>).map((r) => String(r.id)).sort();
  }

  residual(p: Principal, permission: string): Promise<ResourceFilter> {
    return this.service.filter(p, permission, 'doc');
  }

  /** What authz-orm's middleware lists for `p`; a FALSE residual is refused before any SQL runs (H16), which lists nothing. */
  async listed(p: Principal, permission: string): Promise<string[]> {
    if (permission !== 'doc:read') return this.compiled(await this.residual(p, permission), p);
    const residual = await this.residual(p, permission);
    try {
      return idsOf(await runWithPrincipal(p, async () => this.query()));
    } catch (e) {
      if (e instanceof AccessDenied && residual.op === 'false') return [];
      throw e;
    }
  }

  /** The residual through authz-orm's compiler (what the middleware runs), outside a principal's scope. */
  compiled(residual: ResourceFilter, p: Principal): Promise<string[]> {
    return runWithPrincipal(SYSTEM, async () => {
      const q = this.query();
      compileResidual(residual, q, { model: this.models.Doc, principal: p, op: 'read' });
      return idsOf(await q);
    });
  }

  /** The row the adapter loads for a doc id (the check's subject). */
  row(id: string): Promise<unknown> {
    return runWithPrincipal(SYSTEM, async () => this.adapter.load({ type: 'doc', id }));
  }

  /** B06: the docs check() allows, one check per row, by the ref the adapter gives the row and with the row as subject. */
  async allowed(p: Principal, permission: string): Promise<string[]> {
    const out: string[] = [];
    for (const id of await this.docIds()) {
      const decision = await this.service.check({ principal: p, permission, resource: { type: 'doc', id }, subject: await this.row(id) });
      if (decision.allowed) out.push(id);
    }
    return out.sort();
  }

  /**
   * The residual evaluated per row in memory with the model's native filters (the list evaluator of args v2),
   * the row as subject, conditions through the core compiler, scope attributes layered as the engine layers them.
   */
  async inMemory(residual: ResourceFilter, p: Principal): Promise<string[]> {
    const nativeFilters = this.model.extensions.flatMap((e) => e.nativeFilters?.() ?? []);
    const base = fakeEvaluationContext({ now: new Date(), adapters: [this.adapter], nativeFilters, conditions: new DefaultConditionCompiler(BUILTIN_CONDITION_FUNCTIONS) });
    const context = { ...base, attributes: (ref: ResourceRef) => this.layered(ref) } as typeof base;
    const out: string[] = [];
    for (const id of await this.docIds()) {
      if ((await evaluateFilter(residual, await this.row(id), { principal: p, ref: { type: 'doc', id }, context, nativeFilters })) === true) out.push(id);
    }
    return out.sort();
  }

  /** Schema defaults ⊕ the adapter's attributes ⊕ the store's (the engine's `loadAttributes`); null for a node the adapter does not find. */
  private async layered(ref: ResourceRef): Promise<Readonly<Record<string, unknown>> | null> {
    const own = this.adapter.types.includes(ref.type) ? await runWithPrincipal(SYSTEM, async () => this.adapter.scopeAttributes(ref)) : {};
    if (own === null) return null;
    return mergeAttributes([schemaIndex(routeCurrent.schemas ?? []).get(ref.type) ?? {}, own, await this.attributes.get(ref)]) as Readonly<Record<string, unknown>>;
  }
}

/** The args of every threshold term in `f`. */
export function thresholdArgs(f: ResourceFilter): Record<string, unknown>[] {
  if (f.op === RBAC_THRESHOLD_OP) return [(f as { args: Record<string, unknown> }).args];
  if (f.op === 'and' || f.op === 'or') return f.args.flatMap(thresholdArgs);
  if (f.op === 'not') return thresholdArgs(f.arg);
  return [];
}

/** The v2 args of every route term in `f`. */
export function routeArgs(f: ResourceFilter): Record<string, unknown>[] {
  if (f.op === RBAC_ASSIGNMENT_OP) return (f as { args: { v?: unknown } }).args.v === 2 ? [(f as { args: Record<string, unknown> }).args] : [];
  if (f.op === 'and' || f.op === 'or') return f.args.flatMap(routeArgs);
  if (f.op === 'not') return routeArgs(f.arg);
  return [];
}
