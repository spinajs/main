import type { IContainer } from '@spinajs/di';
import { FakeScopeResolver, ManualClock, RecordingAudit, RecordingChangeBus, StaticModel, testHost } from '@spinajs/authz-testing';

import { AdminGuard, AuthorizationModel, AuthzAdminBackend, AuthzAdminFailure, AuthzClock, AuthzContributor, AuthzEventSink, ChangeBus, DecisionAudit, MemoryAuthzAdminBackend, SYSTEM, ScopeResolver, TRUE, resourceKey } from '@spinajs/authz';
import type { AdminCallContext, AuthzAdmin, AuthzCommand, AuthzCommandResult, AuthzEvent, AuthzService, Policy, Principal, ResourceRef } from '@spinajs/authz';

import { AbacContributor, AbacModel, ConfigPolicyStore, MemoryPolicyStore, PolicyStore } from '../../src/index.js';

export const { config, installHost, uninstallHost, resetHost, domains, instance } = testHost;

export const START = new Date('2026-10-03T00:00:00.000Z');
export const HOUR = 3600_000;

export const G: ResourceRef = { type: '$global' };
export const O1: ResourceRef = { type: 'org', id: 'o1' };
export const P1: ResourceRef = { type: 'project', id: 'p1' };
export const P2: ResourceRef = { type: 'project', id: 'p2' };
export const F1: ResourceRef = { type: 'file', id: 'f1' };

const TYPES = ['org', 'project', 'file'];
const PERMISSIONS: Record<string, { types?: string[] }> = Object.fromEntries(['file:read', 'file:edit', 'authz:policies.manage', 'authz:policies.read', 'authz:scope.forget'].map((n) => [n, { types: TYPES }]));

/** Lets everything through unless `refuse` says otherwise (a refusal in phase B rolls the batch back). */
export class TestGuard extends AdminGuard {
  static refuse: ((c: AuthzCommand) => boolean) | undefined;
  async check(_actor: Principal, c: AuthzCommand): Promise<void> {
    if (TestGuard.refuse?.(c)) throw new AuthzAdminFailure('escalation', 'refused by the test guard');
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

/** The admin permissions (authz:*) only: alice everywhere, bob at project:p1, carol conditionally. File permissions come from ABAC. */
export function grantsModel(): StaticModel {
  return new StaticModel({
    name: 'grants',
    applies: { permissions: ['authz:*'] },
    votes: (req) => {
      if (req.principal.id === 'alice') return { permitWhen: TRUE };
      if (req.principal.id === 'bob' && resourceKey(req.resource) === 'project:p1') return { permitWhen: TRUE };
      if (req.principal.id === 'carol') return { permitWhen: { op: 'cmp', field: 'owner', cmp: 'eq', value: 'carol' } };
      return {};
    },
  });
}

export const policy = (id: string, extra: Partial<Omit<Policy, 'source'>> = {}): Omit<Policy, 'source'> => ({ id, effect: 'permit', permissions: ['file:read'], ...extra });
export const stored = (id: string, extra: Partial<Policy> = {}): Policy => ({ id, effect: 'permit', permissions: ['file:read'], source: 'memory', ...extra });
export const put = (p: Omit<Policy, 'source'>): AuthzCommand => ({ kind: 'policy.put', policy: p });
export const del = (id: string): AuthzCommand => ({ kind: 'policy.delete', id });

export interface AbacDomain {
  readonly container: IContainer;
  readonly service: AuthzService;
  readonly admin: AuthzAdmin;
  readonly store: MemoryPolicyStore;
  readonly model: AbacModel;
  readonly bus: RecordingChangeBus;
  readonly audit: RecordingAudit;
  readonly sink: RecordingSink;
  readonly clock: ManualClock;
  /** The AdminCallContext AuthzAdmin would pass, for calling the handler, reader and forgetter directly. */
  context(actor?: Principal): AdminCallContext;
}

export interface AbacDomainOptions {
  /** Policies the memory store starts with. */
  readonly policies?: readonly Policy[];
  /** A config store the model also reads (not registered as PolicyStore). */
  readonly configPolicies?: readonly Policy[];
  /** Replaces the authz.admin section (default: TestGuard, TestBackend). */
  readonly admin?: Record<string, unknown>;
  /** Leave out the PolicyStore registration or the ABAC model. */
  readonly without?: readonly ('store' | 'model')[];
  register?(c: IContainer, store: MemoryPolicyStore): void;
}

/** A child of root with an AbacModel over a MemoryPolicyStore, the very instance registered as PolicyStore. */
export async function abacDomain(name = 'test', opts: AbacDomainOptions = {}): Promise<AbacDomain> {
  config().set(['authz', 'domains', name], { permissions: PERMISSIONS, cache: { maxEntries: 0 } });
  config().set(['authz', 'admin'], opts.admin ?? { guard: { service: 'TestGuard' }, backend: 'TestBackend' });
  TestGuard.refuse = undefined;
  const ds = await domains();
  const c = ds.create(name, 'root');
  const without = new Set(opts.without ?? []);
  const store = new MemoryPolicyStore(opts.policies ?? []);
  const stores: PolicyStore[] = [store, ...(opts.configPolicies ? [new ConfigPolicyStore(opts.configPolicies)] : [])];
  const model = new AbacModel({ stores });
  const bus = new RecordingChangeBus();
  const audit = new RecordingAudit();
  const sink = new RecordingSink();
  const clock = new ManualClock(START);
  c.register(instance(grantsModel())).as(AuthorizationModel);
  if (!without.has('model')) {
    c.register(instance(model)).as(AuthorizationModel);
    c.register(instance(new AbacContributor(model))).as(AuthzContributor);
  }
  if (!without.has('store')) c.register(instance(store)).as(PolicyStore);
  // p1 and p2 sit in o1; f1 in p1.
  c.register(
    instance(
      new FakeScopeResolver({
        types: TYPES,
        nodes: [
          { ref: P1, parent: O1 },
          { ref: P2, parent: O1 },
          { ref: F1, parent: P1 },
        ],
      }),
    ),
  ).as(ScopeResolver);
  c.register(instance(bus)).as(ChangeBus);
  c.register(instance(audit)).as(DecisionAudit);
  c.register(instance(clock)).as(AuthzClock);
  c.register(instance(sink)).as(AuthzEventSink);
  c.register(TestGuard).as(AdminGuard);
  c.register(TestBackend).as(AuthzAdminBackend);
  opts.register?.(c, store);
  const service = await ds.service(name);
  const context = (actor: Principal = SYSTEM): AdminCallContext => Object.freeze({ domain: name, now: clock.now(), authz: service, actor, container: c, dryRun: false });
  return { container: c, service, admin: service.admin(), store, model, bus, audit, sink, clock, context };
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

/** The store's policies by id, for comparing before and after a batch. */
export async function snapshot(store: PolicyStore): Promise<Record<string, Policy>> {
  return Object.fromEntries((await store.load()).map((p) => [p.id, p]));
}
