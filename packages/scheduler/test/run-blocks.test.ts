import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import {
  FakeClock,
  Heartbeat,
  HeartbeatOptions,
  resolveSchedulerConfig,
  RunContext,
  RunEventWriter,
  RunFinalizer,
  RunModel,
  ScheduleModel,
  toStructuredError,
  DbClock,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';

chai.use(chaiAsPromised);

const T = Date.parse('2026-01-05T10:00:00Z');

describe('toStructuredError', () => {
  it('keeps name, message, code, step, stack and small JSON data', () => {
    const err = Object.assign(new TypeError('bad input 42'), { code: 'E_BAD', data: { row: 7 } });
    const s = toStructuredError(err, { attempt: 2, occurredAt: T, step: 'load' });
    expect(s).to.include({
      name: 'TypeError',
      message: 'bad input 42',
      code: 'E_BAD',
      step: 'load',
      attempt: 2,
      occurredAt: '2026-01-05T10:00:00.000Z',
    });
    expect(s.data).to.deep.eq({ row: 7 });
    expect(s.stack).to.contain('TypeError');
  });

  it('wraps non-errors and drops data that is not JSON-safe', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(toStructuredError('plain', { attempt: 1, occurredAt: T }).message).to.eq('plain');
    expect(
      toStructuredError(Object.assign(new Error('x'), { data: circular }), { attempt: 1, occurredAt: T }).data,
    ).to.eq(undefined);
  });
});

describe('Heartbeat', () => {
  function make(
    clock: FakeClock,
    renew: () => Promise<{ ok: boolean; cancelRequested: boolean }>,
    dirty = () => false,
    extra: Partial<HeartbeatOptions> = {},
  ) {
    const calls = { lost: 0, cancel: 0, errors: 0 };
    const hb = new Heartbeat({
      timers: clock,
      now: () => clock.now(),
      intervalMs: 1000,
      renewEveryMs: 20_000,
      leaseTtlMs: 60_000,
      needsFlush: dirty,
      renew,
      onLost: () => calls.lost++,
      onCancel: () => calls.cancel++,
      onError: () => calls.errors++,
      ...extra,
    });
    return { hb, calls };
  }

  it('renews when due and flushes early when dirty', async () => {
    const clock = new FakeClock(T);
    let renewals = 0;
    let isDirty = false;
    const { hb } = make(
      clock,
      async () => (renewals++, { ok: true, cancelRequested: false }),
      () => isDirty,
    );
    hb.start();
    await clock.advance(19_000);
    expect(renewals).to.eq(0);
    await clock.advance(1000);
    await hb.flush();
    expect(renewals).to.eq(2);
    isDirty = true;
    await clock.advance(1000);
    await hb.stop();
    expect(renewals).to.eq(3);
  });

  it('keeps beating after a renewal that threw', async () => {
    const clock = new FakeClock(T);
    let calls = 0;
    const { hb, calls: seen } = make(clock, async () => {
      if (++calls === 1) throw new Error('db down');
      return { ok: true, cancelRequested: false };
    });
    await expect(hb.flush()).to.be.rejectedWith('db down');
    await hb.flush();
    await hb.stop();
    expect(calls).to.eq(2);
    expect(seen.lost).to.eq(0);
  });

  it('reports the lease lost once renewals have failed for a whole TTL, and stops renewing', async () => {
    const clock = new FakeClock(T);
    let renewals = 0;
    const { hb, calls } = make(clock, async () => {
      renewals++;
      throw new Error('db unreachable');
    });
    hb.start();
    await clock.advance(59_000);
    expect(calls.lost).to.eq(0);
    expect(calls.errors).to.eq(renewals).and.to.be.greaterThan(1);
    await clock.advance(1000);
    expect(calls.lost).to.eq(1);
    const after = renewals;
    await clock.advance(10_000);
    await hb.stop();
    expect(calls.lost).to.eq(1);
    expect(renewals).to.eq(after);
  });

  it('reports the lease lost while a renewal hangs past the TTL', async () => {
    const clock = new FakeClock(T);
    const { hb, calls } = make(clock, () => new Promise(() => undefined));
    hb.start();
    await clock.advance(60_000);
    expect(calls.lost).to.eq(1);
    await hb.stop();
  });

  it('stops waiting for a hanging renewal once the lease would have expired', async () => {
    const clock = new FakeClock(T);
    const { hb, calls } = make(clock, () => new Promise(() => undefined));
    hb.start();
    await clock.advance(20_000);
    let stopped = false;
    void hb.stop().then(() => (stopped = true));
    await clock.advance(39_000);
    expect(stopped).to.eq(false);
    await clock.advance(1000);
    expect(stopped).to.eq(true);
    expect(calls.lost).to.eq(0);
  });

  it('counts the lease from leaseStartedAt, not from construction', async () => {
    const clock = new FakeClock(T);
    let renewals = 0;
    const { hb, calls } = make(
      clock,
      async () => {
        renewals++;
        throw new Error('db unreachable');
      },
      () => false,
      { leaseStartedAt: T - 50_000 },
    );
    hb.start();
    await clock.advance(1000);
    expect(renewals).to.eq(1);
    await clock.advance(8000);
    expect(calls.lost).to.eq(0);
    await clock.advance(1000);
    expect(calls.lost).to.eq(1);
    await hb.stop();
  });

  it('calls onLost once and stops renewing after a renewal reports the lease gone', async () => {
    const clock = new FakeClock(T);
    let renewals = 0;
    const { hb, calls } = make(
      clock,
      async () => (renewals++, { ok: false, cancelRequested: false }),
      () => true,
    );
    hb.start();
    await clock.advance(5000);
    await hb.flush();
    await hb.stop();
    expect(renewals).to.eq(1);
    expect(calls.lost).to.eq(1);
  });

  it('does not pile up beats while a renewal is pending', async () => {
    const clock = new FakeClock(T);
    let renewals = 0;
    let release!: () => void;
    const { hb } = make(
      clock,
      () => {
        renewals++;
        return new Promise((resolve) => (release = () => resolve({ ok: true, cancelRequested: false })));
      },
      () => true,
    );
    hb.start();
    await clock.advance(5000);
    expect(renewals).to.eq(1);
    release();
    await clock.advance(1000);
    expect(renewals).to.eq(2);
    release();
    await hb.stop();
  });

  it('reports a lost lease and a cancel request', async () => {
    const clock = new FakeClock(T);
    const lost = make(clock, async () => ({ ok: false, cancelRequested: false }));
    await lost.hb.flush();
    expect(lost.calls.lost).to.eq(1);
    const cancel = make(clock, async () => ({ ok: true, cancelRequested: true }));
    await cancel.hb.flush();
    expect(cancel.calls.cancel).to.eq(1);
  });
});

