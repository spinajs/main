import type { IContainer } from '@spinajs/di';
import { ManualClock, RecordingAudit, RecordingChangeBus, StaticModel, testHost } from '@spinajs/authz-testing';

import { AdminGuard, AuthzAdminBackend, AuthzAdminFailure, AuthzClock, AuthzEventSink, ChangeBus, DecisionAudit, MemoryAuthzAdminBackend, SYSTEM, TRUE, resourceKey } from '@spinajs/authz';
import type { AdminCallContext, AuthzAdmin, AuthzCommand, AuthzCommandResult, AuthzEvent, AuthzService, Principal } from '@spinajs/authz';

import { MemoryTupleStore, RebacModel, TupleStore } from '../../src/index.js';
import type { Tuple } from '../../src/index.js';
import { NAMESPACES, PERMISSIONS } from '../support/world.js';

export const { config, installHost, uninstallHost, resetHost, domains, instance } = testHost;

export const START = new Date('2026-10-21T00:00:00.000Z');

const TYPES = ['doc', 'folder', 'group'];
const PERMISSION_DEFS: Record<string, { types?: string[] }> = {
  ...Object.fromEntries(['doc:read', 'doc:edit', 'doc:view'].map((n) => [n, { types: ['doc'] }])),
  'folder:read': { types: ['folder'] },
  ...Object.fromEntries(['authz:tuples.manage', 'authz:tuples.read', 'authz:scope.forget'].map((n) => [n, { types: TYPES }])),
};

export class TestGuard extends AdminGuard {
  async check(): Promise<void> {
    return undefined;
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

export class TestBackend extends MemoryAuthzAdminBackend {}

/** The admin permissions (authz:*): alice everywhere, bob on doc:d1 only. */
export function grantsModel(): StaticModel {
  return new StaticModel({
    name: 'grants',
    applies: { permissions: ['authz:*'] },
    votes: (req) => {
      if (req.principal.id === 'alice') return { permitWhen: TRUE };
      if (req.principal.id === 'bob' && resourceKey(req.resource) === 'doc:d1') return { permitWhen: TRUE };
      return {};
    },
  });
}

export const write = (tuple: Tuple): AuthzCommand => ({ kind: 'tuple.write', tuple });
export const remove = (tuple: Tuple): AuthzCommand => ({ kind: 'tuple.delete', tuple });

export interface RebacDomain {
  readonly container: IContainer;
  readonly service: AuthzService;
  readonly admin: AuthzAdmin;
  readonly store: MemoryTupleStore;
  readonly model: RebacModel;
  readonly bus: RecordingChangeBus;
  readonly audit: RecordingAudit;
  readonly sink: RecordingSink;
  context(actor?: Principal): AdminCallContext;
}

/** A child of root with a RebacModel over a MemoryTupleStore, the very instance registered as TupleStore. */
export async function rebacDomain(name = 'test', opts: { readonly tuples?: readonly Tuple[]; readonly without?: readonly ('store' | 'model')[] } = {}): Promise<RebacDomain> {
  config().set(['authz', 'domains', name], { permissions: PERMISSION_DEFS, cache: { maxEntries: 0 } });
  config().set(['authz', 'admin'], { guard: { service: 'TestGuard' }, backend: 'TestBackend' });
  const ds = await domains();
  const c = ds.create(name, 'root');
  const without = new Set(opts.without ?? []);
  const store = new MemoryTupleStore(opts.tuples ?? []);
  const model = new RebacModel({ store, namespaces: NAMESPACES, permissions: PERMISSIONS });
  const bus = new RecordingChangeBus();
  const audit = new RecordingAudit();
  const sink = new RecordingSink();
  const clock = new ManualClock(START);
  testHost.activate(c, name, grantsModel());
  if (!without.has('model')) testHost.activate(c, name, model);
  if (!without.has('store')) c.register(instance(store)).as(TupleStore);
  c.register(instance(bus)).as(ChangeBus);
  c.register(instance(audit)).as(DecisionAudit);
  c.register(instance(clock)).as(AuthzClock);
  c.register(instance(sink)).as(AuthzEventSink);
  c.register(TestGuard).as(AdminGuard);
  c.register(TestBackend).as(AuthzAdminBackend);
  const service = await ds.service(name);
  const context = (actor: Principal = SYSTEM): AdminCallContext => Object.freeze({ domain: name, now: clock.now(), authz: service, actor, container: c, dryRun: false });
  return { container: c, service, admin: service.admin(), store, model, bus, audit, sink, context };
}

/** The failed result of a batch: its index and error. */
export function failure(results: readonly AuthzCommandResult[]): { at: number; code: string; field?: string } {
  const at = results.findIndex((r) => !r.ok);
  if (at < 0) throw new Error(`expected a failed batch, got ${JSON.stringify(results)}`);
  const e = (results[at] as Extract<AuthzCommandResult, { ok: false }>).error;
  return { at, code: e.code, ...(e.field !== undefined ? { field: e.field } : {}) };
}

export function ok(results: readonly AuthzCommandResult[]): Extract<AuthzCommandResult, { ok: true }>[] {
  const bad = results.find((r) => !r.ok);
  if (bad) throw new Error(`expected a committed batch, got ${JSON.stringify(bad)}`);
  return results as Extract<AuthzCommandResult, { ok: true }>[];
}

export { AuthzAdminFailure };
