import { AccessDenied, AuthorizationModel, AuthzConfigError, AuthzContributor, SYSTEM, runWithPrincipal } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, AuthzService, Principal, ResourceFilter, ResourceRef } from '@spinajs/authz';
import { OrmNativeCompiler } from '@spinajs/authz-orm';
import { accessResourceTypeOf } from '@spinajs/authz-orm/native';
import { evaluateFilter, fakeEvaluationContext, testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

// Not a root export of authz-orm; the build the package resolves to, so one copy of the module.
import { OrmResourceAdapter } from '../../../authz-orm/lib/mjs/adapter.js';
import { compileResidual } from '../../../authz-orm/lib/mjs/compile/compiler.js';
import { MemoryAssignmentStore, MemoryRoleStore, RBAC_ASSIGNMENT_OP, RBAC_THRESHOLD_OP, RbacContributor, RbacModel, createRbacExtensions, rbacAssignmentExtension, rbacTables } from '../../src/index.js';
import type { LadderDef, RbacModelOptions, RoleDef, RoleGraph } from '../../src/index.js';
import { RbacRoleGraphSource } from '../../src/orm/index.js';
import type { RbacListing } from '../../src/orm/index.js';
import { createAssignmentTable, defineDocModels, idsOf, insertAssignments } from '../orm/orm-world.js';
import type { DocModels } from '../orm/orm-world.js';
import type { Kind, RootOrm } from '../orm/root-orm.js';

/*
 * A world for args v2 routes without rules: ladders, an off-ladder role extending into one, implied roles
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
export const routeCurrent: { model?: RbacModel } = {};

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

/**
 * rbacAssignmentExtension with rules: true declares `native:rbac.threshold`, which boot rule 4 wants compiled
 * for every list type; its compiler is a later L4b task. These worlds have no rules, so no threshold term.
 */
class ThresholdStub extends OrmNativeCompiler {
  readonly op = RBAC_THRESHOLD_OP;

  compile(): void {
    throw new AuthzConfigError('route-world: no native:rbac.threshold term was expected (no rules)');
  }
}

/** Registers the stub in the root container; returns its undo. */
export function registerThresholdStub(): () => void {
  DI.uncache(OrmNativeCompiler);
  const undo = testHost.registerInRoot(OrmNativeCompiler, ThresholdStub);
  return () => {
    undo();
    DI.uncache(OrmNativeCompiler);
  };
}

let seq = 0;
let ids = 0;

export const DAY = 24 * 3600 * 1000;

export function assignment(subject: AssignmentSubject, assigned: string, scope: ResourceRef, extra: Partial<Assignment> = {}): Assignment {
  return { id: `r${++ids}`, subject, role: assigned, scope, source: 'db', expiresAt: null, ...extra };
}

/** A domain over `kind` with this world's model (rbacAssignmentExtension with rules: true), `authz.orm.domain` naming it. */
export class RouteWorld {
  readonly adapter = new OrmResourceAdapter();

  private constructor(readonly db: RootOrm, readonly kind: Kind, readonly models: DocModels, readonly model: RbacModel, readonly store: MemoryAssignmentStore, readonly service: AuthzService, private readonly undo: () => Promise<void>) {}

  static async open(db: RootOrm, kind: Kind): Promise<RouteWorld> {
    await createAssignmentTable(db.driver(kind), kind);
    const models = await defineDocModels(db, kind);
    const ds = await testHost.domains();
    const cfg = testHost.config();
    const name = `l4broute${++seq}`;
    const permissions = Object.fromEntries(PERMISSIONS.map((p) => [p, { types: ['doc'] }]));
    cfg.set(['authz', 'domains', name], { permissions, combine: { default: { algorithm: 'deny-overrides', models: ['rbac'] } }, cache: { maxEntries: 0 } });
    const before = { domain: cfg.get<unknown>(['authz', 'orm', 'domain']), rbac: cfg.get<unknown>(['authz', 'rbac']) };
    cfg.set(['authz', 'orm', 'domain'], name);
    cfg.set(['authz', 'rbac'], { serviceRoles: SERVICE_ROLES, cache: { assignmentsTtlSeconds: 0 } });
    const store = new MemoryAssignmentStore();
    const options: RbacModelOptions = { roles: new MemoryRoleStore(ROLES, LADDERS), assignments: store, log: { warn: () => undefined } };
    const model = new RbacModel({ ...options, extensions: [...createRbacExtensions(options), rbacAssignmentExtension(options, { rules: true })] });
    const container: IContainer = ds.create(name, 'root');
    container.register(testHost.instance(model)).as(AuthorizationModel);
    container.register(testHost.instance(new RbacContributor(model))).as(AuthzContributor);
    const restore = async () => {
      routeCurrent.model = undefined;
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
      const svc = await ds.service(name);
      routeCurrent.model = model;
      return new RouteWorld(db, kind, models, model, store, svc, restore);
    } catch (e) {
      await restore();
      throw e;
    }
  }

  async close(): Promise<void> {
    try {
      await this.undo();
    } finally {
      await this.db.clear();
      await this.db.raw(this.kind, 'DROP TABLE IF EXISTS "authz_assignment"');
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

  /** B06: the docs check() allows, one check per row, by the ref the adapter gives the row. */
  async allowed(p: Principal, permission: string): Promise<string[]> {
    const out: string[] = [];
    for (const id of await this.docIds()) {
      const decision = await this.service.check({ principal: p, permission, resource: { type: 'doc', id } });
      if (decision.allowed) out.push(id);
    }
    return out.sort();
  }

  /** The residual evaluated per row in memory with the model's native filters (the list evaluator of args v2). */
  async inMemory(residual: ResourceFilter, p: Principal): Promise<string[]> {
    const nativeFilters = this.model.extensions.flatMap((e) => e.nativeFilters?.() ?? []);
    const context = fakeEvaluationContext({ now: new Date(), adapters: [this.adapter], nativeFilters });
    const out: string[] = [];
    for (const id of await this.docIds()) {
      if ((await evaluateFilter(residual, { id }, { principal: p, ref: { type: 'doc', id }, context, nativeFilters })) === true) out.push(id);
    }
    return out.sort();
  }
}

/** The v2 args of every route term in `f`. */
export function routeArgs(f: ResourceFilter): Record<string, unknown>[] {
  if (f.op === RBAC_ASSIGNMENT_OP) return (f as { args: { v?: unknown } }).args.v === 2 ? [(f as { args: Record<string, unknown> }).args] : [];
  if (f.op === 'and' || f.op === 'or') return f.args.flatMap(routeArgs);
  if (f.op === 'not') return routeArgs(f.arg);
  return [];
}
