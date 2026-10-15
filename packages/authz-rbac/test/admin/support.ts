import type { IContainer } from '@spinajs/di';
import { ManualClock, RecordingAudit, RecordingChangeBus, StaticModel, testHost } from '@spinajs/authz-testing';

import { AdminGuard, AuthorizationModel, AuthzAdminBackend, AuthzAdminFailure, AuthzClock, AuthzEventSink, ChangeBus, DecisionAudit, MemoryAuthzAdminBackend, PermissionRegistry, PermissionRegistryImpl, TRUE, resourceKey } from '@spinajs/authz';
import type { AuthzAdmin, AuthzCommand, AuthzCommandResult, AuthzEvent, AuthzService, Principal, ResourceRef } from '@spinajs/authz';

import { AdminAssignmentStore, AdminLinkStore, AdminRuleStore, AssignmentStore, LinkStore, MemoryAdminAssignmentStore, MemoryLinkStore, MemoryRuleStore, RoleStore, RuleStore } from '../../src/index.js';
import type { Assignment, LadderDef, MemoryLinkStoreOptions, RoleDef } from '../../src/index.js';

export const { config, installHost, uninstallHost, resetHost, domains, instance } = testHost;

export const START = new Date('2026-10-03T00:00:00.000Z');
export const HOUR = 3600_000;

export const G: ResourceRef = { type: '$global' };
export const O1: ResourceRef = { type: 'org', id: 'o1' };
export const P1: ResourceRef = { type: 'project', id: 'p1' };
export const P2: ResourceRef = { type: 'project', id: 'p2' };
export const F1: ResourceRef = { type: 'file', id: 'f1' };
export const GR: ResourceRef = { type: 'group', id: 'g1' };

const TYPES = ['org', 'project', 'file', 'group'];
type PermissionConfig = Record<string, { types?: string[]; implies?: string[] }>;

const PERMISSIONS: PermissionConfig = Object.fromEntries(['authz:assignments.manage', 'authz:links.manage', 'authz:rules.manage', 'authz:assignments.read', 'authz:links.read', 'authz:rules.read', 'authz:scope.forget', 'file:read', 'file:edit', 'project:settings'].map((n) => [n, { types: TYPES }]));

const role = (name: string, extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], grants: [], assignable: true, source: 'test', ...extra });

export const ROLES: RoleDef[] = [role('viewer', { ladder: 'project', grants: [{ permission: 'file:read' }] }), role('editor', { ladder: 'project', grants: [{ permission: 'file:edit' }] }), role('maintainer', { ladder: 'project' }), role('plain'), role('package', { assignable: false }), role('org.member', { scopeTypes: ['org'], subjectSet: true }), role('org.admin', { scopeTypes: ['org'] }), role('group.member', { subjectSet: true, scopeTypes: ['group'] }), role('locked.set', { subjectSet: true, assignable: false })];
export const LADDERS: LadderDef[] = [
  { name: 'project', roles: ['viewer', 'editor', 'maintainer'] },
  { name: 'org', roles: ['org.member', 'org.admin'] },
];

export class StaticRoleStore extends RoleStore {
  constructor(readonly name: string, private readonly roles: readonly RoleDef[], private readonly ladders: readonly LadderDef[] = []) {
    super();
  }
  async load() {
    return { roles: this.roles, ladders: this.ladders };
  }
  async version() {
    return '1';
  }
}

/** Lets everything through; task 6 brings DefaultAdminGuard. */
export class PermissiveGuard extends AdminGuard {
  readonly seen: AuthzCommand[] = [];
  async check(_actor: Principal, c: AuthzCommand): Promise<void> {
    this.seen.push(c);
  }
}

export class RecordingSink extends AuthzEventSink {
  readonly batches: (readonly AuthzEvent[])[] = [];
  async publish(events: readonly AuthzEvent[]): Promise<void> {
    this.batches.push(events);
  }
  get events(): AuthzEvent[] {
    return this.batches.flat();
  }
}

/** A memory backend of its own per test domain. */
export class TestBackend extends MemoryAuthzAdminBackend {}

/** alice holds everything everywhere; bob only at project:p1; carol only conditionally; anyone else nothing. */
export function grantsModel(): StaticModel {
  return new StaticModel({
    name: 'grants',
    votes: (req) => {
      if (req.principal.id === 'alice') return { permitWhen: TRUE };
      if (req.principal.id === 'bob' && resourceKey(req.resource) === 'project:p1') return { permitWhen: TRUE };
      if (req.principal.id === 'carol') return { permitWhen: { op: 'cmp', field: 'owner', cmp: 'eq', value: 'carol' } };
      return {};
    },
  });
}

