import 'mocha';
import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { currentPrincipal, runWithPrincipal } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { MigrationTransactionMode } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import '@spinajs/orm-sqlite';
import type { Principal } from '@spinajs/principal';
import { Job, QueueJob, SystemTask } from '@spinajs/queue';
import type { IMessageOptions, QueueMessage } from '@spinajs/queue';
import { Clock, DbTimeSource, FakeClock, RunModel, ScheduleModel, Scheduler, ScheduledTask, defineSchedule, undefineSchedule } from '@spinajs/scheduler';
import type { RunContext, ScheduleRunInfo } from '@spinajs/scheduler';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { MemoryTenantRegistry, TenantAccess, TenantUnavailable, currentTenant, requireTenant, runAcrossTenants, runInTenant, tenantRegistry, tenantScope } from '../src/index.js';
import type { TenantRecord, TenantScope } from '../src/index.js';
import { TENANT_SCHEDULE_HOOK_ORDER, TenantScheduleRunHook } from '../src/scheduler.js';
import { tenancyApp } from './support/app.js';

export const SCHEDULER_TENANTS = [
  { id: 'acme', slug: 'acme', name: 'Acme', state: 'active', domains: [], settings: {} },
  { id: 'globex', slug: 'globex', name: 'Globex', state: 'suspended', domains: [], settings: {} },
];

const runOf = (tenant?: string): ScheduleRunInfo => ({ runId: 'r1', schedule: 'close-day', tenant: tenant === undefined ? undefined : { id: tenant } });
const hook = new TenantScheduleRunHook();
const scopeInside = (run: ScheduleRunInfo): Promise<TenantScope | undefined> => hook.aroundRun(run, async () => tenantScope());
const failureOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => 'ran',
    (err: unknown) => err,
  );

describe('@spinajs/tenancy/scheduler: the run hook', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await tenancyApp({ tenants: SCHEDULER_TENANTS });
  });

  afterEach(() => app.dispose());

  it('runs ahead of hooks of the default order', () => {
    expect(hook.order).to.eq(TENANT_SCHEDULE_HOOK_ORDER);
    expect(TENANT_SCHEDULE_HOOK_ORDER).to.be.lessThan(0);
  });

  it('runs the run of a tenant instance inside that tenant', async () => {
    expect(await scopeInside(runOf('acme'))).to.deep.eq({ kind: 'tenant', tenant: { id: 'acme' } });
  });

  it('runs a global run with no scope, also inside the scope of whatever started the loop', async () => {
    expect(await scopeInside(runOf())).to.eq(undefined);
    expect(await runInTenant('acme', () => scopeInside(runOf()))).to.eq(undefined);
  });

  it('refuses a tenant the registry does not know or that is not active', async () => {
    for (const [tenant, reason] of [
      ['initech', 'unknown'],
      ['globex', 'inactive'],
    ] as const) {
      const refused = await failureOf(scopeInside(runOf(tenant)));
      if (!(refused instanceof TenantUnavailable)) throw new Error(`expected TenantUnavailable for ${tenant}, got ${String(refused)}`);
      expect(refused.reason).to.eq(reason);
    }
  });
});

interface Seen {
  tenant: string | undefined;
  ctx: string | undefined;
  principal: string;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((_resolve) => (resolve = _resolve));
  return { promise, resolve };
}

const seen: Seen[] = [];
const observe = (ctx: RunContext): number => seen.push({ tenant: currentTenant()?.id, ctx: ctx.tenant?.id, principal: currentPrincipal().type });

class Observe extends ScheduledTask {
  public execute(ctx: RunContext) {
    observe(ctx);
    return Promise.resolve(null);
  }
}

// what a tenant model does before it touches its table
class NeedsTenant extends ScheduledTask {
  public execute() {
    return Promise.resolve(requireTenant().id);
  }
}

let gate = deferred();
let started = deferred();
class Held extends ScheduledTask {
  public async execute(ctx: RunContext) {
    started.resolve();
    await gate.promise;
    observe(ctx);
  }
}

const phases: Array<[string, string | undefined]> = [];
const record = (phase: string): number => phases.push([phase, currentTenant()?.id]);
let detached = deferred();
class Lifecycle extends ScheduledTask {
  public async execute(ctx: RunContext) {
    ctx.signal.addEventListener('abort', () => record('abort listener'), { once: true });
    setTimeout(() => {
      record('detached work');
      detached.resolve();
    }, 10);
    await ctx.step('step', () => record('step'));
    try {
      started.resolve();
      await new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    } catch {
      record('catch');
    } finally {
      record('finally');
    }
  }
}

