import { expect } from 'chai';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { Job, QueueJob, SystemTask } from '@spinajs/queue';
import { withSpan } from '@spinajs/tracing';
import { resetTracing, useInMemorySpans } from '@spinajs/tracing/testing';
import type { InMemorySpans } from '@spinajs/tracing/testing';

import { defineSchedule, FakeClock, RunAttemptModel, RunContext, RunModel, Scheduler, Scheduler_2026_11_16_00_00_00, SchedulerService, ScheduledTask, undefineSchedule } from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { getRun, queuedRun } from './support/fixtures.js';
import { InMemoryQueueClient, queueConfig } from './support/queue.js';

class BodyFailed extends Error {}

let bCalls = 0;
class Nightly extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('a', () => 1);
    await ctx.step('b', () => {
      if (++bCalls === 1) throw new Error('b failed');
    });
  }
}

describe('scheduler spans', () => {
  let clock: FakeClock;
  let s: Scheduler;
  let spans: InMemorySpans;
  const tick = async () => {
    await s.tickOnce();
    await s.idle();
  };
  const stepsUnder = (runSpanId: string) => spans.spans().filter((x) => x.name.startsWith('step ') && x.parentSpanContext?.spanId === runSpanId);

  beforeEach(async () => {
    bCalls = 0;
    spans = useInMemorySpans();
    defineSchedule(Nightly, 'nightly', { manual: true, resumable: true, retry: { attempts: 2, delay: '1s' } });
    defineSchedule(Nightly, 'inline-traced', { manual: true });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' }));
    s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
  });

  afterEach(async () => {
    undefineSchedule('nightly');
    undefineSchedule('inline-traced');
    await spans.detach();
  });

  after(() => resetTracing());

  it('nests step spans under a root run span', async () => {
    const run = await queuedRun('nightly', clock.now(), { MaxAttempts: 2 });
    await tick();

    const [first] = spans.byName('run nightly');
    expect(first.parentSpanContext).to.equal(undefined);
    expect(first.attributes).to.include({ 'spina.scheduler.run_id': run.Id, 'spina.scheduler.schedule': 'nightly', 'spina.scheduler.attempt': 1, 'spina.scheduler.trigger': 'manual' });
    expect(first.attributes).to.not.have.property('spina.scheduler.resumed');
    const steps = stepsUnder(first.spanContext().spanId);
    expect(steps.map((x) => x.name)).to.deep.equal(['step a', 'step b']);
    expect(steps[1].status).to.deep.equal({ code: SpanStatusCode.ERROR, message: 'Error' });
    expect(steps[1].events).to.deep.equal([]);
    expect(first.status).to.deep.equal({ code: SpanStatusCode.ERROR, message: 'Error' });
  });

  it('links a retried attempt to the attempt it continues and marks replayed steps', async () => {
    const run = await queuedRun('nightly', clock.now(), { MaxAttempts: 2 });
    await tick();
    clock.set(clock.now() + 1000);
    await tick();

    expect((await getRun(run.Id)).Status).to.eq('succeeded');
    const [first, second] = spans.byName('run nightly');
    expect(second.attributes['spina.scheduler.resumed']).to.equal(true);
    expect(second.links.map((l) => l.context.spanId)).to.deep.equal([first.spanContext().spanId]);
    const attempts = await RunAttemptModel.where('RunId', run.Id).orderBy('Attempt');
    expect(attempts.map((a) => a.TraceParent?.split('-')[2])).to.deep.equal([first.spanContext().spanId, second.spanContext().spanId]);
    const [replayedA, liveB] = stepsUnder(second.spanContext().spanId);
    expect(replayedA.attributes['spina.scheduler.replayed']).to.equal(true);
    expect(liveB.attributes).to.not.have.property('spina.scheduler.replayed');
  });

  it('links a run that resumes another run to that run’s last attempt', async () => {
    const failed = await queuedRun('nightly', clock.now(), { MaxAttempts: 1 });
    await tick();
    await queuedRun('nightly', clock.now(), { ResumeFrom: { runId: failed.Id } });
    await tick();

    const [first, second] = spans.byName('run nightly');
    expect(second.links.map((l) => l.context.spanId)).to.deep.equal([first.spanContext().spanId]);
    expect(second.attributes['spina.scheduler.resumed']).to.equal(true);
  });

  it('gives an inline run its own run span under the caller and leaves the caller span unmarked when the body fails', async () => {
    const service = await DI.resolve(SchedulerService);
    let callerSpanId = '';
    const failure: unknown = await withSpan('POST /cleanup', { kind: SpanKind.SERVER }, (caller) => {
      callerSpanId = caller.spanContext().spanId;
      return service
        .runInline('inline-traced', (ctx) => ctx.step('work', () => Promise.reject(new BodyFailed('body failed, params: secret-binding-42'))))
        .then(
          () => undefined,
          (e: unknown) => e,
        );
    });

    expect(failure).to.be.instanceOf(BodyFailed);
    const [caller] = spans.byName('POST /cleanup');
    const [run] = spans.byName('run inline-traced');
    expect(caller.status.code).to.equal(SpanStatusCode.UNSET);
    expect(caller.attributes).to.not.have.property('error.type');
    expect(run.parentSpanContext?.spanId).to.equal(callerSpanId);
    expect(run.status).to.deep.equal({ code: SpanStatusCode.ERROR, message: 'BodyFailed' });
    expect(run.attributes).to.not.have.property('spina.scheduler.resumed');
    expect(stepsUnder(run.spanContext().spanId).map((x) => x.name)).to.deep.equal(['step work']);
    expect(JSON.stringify(spans.spans().map((x) => [x.status, x.attributes, x.events]))).to.not.contain('secret-binding-42');

    const [row] = await RunModel.where('Schedule', 'inline-traced');
    const [attempt] = await RunAttemptModel.where('RunId', row.Id);
    expect(attempt.TraceParent?.split('-')[2]).to.equal(run.spanContext().spanId);
  });

  it('adds the attempt column in up and drops it in down', async () => {
    const driver = DI.get(Orm)?.Connections.get('sqlite');
    if (!driver) throw new Error('the sqlite connection is not booted');
    const columns = async () => (await driver.tableInfo('__scheduler_run_attempt')).map((c) => c.Name);

    expect(await columns()).to.include('TraceParent');
    await DI.resolve(Scheduler_2026_11_16_00_00_00).down(driver);
    expect(await columns()).to.not.include('TraceParent');
  });
});

