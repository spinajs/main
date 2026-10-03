import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { ManualClock, RecordingAudit, RecordingChangeBus, StaticModel, testHost } from '@spinajs/authz-testing';

import { AdminGuard, AuthorizationModel, AuthzAdminBackend, AuthzAdminFailure, AuthzClock, AuthzCommandValidator, AuthzEventSink, AuthzWriteHandler, ChangeBus, DecisionAudit, MemoryAuthzAdminBackend, TRUE, adminContainer, memoryTx, principalKey } from '@spinajs/authz';
import type { AdminContext, AuthzAdmin, AuthzCommand, AuthzEvent, AuthzService, AuthzTx, Permission, Principal, PrincipalRef, ResourceRef } from '@spinajs/authz';

type Path = string | readonly string[];

const segments = (path: Path): string[] => (Array.isArray(path) ? [...path] : (path as string).split('.').filter((s) => s !== ''));

export const { config, installHost, uninstallHost, resetHost, domains, instance } = testHost;

export const setConfig = (path: Path, value: unknown): void => config().set(segments(path), value);

export const START = new Date('2026-10-03T00:00:00.000Z');
export const HOUR = 3600_000;

export const PERMISSIONS: Record<string, { types?: string[] }> = {
  'authz:assignments.manage': { types: ['project', 'doc'] },
  'authz:links.manage': { types: ['project', 'doc'] },
  'app:members.manage': { types: ['project', 'doc'] },
  'app:project.share': { types: ['project', 'doc'] },
  'app:any.share': { types: ['project', 'doc'] },
  'authz:assignments.read': { types: ['project', 'doc'] },
  'authz:links.read': { types: ['project', 'doc'] },
  'authz:policies.read': { types: ['project', 'doc'] },
  'app:grants.read': { types: ['project', 'doc'] },
  'authz:scope.manage': { types: ['project', 'doc'] },
  'authz:attributes.read': { types: ['project', 'doc'] },
  'app:settings.manage': { types: ['project', 'doc'] },
};

export interface Row {
  readonly id: string;
  readonly subject: PrincipalRef;
  readonly role: string;
  readonly scope: ResourceRef;
}

/** The test domain's data; handlers, guard and validator reach it through adminContainer(ctx). */
export class FakeStore {
  readonly rows = new Map<string, Row>();
  readonly trace: string[] = [];
  /** What the guard saw: rows in the store when it ran. */
  readonly guardSaw: number[] = [];
  readonly contexts: AdminContext[] = [];
  /** Awaited by every apply when set. */
  gate: Promise<void> | undefined;
  private seq = 0;

  nextId(): string {
    return `a${++this.seq}`;
  }
}

async function storeOf(ctx: AdminContext): Promise<FakeStore> {
  return (await adminContainer(ctx).resolve(FakeStore)) as FakeStore;
}

type Grant = Extract<AuthzCommand, { kind: 'assignment.grant' }>;
type LinkCreate = Extract<AuthzCommand, { kind: 'link.create' }>;
type Revoke = Extract<AuthzCommand, { kind: 'assignment.revoke' }>;

type Applied = Awaited<ReturnType<AuthzWriteHandler['apply']>>;

const FORGED = { domain: 'forged', actor: { type: 'user', id: 'forged' }, at: new Date(1) };

/**
 * Roles with a meaning: `unknown` fails validate, `clash` fails apply with an AuthzAdminFailure,
 * `boom` fails apply with a plain Error, `guarded` is refused by FakeGuard.
 */
export class FakeAssignmentHandler extends AuthzWriteHandler {
  readonly kinds = ['assignment.grant', 'assignment.revoke', 'link.create'] as const;

  async validate(c: AuthzCommand, ctx: AdminContext): Promise<void> {
    const s = await storeOf(ctx);
    s.trace.push(`validate:${c.kind}`);
    s.contexts.push(ctx);
    if (c.kind === 'assignment.grant' && c.role === 'unknown') throw new AuthzAdminFailure('unknown_role', 'role "unknown" does not exist', 'role');
  }