describe('RunContext (identity) and RunFinalizer', () => {
  beforeEach(async () => {
    await bootTestEnv();
    await ScheduleModel.create({
      Name: 'a',
      Definition: {},
      DefinitionHash: 'h',
      NextRunAt: null,
      Paused: false,
      HardPaused: false,
      ConsecutiveFailures: 0,
      Orphaned: false,
      UpdatedAt: T,
    });
  });

  it('exposes run identity and the explicit result', async () => {
    const run = await RunModel.create({
      Id: 'r1',
      Schedule: 'a',
      Trigger: 'manual',
      TriggeredBy: { kind: 'user', id: '7' },
      Params: { file: 'x' },
      Status: 'running',
      Attempt: 2,
      MaxAttempts: 3,
      ScheduledAt: T,
      CreatedAt: T,
      StartedAt: T + 1000,
      Progress: 0,
      CancelRequested: false,
      Forced: false,
    });
    const ac = new AbortController();
    const ctx = new RunContext({
      run,
      def: {} as never,
      signal: ac.signal,
      events: DI.resolve(RunEventWriter),
      clock: DI.resolve(DbClock),
      log: DI.resolve(Log, ['SCHEDULER']),
      config: resolveSchedulerConfig({}),
    });
    expect(ctx).to.include({ runId: 'r1', schedule: 'a', trigger: 'manual', attempt: 2 });
    expect(ctx.params).to.deep.eq({ file: 'x' });
    expect(ctx.triggeredBy).to.deep.eq({ kind: 'user', id: '7' });
    expect(ctx.scheduledAt?.toISOString()).to.eq('2026-01-05T10:00:00.000Z');
    expect(ctx.firedAt.toISOString()).to.eq('2026-01-05T10:00:01.000Z');
    expect(ctx.signal).to.eq(ac.signal);
    ctx.result({ imported: 3 });
    expect(ctx.explicitResult).to.deep.eq({ set: true, value: { imported: 3 } });
  });

  it('records the last status on the schedule, except for skipped runs', async () => {
    const finalizer = DI.resolve(RunFinalizer);
    const run = { Id: 'r1', Schedule: 'a', Attempt: 1, StartedAt: T, Trigger: 'schedule' } as RunModel;
    await finalizer.finalized({ run, status: 'succeeded', error: null, now: T + 5000, countsAsFailure: false });
    await finalizer.finalized({
      run: { ...run, Id: 'r2' } as RunModel,
      status: 'skipped',
      error: null,
      now: T + 6000,
      countsAsFailure: false,
    });
    expect(await ScheduleModel.where('Name', 'a').first()).to.include({
      LastStatus: 'succeeded',
      LastRunId: 'r1',
      LastFinishedAt: T + 5000,
    });
  });

  it('does not record a retrying run as the last status', async () => {
    const finalizer = DI.resolve(RunFinalizer);
    const run = { Id: 'r1', Schedule: 'a', Attempt: 1, StartedAt: T, Trigger: 'schedule' } as RunModel;
    await finalizer.finalized({
      run,
      status: 'retrying',
      error: null,
      now: T + 5000,
      countsAsFailure: true,
      nextAttemptAt: T + 65_000,
    });
    expect((await ScheduleModel.where('Name', 'a').first()).LastStatus).to.eq(null);
  });
});