@Job()
@SystemTask('a test job that only has to be emitted')
class TracedEmitJob extends QueueJob {
  public execute() {
    return Promise.resolve();
  }
}
class TracedEmitTask extends ScheduledTask {}

describe('scheduler spans in emit mode', () => {
  let spans: InMemorySpans;

  beforeEach(async () => {
    InMemoryQueueClient.reset();
    spans = useInMemorySpans();
    defineSchedule(TracedEmitTask, 'emit-traced', { manual: true, emit: TracedEmitJob });
    await bootTestEnv({ now: '2026-01-05T10:00:00Z', extra: queueConfig() });
  });

  afterEach(async () => {
    undefineSchedule('emit-traced');
    await spans.detach();
  });

  after(() => resetTracing());

  it('marks the run span by the error class when the emit fails', async () => {
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    InMemoryQueueClient.failNext = true;
    const run = await queuedRun('emit-traced', Date.parse('2026-01-05T10:00:00Z'));
    await s.tickOnce();
    await s.idle();

    expect((await getRun(run.Id)).Status).to.eq('failed');
    const [span] = spans.byName('run emit-traced');
    expect(span.parentSpanContext).to.equal(undefined);
    expect(span.status).to.deep.equal({ code: SpanStatusCode.ERROR, message: 'Error' });
    expect(span.attributes['error.type']).to.equal('Error');
    expect(span.events).to.deep.equal([]);
    expect(JSON.stringify([span.status, span.attributes])).to.not.contain('broker unavailable');
  });
});