  async permission(c: AuthzCommand, ctx: AdminContext): Promise<{ permission: Permission; resource: ResourceRef }> {
    const s = await storeOf(ctx);
    s.trace.push(`permission:${c.kind}`);
    if (c.kind === 'assignment.revoke') {
      const row = s.rows.get((c as Revoke).id);
      if (!row) throw new AuthzAdminFailure('not_found', `no assignment ${(c as Revoke).id}`, 'id');
      return { permission: 'authz:assignments.manage', resource: row.scope };
    }
    if (c.kind === 'link.create') return { permission: 'authz:links.manage', resource: (c as LinkCreate).scope };
    return { permission: 'authz:assignments.manage', resource: (c as Grant).scope };
  }

  async apply(c: AuthzCommand, ctx: AdminContext, tx: AuthzTx): Promise<{ id?: string; token?: string; affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    const s = await storeOf(ctx);
    s.trace.push(`apply:${c.kind}`);
    await s.gate;
    const undo = memoryTx(tx);
    if (c.kind === 'assignment.revoke') {
      const row = s.rows.get(c.id)!;
      s.rows.delete(c.id);
      undo.onRollback(() => s.rows.set(row.id, row));
      return { affected: 1, tags: [`subject:${principalKey(row.subject)}`], events: [{ ...FORGED, type: 'RoleRevoked', data: { id: row.id, role: row.role } }] };
    }
    if (c.kind === 'link.create') {
      const id = s.nextId();
      const row: Row = { id, subject: { type: 'link', id }, role: c.role, scope: c.scope };
      s.rows.set(id, row);
      undo.onRollback(() => s.rows.delete(id));
      return { id, token: `tok-${id}`, affected: 1, tags: [`link:${id}`], events: [{ ...FORGED, type: 'LinkCreated', data: { id, scope: c.scope, token: `tok-${id}` } }], row: { id, scope: c.scope, attributes: {}, createdBy: { type: 'user', id: 'x' } } } as Applied;
    }
    const g = c as Grant;
    if (g.role === 'boom') throw new Error('driver exploded');
    if (g.role === 'clash') throw new AuthzAdminFailure('conflict', 'the row changed meanwhile');
    const id = s.nextId();
    const row: Row = { id, subject: g.subject as PrincipalRef, role: g.role, scope: g.scope };
    s.rows.set(id, row);
    undo.onRollback(() => s.rows.delete(id));
    return { id, affected: 1, tags: [`subject:${principalKey(row.subject)}`, `role:${g.role}`], events: [{ ...FORGED, type: 'RoleAssigned', data: { id, role: g.role, scope: g.scope } }], row: { id, subject: row.subject, role: g.role, scope: g.scope, source: 'fake' } } as Applied;
  }
}

/** Refuses role `guarded`; refuses revoking the last `owner` row (it must see the batch's own writes). */
export class FakeGuard extends AdminGuard {
  async check(_actor: Principal, c: AuthzCommand, ctx: AdminContext): Promise<void> {
    const s = await storeOf(ctx);
    s.trace.push(`guard:${c.kind}`);
    s.guardSaw.push(s.rows.size);
    if (c.kind === 'assignment.grant' && c.role === 'guarded') throw new AuthzAdminFailure('escalation', 'role above the actor', 'role');
    if (c.kind === 'assignment.revoke') {
      const row = s.rows.get(c.id);
      const owners = [...s.rows.values()].filter((r) => r.role === 'owner').length;
      if (row?.role === 'owner' && owners === 1) throw new AuthzAdminFailure('last_holder', 'the last owner stays');
    }
  }
}

/** Refuses grants to user:external. */
export class FakeValidator extends AuthzCommandValidator {
  async validate(_actor: Principal, c: AuthzCommand, ctx: AdminContext): Promise<void> {
    const s = await storeOf(ctx);
    s.trace.push(`validator:${c.kind}`);
    if (c.kind === 'assignment.grant' && (c.subject as PrincipalRef).id === 'external') throw new AuthzAdminFailure('conflict', 'no external invites', 'subject');
  }
}

/** A memory backend of its own per test domain, never shared with root. */
export class TestBackend extends MemoryAuthzAdminBackend {}

