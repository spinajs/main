import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry-common';
import {
  defineSchedule,
  FakeClock,
  RunContext,
  Scheduler,
  ScheduledTask,
  SchedulerService,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { queuedRun } from './support/fixtures.js';

let fail = false;
class MetricsWorkTask extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('a', () => 1);
    if (fail) throw new Error('x');
  }
}

type Sample = { labels: Record<string, string | number>; value: number; metricName?: string };

async function values(name: string): Promise<Sample[]> {
  const metric = DI.resolve(Metrics).getRegistry().getSingleMetric(name);
  return metric ? ((await metric.get()).values as Sample[]) : [];
}

const valueOf = async (metric: string, labels: Record<string, string>) =>
  (await values(metric)).find((v) => Object.entries(labels).every(([k, x]) => v.labels[k] === x))?.value;

const by = { triggeredBy: { kind: 'system' as const, id: 'test' } };

describe('scheduler metrics', () => {
  let clock: FakeClock;
  let s: Scheduler;

  beforeEach(async () => {
    fail = false;
    defineSchedule(MetricsWorkTask, 'm-work', { every: '1m', retry: { attempts: 2, delay: '1s' } });
    defineSchedule(MetricsWorkTask, 'm-fragile', { manual: true, pauseAfterFailures: 1 });
    defineSchedule(MetricsWorkTask, 'm-skip', { every: '1m', misfire: 'skip' });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z' }));
    s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
  });
  afterEach(() => ['m-work', 'm-fragile', 'm-skip'].forEach(undefineSchedule));

  it('counts runs, measures durations and lag', async () => {
    clock.set('2026-01-05T10:01:03Z');
    await s.tickOnce();
    await s.idle();
    expect(await values('scheduler_runs_total')).to.deep.include({
      labels: { name: 'm-work', status: 'succeeded', trigger: 'schedule' },
      value: 1,
    });
    expect(await valueOf('scheduler_lag_seconds', { name: 'm-work' })).to.eq(3);
    const count = (await values('scheduler_run_duration_seconds')).find(
      (v) => v.metricName === 'scheduler_run_duration_seconds_count' && v.labels.name === 'm-work',
    );
    expect(count?.value).to.eq(1);
    expect((await values('scheduler_step_duration_seconds')).some((v) => v.labels.step === 'a')).to.eq(true);
    expect(await valueOf('scheduler_consecutive_failures', { name: 'm-work' })).to.eq(0);
  });

  it('counts retries and failures, and measures lag only for the first attempt', async () => {
    fail = true;
    await queuedRun('m-work', clock.now(), { MaxAttempts: 2, ScheduledAt: clock.now() - 2000 });
    await s.tickOnce();
    await s.idle();
    expect(await valueOf('scheduler_lag_seconds', { name: 'm-work' })).to.eq(2);
    clock.set(clock.now() + 1000);
    await s.tickOnce();
    await s.idle();
    expect(await valueOf('scheduler_lag_seconds', { name: 'm-work' })).to.eq(2);
    expect(await valueOf('scheduler_retries_total', { name: 'm-work' })).to.eq(1);
    expect(await values('scheduler_runs_total')).to.deep.include({
      labels: { name: 'm-work', status: 'dead', trigger: 'manual' },
      value: 1,
    });
    expect(await values('scheduler_runs_total')).to.not.deep.include({
      labels: { name: 'm-work', status: 'retrying', trigger: 'manual' },
      value: 1,
    });
    expect(await valueOf('scheduler_consecutive_failures', { name: 'm-work' })).to.eq(1);
  });

  it('counts runs recorded without running', async () => {
    clock.set('2026-01-05T10:10:30Z');
    await s.tickOnce();
    await s.idle();
    expect(await valueOf('scheduler_runs_total', { name: 'm-skip', status: 'misfired', trigger: 'schedule' })).to.eq(1);
  });

  it('follows resume in the consecutive-failures gauge', async () => {
    fail = true;
    await queuedRun('m-fragile', clock.now());
    await s.tickOnce();
    await s.idle();
    expect(await valueOf('scheduler_consecutive_failures', { name: 'm-fragile' })).to.eq(1);
    const service = await DI.resolve(SchedulerService);
    expect((await service.getSchedule('m-fragile')).health).to.eq('paused-by-failures');
    await service.resume('m-fragile', by);
    expect(await valueOf('scheduler_consecutive_failures', { name: 'm-fragile' })).to.eq(0);
  });

  it('starts from a fresh registry after the container is disposed', async () => {
    await queuedRun('m-fragile', clock.now());
    await s.tickOnce();
    await s.idle();
    expect(await valueOf('scheduler_runs_total', { name: 'm-fragile', status: 'succeeded' })).to.eq(1);
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z' }));
    s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    await queuedRun('m-fragile', clock.now());
    await s.tickOnce();
    await s.idle();
    expect(await valueOf('scheduler_runs_total', { name: 'm-fragile', status: 'succeeded' })).to.eq(1);
  });
});