export interface RbacDomain {
  readonly container: IContainer;
  readonly service: AuthzService;
  readonly admin: AuthzAdmin;
  readonly assignments: MemoryAdminAssignmentStore;
  readonly links: MemoryLinkStore;
  readonly rules: MemoryRuleStore;
  readonly bus: RecordingChangeBus;
  readonly audit: RecordingAudit;
  readonly sink: RecordingSink;
  readonly clock: ManualClock;
}

export interface RbacDomainOptions {
  readonly roleStores?: readonly RoleStore[];
  /** Rows the assignment store starts with. */
  readonly assignments?: readonly Assignment[];
  /** Links (with fixed tokens) the link store starts with. */
  readonly links?: MemoryLinkStoreOptions['links'];
  /** Replaces the authz.admin section (default: PermissiveGuard, TestBackend). */
  readonly admin?: Record<string, unknown>;
  /** Replaces grantsModel(). */
  readonly model?: AuthorizationModel;
  /** Declared besides the default permissions. */
  readonly permissions?: PermissionConfig;
  /** Leave these stores out. */
  readonly without?: readonly ('assignments' | 'links' | 'rules' | 'roles')[];
  register?(c: IContainer): void;
}

export async function rbacDomain(name = 'test', opts: RbacDomainOptions = {}): Promise<RbacDomain> {
  config().set(['authz', 'domains', name], { permissions: { ...PERMISSIONS, ...opts.permissions }, cache: { maxEntries: 0 } });
  config().set(['authz', 'admin'], { connection: 'default', ...(opts.admin ?? { guard: { service: 'PermissiveGuard' }, backend: 'TestBackend' }) });
  const ds = await domains();
  const c = ds.create(name, 'root');
  const without = new Set(opts.without ?? []);
  const assignments = new MemoryAdminAssignmentStore({ assignments: opts.assignments });
  const links = new MemoryLinkStore(assignments, { links: opts.links });
  const rules = new MemoryRuleStore();
  const bus = new RecordingChangeBus();
  const audit = new RecordingAudit();
  const sink = new RecordingSink();
  const clock = new ManualClock(START);
  c.register(instance(opts.model ?? grantsModel())).as(AuthorizationModel);
  // grantsModel exposes no permissions(), and RbacRuleListGuard needs a registry on every rule.put.
  if (!opts.model) c.register(instance(permissionRegistry(opts.permissions))).as(PermissionRegistry);
  c.register(instance(bus)).as(ChangeBus);
  c.register(instance(audit)).as(DecisionAudit);
  c.register(instance(clock)).as(AuthzClock);
  c.register(instance(sink)).as(AuthzEventSink);
  c.register(PermissiveGuard).as(AdminGuard);
  c.register(TestBackend).as(AuthzAdminBackend);
  if (!without.has('assignments')) {
    c.register(instance(assignments)).as(AssignmentStore);
    c.register(instance(assignments)).as(AdminAssignmentStore);
  }
  if (!without.has('links')) {
    c.register(instance(links)).as(LinkStore);
    c.register(instance(links)).as(AdminLinkStore);
  }
  if (!without.has('rules')) {
    c.register(instance(rules)).as(RuleStore);
    c.register(instance(rules)).as(AdminRuleStore);
  }
  if (!without.has('roles')) for (const s of opts.roleStores ?? [new StaticRoleStore('static', ROLES, LADDERS)]) c.register(instance(s)).as(RoleStore);
  opts.register?.(c);
  const service = await ds.service(name);
  return { container: c, service, admin: service.admin(), assignments, links, rules, bus, audit, sink, clock };
}

/** The permissions rbacDomain declares (plus `extra`) as a registry of their own: the host keeps the domain's registry to itself. */
export function permissionRegistry(extra: PermissionConfig = {}): PermissionRegistry {
  const registry = new PermissionRegistryImpl();
  registry.register(
    Object.entries({ ...PERMISSIONS, ...extra }).map(([name, def]) => ({ ...def, name })),
    'test',
  );
  registry.freeze();
  return registry;
}

export type Failed = Extract<AuthzCommandResult, { ok: false }>;

/** The failed result of a batch: its index and error. */
export function failure(results: readonly AuthzCommandResult[]): { at: number; code: string; field?: string } {
  const at = results.findIndex((r) => !r.ok);
  if (at < 0) throw new Error(`expected a failed batch, got ${JSON.stringify(results)}`);
  const e = (results[at] as Failed).error;
  return { at, code: e.code, ...(e.field !== undefined ? { field: e.field } : {}) };
}

export function ok(results: readonly AuthzCommandResult[]): Extract<AuthzCommandResult, { ok: true }>[] {
  const bad = results.find((r) => !r.ok);
  if (bad) throw new Error(`expected a committed batch, got ${JSON.stringify(bad)}`);
  return results as Extract<AuthzCommandResult, { ok: true }>[];
}

export async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

export { AuthzAdminFailure };
