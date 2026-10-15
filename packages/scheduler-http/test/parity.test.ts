import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import {
  cliParityDriver,
  Clock,
  DbTimeSource,
  DefaultSchedulerService,
  defineParitySchedules,
  DefinitionSync,
  ErrorGroupModel,
  FakeClock,
  appendJournalRow,
  isTerminalStatus,
  PARITY_CASES,
  ParityAction,
  runParityCases,
  RunAttemptModel,
  RunContext,
  RunLogModel,
  RunModel,
  RunStepModel,
  Schedule,
  ScheduledTask,
  ScheduleModel,
  ScheduleRegistry,
  Scheduler,
  SchedulerService,
  serviceParityDriver,
  undefineParitySchedules,
} from '@spinajs/scheduler';

import { asRole, bootRealHttp, req, stopHttp, TestConfiguration } from './common.js';
import { codeFromHttp, httpParityDriver, toHttpCall } from './http-parity-driver.js';
import { events, ISseConnection, openSse } from './sse-client.js';

// core PARITY_CASES arrange their rows against this instant
const PARITY_NOW = '2026-01-05T10:00:00.000Z';
const SAMPLE_RUN_ID = '00000000-0000-4000-8000-000000000001';
const STEPS_SCHEDULE = 'http-sse-steps';
const RETRY_SCHEDULE = 'http-sse-retry';

@Schedule(STEPS_SCHEDULE, { manual: true })
export class SseStepsTask extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('first', async (s) => {
      s.progress({ done: 1, total: 2 });
      s.progress({ done: 2, total: 2 });
    });
    await ctx.step('second', async () => undefined);
  }
}

let retryCalls = 0;

@Schedule(RETRY_SCHEDULE, { manual: true, retry: { attempts: 2, delay: '1s' } })
export class SseRetryTask extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('flaky', async () => {
      if (++retryCalls === 1) {
        throw new Error('first attempt fails');
      }
    });
  }
}

class ParityConfiguration extends TestConfiguration {
  protected schedulerSection(): Record<string, unknown> {
    // no loop of its own: the stream tests drive a Scheduler with tickOnce()
    return { enabled: false, shutdownGrace: 2000, retention: { enabled: false } };
  }

  protected extraConnections(): Array<Record<string, unknown>> {
    // importing @spinajs/queue registers JobModel on this connection ( same as the core test env )
    return [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'queue', Migration: { Table: 'orm_migrations', OnStartup: true } }];
  }

  protected extraSections(): Record<string, unknown> {
    // scheduler events go nowhere, as with the core's shipped routing
    return { queue: { default: 'black-hole', routing: {}, connections: [{ name: 'black-hole', service: 'BlackHoleQueueClient' }] } };
  }
}

const ALL_ACTIONS: Record<ParityAction['action'], true> = {
  listSchedules: true,
  getSchedule: true,
  runNow: true,
  listRuns: true,
  getRun: true,
  cancel: true,
  retry: true,
  retryFailed: true,
  pause: true,
  resume: true,
  listErrors: true,
  setErrorStatus: true,
  prune: true,
};

describe('http parity driver', () => {
  const actions = () => PARITY_CASES.map((c) => c.act({ runId: SAMPLE_RUN_ID }));

  it('maps every action of the core parity table to an HTTP call', () => {
    for (const action of actions()) {
      expect(() => toHttpCall(action), action.action).to.not.throw();
    }
  });

  it('runs every service action through the core parity table', () => {
    expect([...new Set(actions().map((a) => a.action))].sort()).to.deep.equal(Object.keys(ALL_ACTIONS).sort());
  });

  it('tells conflicts from invalid states by the runId in the body', () => {
    expect(codeFromHttp(409, { runId: null })).to.eq('conflict');
    expect(codeFromHttp(409, { status: 'succeeded' })).to.eq('invalid-state');
    expect(codeFromHttp(404, {})).to.eq('not-found');
    expect(codeFromHttp(400, {})).to.eq('invalid-params');
    expect(codeFromHttp(500, {})).to.eq('error');
  });
});