export class RecordingSink extends AuthzEventSink {
  readonly batches: (readonly AuthzEvent[])[] = [];

  async publish(events: readonly AuthzEvent[]): Promise<void> {
    this.batches.push(events);
  }

  get events(): AuthzEvent[] {
    return this.batches.flat();
  }
}

export class ThrowingSink extends AuthzEventSink {
  async publish(): Promise<void> {
    throw new Error('sink down');
  }
}

export class FailingBus extends RecordingChangeBus {
  publish(change: Parameters<ChangeBus['publish']>[0]): Promise<void> {
    super.publish(change);
    return Promise.reject(new Error('bus down'));
  }
}

export class ThrowingAudit extends RecordingAudit {
  record(e: Parameters<DecisionAudit['record']>[0]): void {
    super.record(e);
    throw new Error('audit down');
  }
}

/** alice and erin hold everything, carol only conditionally, anyone else nothing. */
export function grantsModel(): StaticModel {
  return new StaticModel({
    name: 'grants',
    votes: (req) => {
      if (req.principal.id === 'alice' || req.principal.id === 'erin') return { permitWhen: TRUE };
      if (req.principal.id === 'carol') return { permitWhen: { op: 'cmp', field: 'owner', cmp: 'eq', value: 'carol' } };
      return {};
    },
  });
}

export interface AdminDomain {
  readonly name: string;
  readonly container: IContainer;
  readonly service: AuthzService;
  readonly admin: AuthzAdmin;
  readonly store: FakeStore;
  readonly bus: RecordingChangeBus;
  readonly audit: RecordingAudit;
  readonly clock: ManualClock;
  readonly sink: RecordingSink;
  readonly model: StaticModel;
  readonly backend: MemoryAuthzAdminBackend;
}

export interface AdminDomainOptions {
  readonly bus?: RecordingChangeBus;
  readonly audit?: RecordingAudit;
  readonly sinks?: readonly AuthzEventSink[];
  readonly handlers?: boolean;
  readonly backend?: boolean;
  register?(c: IContainer): void;
}

/** A child of root with the fakes above; config `authz.admin` is the caller's. */
export async function adminDomain(name = 'test', opts: AdminDomainOptions = {}): Promise<AdminDomain> {
  setConfig(['authz', 'domains', name], { permissions: PERMISSIONS, cache: { maxEntries: 0 } });
  const ds = await domains();
  const c = ds.create(name, 'root');
  const store = new FakeStore();
  const bus = opts.bus ?? new RecordingChangeBus();
  const audit = opts.audit ?? new RecordingAudit();
  const clock = new ManualClock(START);
  const sink = new RecordingSink();
  const model = grantsModel();
  c.register(instance(model)).as(AuthorizationModel);
  c.register(instance(bus)).as(ChangeBus);
  c.register(instance(audit)).as(DecisionAudit);
  c.register(instance(clock)).as(AuthzClock);
  c.register(instance(store)).as(FakeStore);
  c.register(instance(sink)).as(AuthzEventSink);
  for (const s of opts.sinks ?? []) c.register(instance(s)).as(AuthzEventSink);
  if (opts.handlers !== false) c.register(FakeAssignmentHandler).as(AuthzWriteHandler);
  c.register(FakeGuard).as(AdminGuard);
  c.register(FakeValidator).as(AuthzCommandValidator);
  if (opts.backend !== false) c.register(TestBackend).as(AuthzAdminBackend);
  opts.register?.(c);
  const service = await ds.service(name);
  // Resolved where AuthzAdmin resolves it: the registering container.
  const backend = (opts.backend !== false ? await c.resolve(TestBackend) : await DI.RootContainer.resolve(MemoryAuthzAdminBackend)) as MemoryAuthzAdminBackend;
  return { name, container: c, service, admin: service.admin(), store, bus, audit, clock, sink, model, backend };
}

/** The guard and backend every adminDomain registers. */
export function adminConfig(extra: Record<string, unknown> = {}): void {
  setConfig(['authz', 'admin'], { guard: { service: 'FakeGuard' }, backend: 'TestBackend', ...extra });
}

export async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}
