import { AsyncLocalStorage } from 'node:async_hooks';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Job, QueueJob, SystemTask } from '@spinajs/queue';
import sinon from 'sinon';
import {
  defineSchedule,
  RunContext,
  RunModel,
  runScheduleHooks,
  ScheduleModel,
  ScheduleRunHook,
  Scheduler,
  ScheduledTask,
  SchedulerService,
  undefineSchedule,
} from '../src/index.js';
import type { FakeClock, ScheduleRunInfo } from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { deferred, queuedRun, untilAborted } from './support/fixtures.js';

const store = new AsyncLocalStorage<string>();
const calls: string[] = [];
const seen: Array<{ store: string | undefined; tenant: string | undefined }> = [];
let enabled = false;

// DI keeps a registration for the rest of the process: switched off, both probes only call next().
class OuterProbe extends ScheduleRunHook {
  public override readonly order: number = -10;

  public aroundRun<T>(run: ScheduleRunInfo, next: () => Promise<T>): Promise<T> {
    if (!enabled) return next();
    calls.push(`outer ${run.schedule} ${run.tenant?.id ?? '-'}`);
    return store.run(run.tenant?.id ?? 'global', next);
  }
}

class InnerProbe extends ScheduleRunHook {
  public aroundRun<T>(_run: ScheduleRunInfo, next: () => Promise<T>): Promise<T> {
    if (enabled) calls.push(`inner ${store.getStore() ?? 'none'}`);
    return next();
  }
}

const registerProbes = (): void => {
  DI.register(InnerProbe).as(ScheduleRunHook);
  DI.register(OuterProbe).as(ScheduleRunHook);
};
registerProbes();

class Observe extends ScheduledTask {
  public execute(ctx: RunContext) {
    seen.push({ store: store.getStore(), tenant: ctx.tenant?.id });
    return Promise.resolve(null);
  }
}

let failFirst = true;
class FailsFirst extends ScheduledTask {
  public execute(ctx: RunContext) {
    seen.push({ store: store.getStore(), tenant: ctx.tenant?.id });
    if (failFirst) {
      failFirst = false;
      return Promise.reject(new Error('first attempt fails'));
    }
    return Promise.resolve(null);
  }
}

const tampered: boolean[] = [];
class Tamper extends ScheduledTask {
  public execute(ctx: RunContext) {
    seen.push({ store: store.getStore(), tenant: ctx.tenant?.id });
    tampered.push(Reflect.set(ctx.tenant ?? {}, 'id', 'globex'));
    Reflect.set(ctx, 'tenant', Object.freeze({ id: 'globex' }));
    return Promise.resolve(null);
  }
}

const heard: Array<string | undefined> = [];
let listening = deferred();
class Listens extends ScheduledTask {
  public execute(ctx: RunContext) {
    ctx.signal.addEventListener('abort', () => heard.push(store.getStore()), { once: true });
    listening.resolve();
    return untilAborted(ctx.signal);
  }
}

@Job()
@SystemTask('a test job that only has to be emitted')
export class RunHookJob extends QueueJob {
  public execute() {
    return Promise.resolve(null);
  }
}
class EmitProbe extends ScheduledTask {}

const T1 = '2026-01-05T10:01:00Z';
const scheduler = (): Promise<Scheduler> => DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
async function tick(s: Scheduler): Promise<void> {
  await s.tickOnce();
  await s.idle();
}
const instance = (name: string, tenant: string, nextRunAt: number | null) =>
  ScheduleModel.create({
    Name: name,
    Tenant: tenant,
    Definition: {},
    DefinitionHash: 'h',
    NextRunAt: nextRunAt,
    Paused: false,
    HardPaused: false,
    ConsecutiveFailures: 0,
    Orphaned: false,
    UpdatedAt: 0,
  });