describe('scheduler-http: parity with the service and the CLI', function () {
  this.timeout(120000);

  const clock = new FakeClock(PARITY_NOW);
  let service: SchedulerService;
  let scheduler: Scheduler;

  // The HTTP server and its controllers stay; only scheduler state is wiped ( core "Runtime wiring" ).
  async function reset(): Promise<SchedulerService> {
    for (const model of [RunLogModel, RunStepModel, RunAttemptModel, RunModel, ErrorGroupModel, ScheduleModel]) {
      await model.truncate();
    }
    clock.set(PARITY_NOW);
    const registry = await DI.resolve(ScheduleRegistry);
    await (await DI.resolve(DefinitionSync)).sync(registry.all(), clock.now());
    return service;
  }

  async function tick(): Promise<void> {
    await scheduler.tickOnce();
    await scheduler.idle();
  }

  async function runViaHttp(schedule: string): Promise<{ live: ISseConnection; path: string }> {
    await reset();
    const accepted = await req().post(`scheduler/schedules/${schedule}/runs`).set(asRole('scheduler-admin')).send({});
    expect(accepted).to.have.status(202);

    const path = `/scheduler/runs/${accepted.body.runId}/events`;
    const live = await openSse(path, { 'x-test-role': 'scheduler-reader' });
    // still queued: the replayed `queued` status must not end the stream
    await live.waitFor((f) => events(f).length === 1);
    return { live, path };
  }

  const statusesOf = (conn: ISseConnection) =>
    events(conn.frames)
      .filter((f) => f.event === 'status')
      .map((f) => JSON.parse(f.data!) as { status: string; attempt: number });

  before(async () => {
    defineParitySchedules();
    await bootRealHttp(ParityConfiguration, () => {
      DI.register(DefaultSchedulerService).as(SchedulerService);
      DI.register(() => clock).as(Clock);
      DI.register(() => clock.dbSource).as(DbTimeSource);
    });
    service = await DI.resolve(SchedulerService);
    scheduler = await DI.resolve(Scheduler, [{ replicaId: 'http-test', autoStart: false }]);
  });

  after(async () => {
    await scheduler?.stop();
    await stopHttp();
    undefineParitySchedules();
  });

  it('every parity case gives the same result through SchedulerService, HTTP and the CLI', async () => {
    const outcomes = await runParityCases({
      reset,
      drivers: (s) => [serviceParityDriver(s), cliParityDriver(), httpParityDriver()],
    });

    expect(outcomes).to.have.length(PARITY_CASES.length);
    for (const o of outcomes) {
      expect(Object.keys(o.results), o.title).to.deep.equal(['service', 'cli', 'http']);
      const [first, ...rest] = Object.values(o.results);
      for (const r of rest) {
        expect(r, o.title).to.deep.equal(first);
      }
      expect(first.ok ? 'ok' : first.code, o.title).to.eq(o.expect);
    }
  });

  it('streams a real run in lifecycle order and resumes after Last-Event-ID', async () => {
    const { live, path } = await runViaHttp(STEPS_SCHEDULE);

    await tick();
    await live.ended;

    const all = events(live.frames);
    const types = all.map((f) => f.event!);
    const statuses = statusesOf(live).map((s) => s.status);

    expect(statuses).to.deep.equal(['queued', 'running', 'succeeded']);
    expect(isTerminalStatus(statuses[statuses.length - 1] as never)).to.eq(true);
    expect(types[types.length - 1]).to.eq('status');
    expect(types.indexOf('step-start')).to.be.greaterThan(types.indexOf('status'));
    expect(types.lastIndexOf('step-end')).to.be.lessThan(types.lastIndexOf('status'));
    expect(types.filter((t) => t === 'step-start')).to.have.lengthOf(2);
    expect(types.filter((t) => t === 'step-end')).to.have.lengthOf(2);

    const ids = all.map((f) => Number(f.id));
    expect(ids).to.deep.equal([...ids].sort((a, b) => a - b));

    const resumeAfter = ids[2];
    const resumed = await openSse(path, { 'x-test-role': 'scheduler-reader', 'Last-Event-ID': String(resumeAfter) });
    await resumed.ended;
    const resumedEvents = events(resumed.frames);

    expect(resumedEvents.map((f) => Number(f.id))).to.deep.equal(ids.filter((id) => id > resumeAfter));
    expect(resumedEvents[resumedEvents.length - 1].event).to.eq('status');
  });

  it('keeps the run stream open through an automatic retry', async () => {
    retryCalls = 0;
    const { live } = await runViaHttp(RETRY_SCHEDULE);

    await tick();
    await live.waitFor(() => statusesOf(live).some((s) => s.status === 'retrying'));
    const endedEarly = await Promise.race([live.ended.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 300))]);
    expect(endedEarly).to.eq(false);

    clock.set(clock.now() + 1000);
    await tick();
    await live.ended;

    expect(statusesOf(live).map((s) => [s.status, s.attempt])).to.deep.equal([
      ['queued', 1],
      ['running', 1],
      ['retrying', 1],
      ['running', 2],
      ['succeeded', 2],
    ]);
  });

  it('resumes a schedule stream with Last-Event-ID over events another replica wrote', async () => {
    await reset();
    const path = `/scheduler/schedules/${STEPS_SCHEDULE}/events`;
    const reader = { 'x-test-role': 'scheduler-reader' };
    // replica B: journal rows from a process whose hub this server never hears from
    const remote = (seq: number) =>
      appendJournalRow({ RunId: 'replica-b-run', Schedule: STEPS_SCHEDULE, Seq: seq, Attempt: 1, Ts: clock.now(), Kind: 'log', Data: { type: 'log', level: 'info', message: `b${seq}`, step: null } as never });
    const journalIds = async (from: number) => (await RunLogModel.where('Schedule', STEPS_SCHEDULE).where('Pos', '>=', from).orderBy('Pos')).map((r) => r.Pos);

    const first = await openSse(path, reader);
    const accepted = await req().post(`scheduler/schedules/${STEPS_SCHEDULE}/runs`).set(asRole('scheduler-admin')).send({});
    expect(accepted).to.have.status(202);
    await remote(1);
    await tick();
    await remote(2);
    // nothing local follows remote(2): the poll timer of the subscription has to pick it up
    await clock.advance(1000);

    await first.waitFor((f) => events(f).some((e) => JSON.parse(e.data!).message === 'b2'));
    const firstIds = events(first.frames).map((f) => Number(f.id));
    first.close();
    expect(firstIds).to.deep.equal(await journalIds(firstIds[0]));

    // the client lost the connection after two events and reconnects to another replica
    const resumeAfter = firstIds[1];
    await remote(3);
    const rest = await journalIds(resumeAfter + 1);
    const second = await openSse(path, { ...reader, 'Last-Event-ID': String(resumeAfter) });
    await second.waitFor((f) => events(f).length === rest.length);
    second.close();

    expect(events(second.frames).map((f) => Number(f.id))).to.deep.equal(rest);
    expect(rest).to.include.members(firstIds.slice(2));
  });
});
