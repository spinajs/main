import { AsyncLocalStorage } from 'node:async_hooks';
import { trace } from '@opentelemetry/api';
import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import { SpinaAttr, tracingState, withSpan } from '@spinajs/tracing';
import { resetTracing, useInMemorySpans } from '@spinajs/tracing/testing';
import type { InMemorySpans } from '@spinajs/tracing/testing';
import {
  defineSchedule,
  RunModel,
  ScheduleModel,
  ScheduleRunHook,
  ScheduleRunStarted,
  ScheduleRunSucceeded,
  Scheduler,
  ScheduledTask,
  undefineSchedule,
} from '../src/index.js';
import type { FakeClock, ScheduleRunInfo } from '../src/index.js';
import { bootTestEnv, waitFor } from './support/env.js';
import { queuedRun } from './support/fixtures.js';

// The shared request store of a request in tenant acme by user u1, with the keys @spinajs/tenancy and authz write.
const WAKER = { Tenant: { kind: 'tenant', tenant: { id: 'acme' } }, Principal: { type: 'user', id: 'u1' } };
const requestStore = () => DI.resolve(AsyncLocalStorage);
const fromWaker = (): boolean => requestStore().getStore() === WAKER;
const seen: Record<'hook' | 'body' | 'events' | 'timers', boolean[]> = { hook: [], body: [], events: [], timers: [] };
const see = (list: boolean[]): number => list.push(fromWaker());

// Another package's hook; the tenancy hook is not registered.
class OtherPackageHook extends ScheduleRunHook {
  public override readonly order: number = -200;

  public aroundRun<T>(_run: ScheduleRunInfo, next: () => Promise<T>): Promise<T> {
    see(seen.hook);
    return next();
  }
}
DI.register(OtherPackageHook).as(ScheduleRunHook);

class Observe extends ScheduledTask {
  public execute() {
    see(seen.body);
    return Promise.resolve(null);
  }
}

// What @spinajs/tenancy-tracing's processor does: the ambient scope's tenant onto every span that starts.
const ambientTenantProcessor = {
  onStart: (span: { setAttribute(key: string, value: string): unknown }) =>
    fromWaker() ? span.setAttribute(SpinaAttr.Tenant, 'acme') : undefined,
  onEnd: () => undefined,
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

describe('the scheduler loop and the context that woke it', () => {
  let clock: FakeClock;
  let spans: InMemorySpans;
  let detachProcessor: () => Promise<void>;

  beforeEach(async () => {
    Object.values(seen).forEach((list) => (list.length = 0));
    spans = useInMemorySpans();
    detachProcessor = tracingState().hub?.add(ambientTenantProcessor, { enricher: true }) ?? (() => Promise.resolve());
    defineSchedule(Observe, 'ctx-observe', { manual: true });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' }));
    await ScheduleModel.create({
      Name: 'ctx-observe',
      Tenant: 'globex',
      Definition: {},
      DefinitionHash: 'h',
      NextRunAt: null,
      Paused: false,
      HardPaused: false,
      ConsecutiveFailures: 0,
      Orphaned: false,
      UpdatedAt: 0,
    });
    for (const emitted of [ScheduleRunStarted, ScheduleRunSucceeded])
      sinon.stub(emitted, 'emit').callsFake(() => {
        see(seen.events);
        return Promise.resolve();
      });
  });

  afterEach(async () => {
    sinon.restore();
    undefineSchedule('ctx-observe');
    await detachProcessor();
    await spans.detach();
  });

  after(() => resetTracing());

  it('runs the claim, the hooks, the body, the events and the run span of a tick inside a request with nothing of that request', async () => {
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    await queuedRun('ctx-observe', clock.now(), { Tenant: 'globex' });
    await queuedRun('ctx-observe', clock.now() + 1);

    let request: string | undefined;
    await requestStore().run(WAKER, () =>
      withSpan('request', {}, () => {
        request = trace.getActiveSpan()?.spanContext().spanId;
        return s.tickOnce();
      }),
    );
    await s.idle();

    expect(seen).to.deep.eq({
      hook: [false, false],
      body: [false, false],
      events: [false, false, false, false],
      timers: [],
    });
    // the claim's statements and anything else of the tick start no span under the waking request's
    expect(
      spans
        .spans()
        .filter((x) => x.parentSpanContext?.spanId === request)
        .map((x) => x.name),
    ).to.deep.eq([]);
    expect(spans.byName('run ctx-observe').map((x) => x.attributes[SpinaAttr.Tenant])).to.have.members([
      'globex',
      undefined,
    ]);
  });

  it('leaves the waker behind on the ticks its wake-up started, also on a later one a timer started', async () => {
    // real timers: a fake clock's timer runs in the context of the code that advances it, not of the code that set it
    const timers = new Map<unknown, NodeJS.Timeout>();
    sinon.stub(clock, 'setTimeout').callsFake((fn: () => void, ms: number) => {
      see(seen.timers);
      const handle = setTimeout(fn, ms);
      timers.set(handle, handle);
      return handle;
    });
    sinon.stub(clock, 'clearTimeout').callsFake((handle: unknown) => clearTimeout(timers.get(handle)));
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    const ended = async (id: string) =>
      ['succeeded', 'failed'].includes((await RunModel.where('Id', id).first()).Status);
    const first = await queuedRun('ctx-observe', clock.now(), { Tenant: 'globex' });
    // the first wake-up of a loop resolved lazily inside a request: start() arms the loop's timer there
    requestStore().run(WAKER, () => s.start());
    await waitFor(() => ended(first.Id), 10_000);

    const later = await queuedRun('ctx-observe', clock.now() + 1, { Tenant: 'globex' });
    await waitFor(() => ended(later.Id), 10_000);
    await s.stop();

    expect(seen.body).to.deep.eq([false, false]);
    // every timer the loop sets, its own and the runs', is set outside the waker's store
    expect([...seen.hook, ...seen.events, ...seen.timers]).to.not.include(true);
  });
});