describe('ScheduleRunHook', () => {
  let clock: FakeClock;

  afterEach(() => {
    enabled = false;
    calls.length = 0;
    seen.length = 0;
    sinon.restore();
  });

  describe('around a task', () => {
    beforeEach(async () => {
      defineSchedule(Observe, 'observe', { every: '1m' });
      ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z' }));
    });

    afterEach(() => undefineSchedule('observe'));

    it('runs the body as before when no hook acts', async () => {
      const s = await scheduler();
      clock.set(T1);
      await tick(s);

      expect(seen).to.deep.eq([{ store: undefined, tenant: undefined }]);
      expect(calls).to.deep.eq([]);
      expect((await RunModel.where('Schedule', 'observe').first()).Status).to.eq('succeeded');
      expect(await runScheduleHooks({ runId: 'r', schedule: 's', tenant: undefined }, () => Promise.resolve(42))).to.eq(
        42,
      );
    });

    it('wraps the body of a global run, the lowest order outermost', async () => {
      enabled = true;
      const s = await scheduler();
      clock.set(T1);
      await tick(s);

      expect(calls).to.deep.eq(['outer observe -', 'inner global']);
      expect(seen).to.deep.eq([{ store: 'global', tenant: undefined }]);
    });

    it('hands the hooks and the run context the tenant of the instance', async () => {
      enabled = true;
      const s = await scheduler();
      await ScheduleModel.update({ Paused: true }).where({ Name: 'observe', Tenant: '' });
      await instance('observe', 'acme', Date.parse(T1));
      clock.set(T1);
      await tick(s);

      expect(calls).to.deep.eq(['outer observe acme', 'inner acme']);
      expect(seen).to.deep.eq([{ store: 'acme', tenant: 'acme' }]);
      expect((await RunModel.where({ Schedule: 'observe', Tenant: 'acme' }).first()).Status).to.eq('succeeded');
    });

    it('fails the attempt when a hook refuses the run', async () => {
      enabled = true;
      sinon.stub(OuterProbe.prototype, 'aroundRun').rejects(new Error('tenant unavailable'));
      const s = await scheduler();
      clock.set(T1);
      await tick(s);

      const run = await RunModel.where('Schedule', 'observe').first();
      expect(run.Status).to.eq('failed');
      expect(run.Error?.message).to.eq('tenant unavailable');
      expect(seen).to.deep.eq([]);
    });

    it('leaves an inline run in the scope of its caller', async () => {
      enabled = true;
      await scheduler();
      const service = await DI.resolve(SchedulerService);

      const inside = await store.run('caller', () =>
        service.runInline('observe', () => Promise.resolve(store.getStore())),
      );

      expect(inside).to.eq('caller');
      expect(calls).to.deep.eq([]);
    });

    describe('with no hook registered', () => {
      beforeEach(() => {
        DI.unregister(ScheduleRunHook, InnerProbe);
        DI.unregister(ScheduleRunHook, OuterProbe);
      });

      afterEach(registerProbes);

      it('refuses the run of a tenant instance instead of running it unscoped, and runs the global one', async () => {
        const s = await scheduler();
        await instance('observe', 'acme', Date.parse(T1));
        clock.set(T1);
        await tick(s);

        expect(seen).to.deep.eq([{ store: undefined, tenant: undefined }]);
        const acme = await RunModel.where({ Schedule: 'observe', Tenant: 'acme' }).first();
        expect(acme.Status).to.eq('failed');
        expect(acme.Error?.message).to.match(/belongs to tenant 'acme' and no ScheduleRunHook is registered/);
        expect((await RunModel.query().where('Schedule', 'observe').whereNull('Tenant').first()).Status).to.eq(
          'succeeded',
        );
      });
    });
  });

  describe('across runs and attempts', () => {
    afterEach(() => ['observe-retry', 'tamper', 'listens'].forEach(undefineSchedule));

    it('asks the hooks again on every attempt of a retried run', async () => {
      failFirst = true;
      defineSchedule(FailsFirst, 'observe-retry', { manual: true, retry: { attempts: 2, delay: '1m' } });
      ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' }));
      enabled = true;
      const s = await scheduler();
      await instance('observe-retry', 'acme', null);
      await queuedRun('observe-retry', clock.now(), { Tenant: 'acme', MaxAttempts: 2 });

      await tick(s);
      clock.set('2026-01-05T10:01:00Z');
      await tick(s);

      expect(calls).to.deep.eq(['outer observe-retry acme', 'inner acme', 'outer observe-retry acme', 'inner acme']);
      expect(seen).to.deep.eq([
        { store: 'acme', tenant: 'acme' },
        { store: 'acme', tenant: 'acme' },
      ]);
      expect((await RunModel.where('Schedule', 'observe-retry').first()).Status).to.eq('succeeded');
    });

    it('gives every run its own frozen tenant, whatever the task did to the previous one', async () => {
      tampered.length = 0;
      defineSchedule(Tamper, 'tamper', { manual: true });
      ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' }));
      enabled = true;
      const s = await scheduler();
      await instance('tamper', 'acme', null);
      await queuedRun('tamper', clock.now(), { Tenant: 'acme' });
      await tick(s);
      await queuedRun('tamper', clock.now() + 1, { Tenant: 'acme' });
      await tick(s);

      expect(tampered).to.deep.eq([false, false]);
      expect(seen).to.deep.eq([
        { store: 'acme', tenant: 'acme' },
        { store: 'acme', tenant: 'acme' },
      ]);
      expect(calls).to.deep.eq(['outer tamper acme', 'inner acme', 'outer tamper acme', 'inner acme']);
    });

    it("runs a task's abort listener inside the hooks, not in the context of whoever aborted it", async () => {
      heard.length = 0;
      listening = deferred();
      defineSchedule(Listens, 'listens', { manual: true });
      ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' }));
      enabled = true;
      const s = await scheduler();
      await instance('listens', 'acme', null);
      const run = await queuedRun('listens', clock.now(), { Tenant: 'acme' });
      await s.tickOnce();
      await listening.promise;

      store.run('caller', () => s.abortLocal(run.Id, 'cancelled'));
      await s.idle();

      expect(heard).to.deep.eq(['acme']);
      expect(await RunModel.where('Id', run.Id).first()).to.include({ Status: 'aborted', Reason: 'cancelled' });
    });
  });

  describe('around an emit', () => {
    beforeEach(async () => {
      defineSchedule(EmitProbe, 'observe-emit', { every: '1m', emit: RunHookJob });
      ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z' }));
    });

    afterEach(() => undefineSchedule('observe-emit'));

    it('emits the job of an emit-mode run inside the hooks', async () => {
      enabled = true;
      const emittedIn: Array<string | undefined> = [];
      sinon.stub(RunHookJob, 'emit').callsFake(() => {
        emittedIn.push(store.getStore());
        return Promise.resolve(undefined);
      });
      const s = await scheduler();
      clock.set(T1);
      await tick(s);

      expect(emittedIn).to.deep.eq(['global']);
      expect(calls).to.deep.eq(['outer observe-emit -', 'inner global']);
    });
  });
});