const emittedIn: Array<string | undefined> = [];
@Job()
@SystemTask('a test job that only has to be emitted')
class TenantDigestJob extends QueueJob {
  public static override emit<T extends typeof QueueMessage>(this: T, _val: Partial<InstanceType<T>>, _options?: IMessageOptions): Promise<string | undefined> {
    emittedIn.push(currentTenant()?.id);
    return Promise.resolve(undefined);
  }

  public execute() {
    return Promise.resolve(null);
  }
}
class EmitsDigest extends ScheduledTask {}

let entered = 0;
class DenyingTenantAccess extends TenantAccess {
  public canEnter(): Promise<boolean> {
    entered++;
    return Promise.resolve(false);
  }
}

const user: Principal = { type: 'user', id: 'u1', authenticated: true, source: 'test', attributes: { tenants: ['acme'] } };
const T0 = '2026-01-05T10:00:00Z';
const sqlite = (name: string) => ({ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: name, Migration: { Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } } });
const SCHEDULES = ['observe', 'needs-tenant', 'held', 'lifecycle', 'digest'];

describe('@spinajs/tenancy/scheduler: runs of the scheduler loop', function () {
  // every test boots an app and migrates the scheduler's tables, about 1 s on a loaded machine
  this.timeout(20000);
  let app: TestApp;
  let clock: FakeClock;
  let s: Scheduler;
  let registry: MemoryTenantRegistry;

  const instance = (name: string, tenant: string, nextRunAt: number | null = null) => ScheduleModel.create({ Name: name, Tenant: tenant, Definition: {}, DefinitionHash: 'h', NextRunAt: nextRunAt, Paused: false, HardPaused: false, ConsecutiveFailures: 0, Orphaned: false, UpdatedAt: 0 });
  const queued = (schedule: string, tenant: string | null) => RunModel.create({ Id: randomUUID(), Schedule: schedule, Tenant: tenant, Trigger: 'manual', Status: 'queued', Attempt: 1, MaxAttempts: 1, CreatedAt: clock.now(), Progress: 0, CancelRequested: false, Forced: false });
  const runOfInstance = (schedule: string, tenant: string | null): Promise<RunModel> => (tenant === null ? RunModel.query().where('Schedule', schedule).whereNull('Tenant').first() : RunModel.where({ Schedule: schedule, Tenant: tenant }).first());
  const tick = async (): Promise<void> => {
    await s.tickOnce();
    await s.idle();
  };

  async function boot(tenancy: Record<string, unknown> = {}): Promise<void> {
    clock = new FakeClock(T0);
    app = await createTestApp({
      bootstrap: false,
      config: {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
        db: { DefaultConnection: 'sqlite', Connections: [sqlite('sqlite'), sqlite('queue')] },
        scheduler: { tick: 1000, leaseTtl: 60_000, shutdownGrace: 2000, progressFlush: 1000, schedules: [], retention: { enabled: false } },
        tenancy: { registry: 'MemoryTenantRegistry', ...tenancy },
      },
      register: (container) => {
        container.register(() => clock).as(Clock);
        container.register(() => clock.dbSource).as(DbTimeSource);
        container.register(DenyingTenantAccess).as(TenantAccess);
      },
    });
    await migrateTestDatabase();
    const inner = (await tenantRegistry()).inner;
    if (!(inner instanceof MemoryTenantRegistry)) throw new Error('expected the memory registry');
    registry = inner;
    for (const id of ['acme', 'globex', 'initech']) registry.add({ id });
    s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
  }

  beforeEach(() => {
    seen.length = 0;
    phases.length = 0;
    emittedIn.length = 0;
    entered = 0;
    gate = deferred();
    started = deferred();
    detached = deferred();
    defineSchedule(Observe, 'observe', { manual: true });
    defineSchedule(NeedsTenant, 'needs-tenant', { manual: true });
    defineSchedule(Held, 'held', { manual: true });
    defineSchedule(Lifecycle, 'lifecycle', { manual: true });
    defineSchedule(EmitsDigest, 'digest', { manual: true, emit: TenantDigestJob });
  });

  afterEach(async () => {
    gate.resolve();
    await app.dispose();
    SCHEDULES.forEach(undefineSchedule);
  });

  it('runs each run in the tenant of the instance row it claimed, not in the scope or as the principal of the code that drives the loop', async () => {
    await boot();
    await instance('observe', 'acme');
    await instance('observe', 'globex');
    for (const tenant of [null, 'acme', 'globex']) await queued('observe', tenant);

    await runWithPrincipal(user, () => runInTenant('initech', () => s.tickOnce()));
    await s.idle();

    expect(seen).to.have.deep.members([
      { tenant: undefined, ctx: undefined, principal: 'unattended' },
      { tenant: 'acme', ctx: 'acme', principal: 'unattended' },
      { tenant: 'globex', ctx: 'globex', principal: 'unattended' },
    ]);
  });

  it('fails a global run that touches tenant data with TenantRequired, even when the loop runs across all tenants', async () => {
    await boot();
    await queued('needs-tenant', null);

    await runAcrossTenants('nightly maintenance', () => tick());

    const run = await runOfInstance('needs-tenant', null);
    expect(run.Status).to.eq('failed');
    expect(run.Error?.message).to.match(/needs a tenant scope and runs with none/);
  });

  it('starts every run in the scope of its own instance: acme, then the global instance, then globex', async () => {
    await boot();
    await instance('observe', 'acme');
    await instance('observe', 'globex');

    for (const tenant of ['acme', null, 'globex']) {
      await queued('observe', tenant);
      await tick();
    }

    expect(seen).to.deep.eq([
      { tenant: 'acme', ctx: 'acme', principal: 'unattended' },
      { tenant: undefined, ctx: undefined, principal: 'unattended' },
      { tenant: 'globex', ctx: 'globex', principal: 'unattended' },
    ]);
  });

  it("keeps the tenant over the body's steps, detached work, abort listener, catch and finally, whoever aborts it", async () => {
    await boot();
    await instance('lifecycle', 'acme');
    const run = await queued('lifecycle', 'acme');
    await s.tickOnce();
    await started.promise;

    await runInTenant('globex', () => Promise.resolve(s.abortLocal(run.Id, 'cancelled')));
    await s.idle();
    await detached.promise;

    expect(phases).to.have.deep.members([
      ['step', 'acme'],
      ['detached work', 'acme'],
      ['abort listener', 'acme'],
      ['catch', 'acme'],
      ['finally', 'acme'],
    ]);
  });

  it('emits the job of an emit-mode run inside the tenant of its instance', async () => {
    await boot();
    await instance('digest', 'acme');
    await queued('digest', null);
    await queued('digest', 'acme');

    await runInTenant('globex', () => tick());

    expect(emittedIn).to.have.members([undefined, 'acme']);
  });

  it('fails the attempt of a run whose tenant is unknown or not active when it fires, without running the body', async () => {
    await boot();
    for (const state of ['provisioning', 'suspended', 'deleting', 'deleted'] as const) registry.add({ id: state, state });
    const tenants = ['provisioning', 'suspended', 'deleting', 'deleted', 'unknown'];
    for (const tenant of tenants) {
      await instance('observe', tenant);
      await queued('observe', tenant);
    }

    await tick();

    expect(seen).to.deep.eq([]);
    for (const tenant of tenants) {
      const run = await runOfInstance('observe', tenant);
      expect(run.Status, tenant).to.eq('failed');
      expect(run.Error?.message, tenant).to.eq(tenant === 'unknown' ? 'no such tenant' : `tenant "${tenant}" is ${tenant}`);
      expect((await ScheduleModel.where({ Name: 'observe', Tenant: tenant }).first()).ConsecutiveFailures, tenant).to.eq(1);
    }
  });

  it('lets a run end in its tenant when the tenant is suspended during the run, and refuses the next one', async () => {
    await boot();
    await instance('held', 'acme');
    await queued('held', 'acme');
    await s.tickOnce();
    await started.promise;

    const suspended: TenantRecord = registry.set('acme', { state: 'suspended' });
    gate.resolve();
    await s.idle();
    expect(suspended.state).to.eq('suspended');
    expect(seen).to.deep.eq([{ tenant: 'acme', ctx: 'acme', principal: 'unattended' }]);
    expect((await runOfInstance('held', 'acme')).Status).to.eq('succeeded');

    await RunModel.destroy().where('Schedule', 'held');
    await queued('held', 'acme');
    await tick();
    const next = await runOfInstance('held', 'acme');
    expect(next.Status).to.eq('failed');
    expect(next.Error?.message).to.eq('tenant "acme" is suspended');
  });

  it('enters a tenant as no principal: TenantAccess is never asked, also when the loop runs as a signed-in user', async () => {
    await boot({ access: 'DenyingTenantAccess' });
    await instance('observe', 'acme');
    await queued('observe', 'acme');

    await runWithPrincipal(user, () => tick());

    expect(entered).to.eq(0);
    expect(seen).to.deep.eq([{ tenant: 'acme', ctx: 'acme', principal: 'unattended' }]);
  });

  it('runs a global schedule as without the hook when no tenant row exists', async () => {
    await boot();
    await queued('observe', null);

    await tick();

    expect(seen).to.deep.eq([{ tenant: undefined, ctx: undefined, principal: 'unattended' }]);
    expect((await runOfInstance('observe', null)).Status).to.eq('succeeded');
    expect(await ScheduleModel.where('Tenant', '!=', '')).to.deep.eq([]);
  });
});
