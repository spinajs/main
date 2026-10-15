import { expect } from 'chai';
import sinon from 'sinon';
import { fileURLToPath } from 'url';
import { Cli } from '@spinajs/cli';
import { DI } from '@spinajs/di';
import {
  collect,
  DefaultSchedulerService,
  defineSchedule,
  ErrorGroupModel,
  FakeClock,
  InvalidRunParams,
  parseParams,
  RunContext,
  RunDetail,
  RunInfo,
  RunAttemptModel,
  RunModel,
  ScheduleInfo,
  ScheduledTask,
  ScheduleModel,
  Scheduler,
  SchedulerCancelCommand,
  SchedulerErrorsResolveCommand,
  SchedulerPauseCommand,
  SchedulerPruneCommand,
  SchedulerResumeCommand,
  SchedulerRetryCommand,
  SchedulerRunCommand,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv, waitFor } from './support/env.js';
import { captureConsole } from './support/console.js';
import { driveUntil } from './support/fixtures.js';

let fail = false;
class CliActSum extends ScheduledTask {
  public execute(ctx: RunContext) {
    if (fail) throw new Error('sum failed');
    return (ctx.params.a as number) + (ctx.params.b as number);
  }
}

/** Fails its first `failuresLeft` attempts. */
let failuresLeft = 0;
class CliActFlaky extends ScheduledTask {
  public execute(ctx: RunContext) {
    if (failuresLeft > 0) {
      failuresLeft--;
      throw new Error(`flaky attempt ${ctx.attempt}`);
    }
    return ctx.attempt;
  }
}

const SCHEMA = { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] };
const NAMES = ['sum', 'flaky', 'flaky-dead'];
const CLI_DIR = fileURLToPath(new URL('../src/cli', import.meta.url));
const cmd = async <T>(type: new () => T) => (await DI.resolve(type as never)) as T;
const runsOf = (schedule: string) => RunModel.where('Schedule', schedule).orderBy('CreatedAt');

describe('CLI action commands', () => {
  let clock: FakeClock;
  let out: ReturnType<typeof captureConsole>;

  beforeEach(async () => {
    fail = false;
    failuresLeft = 0;
    process.exitCode = 0;
    defineSchedule(CliActSum, 'sum', { manual: true, params: SCHEMA });
    defineSchedule(CliActFlaky, 'flaky', { manual: true, retry: { attempts: 3, backoff: 'fixed', delay: '10s' } });
    defineSchedule(CliActFlaky, 'flaky-dead', { manual: true, retry: { attempts: 2, backoff: 'fixed', delay: '10s' } });
    ({ clock } = await bootTestEnv({
      now: '2026-01-05T10:00:00Z',
      extra: { system: { dirs: { cli: [CLI_DIR] } } },
    }));
    out = captureConsole();
  });
  afterEach(() => {
    out.restore();
    sinon.restore();
    process.exitCode = 0;
    NAMES.forEach(undefineSchedule);
  });

  it('parses --params and --param', () => {
    expect(parseParams('{"a":1}', ['b=2'])).to.deep.eq({ a: 1, b: '2' });
    expect(parseParams(undefined, [])).to.eq(undefined);
    expect(parseParams(undefined, ['q=a=b'])).to.deep.eq({ q: 'a=b' });
    expect(collect('x=1', collect('y=2'))).to.deep.eq(['y=2', 'x=1']);
    expect(() => parseParams('[1]')).to.throw(InvalidRunParams);
    expect(() => parseParams('{bad')).to.throw(InvalidRunParams);
    expect(() => parseParams(undefined, ['novalue'])).to.throw(InvalidRunParams);
  });

  it('runs locally, waits and exits 0 on success', async () => {
    await (await cmd(SchedulerRunCommand)).execute('sum', { param: ['a=2', 'b=3'], local: true, json: true });
    const { run } = out.json<{ runId: string; run: RunInfo }>();
    expect(run).to.include({ status: 'succeeded', result: 5 });
    expect(run.triggeredBy).to.include({ kind: 'system', id: 'cli' });
    expect(process.exitCode).to.eq(0);
  });

  it('exits 1 when the waited run fails', async () => {
    fail = true;
    await (await cmd(SchedulerRunCommand)).execute('sum', { params: '{"a":1,"b":1}', local: true });
    expect(process.exitCode).to.eq(1);
    expect(out.lines.join('\n')).to.contain('failed');
  });

  it('exits 2 on invalid params, 3 on conflict, 4 on unknown schedule', async () => {
    await (await cmd(SchedulerRunCommand)).execute('sum', { param: ['a=x'] });
    expect(process.exitCode).to.eq(2);
    expect(out.errors.join('\n')).to.contain('/a');
    process.exitCode = 0;
    await (await cmd(SchedulerRunCommand)).execute('sum', { param: ['a=1', 'b=1'] });
    await (await cmd(SchedulerRunCommand)).execute('sum', { param: ['a=1', 'b=1'] });
    expect(process.exitCode).to.eq(3);
    process.exitCode = 0;
    await (await cmd(SchedulerRunCommand)).execute('nope', {});
    expect(process.exitCode).to.eq(4);
  });

  it('cancels, retries, pauses, resumes, resolves and prunes', async () => {
    await (await cmd(SchedulerRunCommand)).execute('sum', { param: ['a=1', 'b=1'], json: true });
    const { runId } = out.json<{ runId: string }>();
    out.lines.length = 0;
    await (await cmd(SchedulerCancelCommand)).execute(runId, { json: true });
    expect(out.json<RunInfo>()).to.include({ status: 'aborted', reason: 'cancelled' });

    out.lines.length = 0;
    await (await cmd(SchedulerRetryCommand)).execute(runId, { json: true });
    const retried = out.json<{ runId: string }>().runId;
    expect((await RunModel.where('Id', retried).first()).ParentRunId).to.eq(runId);

    out.lines.length = 0;
    await RunModel.update({ Status: 'failed', FinishedAt: clock.now() }).where('Id', retried);
    await (await cmd(SchedulerRetryCommand)).execute(undefined, {
      schedule: 'sum',
      failedSince: '2026-01-05T00:00:00Z',
      json: true,
    });
    expect(out.json<{ runIds: string[] }>().runIds).to.have.length(1);

    out.lines.length = 0;
    await (await cmd(SchedulerPauseCommand)).execute('sum', { hard: true, json: true });
    expect(out.json<ScheduleInfo>()).to.include({ paused: true, hardPaused: true });
    out.lines.length = 0;
    await (await cmd(SchedulerResumeCommand)).execute('sum', { json: true });
    expect(out.json<ScheduleInfo>().paused).to.eq(false);

    await ErrorGroupModel.create({
      Schedule: 'sum',
      Fingerprint: 'fp',
      Name: 'Error',
      SampleMessage: 'm',
      Count: 1,
      FirstSeen: clock.now(),
      LastSeen: clock.now(),
      Status: 'open',
    });
    out.lines.length = 0;
    await (await cmd(SchedulerErrorsResolveCommand)).execute('fp', { json: true });
    expect(out.json<{ status: string }>().status).to.eq('resolved');

    await ScheduleModel.update({ Orphaned: true }).where('Name', 'sum');
    out.lines.length = 0;
    await (await cmd(SchedulerPruneCommand)).execute({ json: true });
    expect(out.json<{ orphanedSchedules: number }>().orphanedSchedules).to.eq(1);
    expect(process.exitCode).to.eq(0);
  });

  it('requires a run id or --schedule with --failed-since for retry', async () => {
    await (await cmd(SchedulerRetryCommand)).execute(undefined, {});
    expect(process.exitCode).to.eq(2);
  });

  it('waits for a run the server loop executes', async () => {
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    const done = (await cmd(SchedulerRunCommand)).execute('sum', { param: ['a=4', 'b=4'], wait: true, json: true });
    await waitFor(async () => (await runsOf('sum')).length === 1);
    await s.tickOnce();
    await s.idle();
    await done;
    expect(out.json<{ run: RunInfo }>().run).to.include({ status: 'succeeded', result: 8 });
    expect(process.exitCode).to.eq(0);
  });

  describe('--local --wait with automatic retries', () => {
    it('claims every retry in this process once it is due and exits 0 when one succeeds', async () => {
      failuresLeft = 2;
      const done = (await cmd(SchedulerRunCommand)).execute('flaky', { local: true, follow: true });
      await driveUntil(clock, done);
      const [run] = await runsOf('flaky');
      expect(run).to.include({ Status: 'succeeded', Attempt: 3 });
      expect(process.exitCode).to.eq(0);
      const text = out.lines.join('\n');
      expect(text.match(/status {3}retrying/g)).to.have.length(2);
      expect(text).to.contain(`run ${run.Id} succeeded`);
    });

    it('does not claim a retry before its NextAttemptAt', async () => {
      failuresLeft = 1;
      const done = (await cmd(SchedulerRunCommand)).execute('flaky', { local: true, json: true });
      await waitFor(async () => (await runsOf('flaky'))[0]?.Status === 'retrying');
      const due = (await runsOf('flaky'))[0].NextAttemptAt as number;
      await clock.advance(due - clock.now() - 1000);
      expect((await runsOf('flaky'))[0].Status).to.eq('retrying');
      await driveUntil(clock, done);
      const [run] = await runsOf('flaky');
      expect(run).to.include({ Status: 'succeeded', Attempt: 2 });
      const second = await RunAttemptModel.where('RunId', run.Id).where('Attempt', 2).first();
      expect(second.StartedAt).to.be.at.least(due);
    });

    it('exits 1 when the retries are exhausted', async () => {
      failuresLeft = 5;
      const done = (await cmd(SchedulerRunCommand)).execute('flaky-dead', { local: true, json: true });
      await driveUntil(clock, done);
      expect(out.json<{ run: RunDetail }>().run).to.include({ status: 'dead', attempt: 2 });
      expect(process.exitCode).to.eq(1);
    });

    it('keeps following when another replica claims the retry', async () => {
      failuresLeft = 1;
      const sleep = sinon.spy(clock, 'sleep');
      const done = (await cmd(SchedulerRunCommand)).execute('flaky', { local: true, json: true });
      await waitFor(async () => (await runsOf('flaky'))[0]?.Status === 'retrying');
      const due = (await runsOf('flaky'))[0].NextAttemptAt as number;
      // the CLI is asleep until the attempt is due
      await waitFor(() => sleep.args.some(([ms]) => ms === due - clock.now()));
      // jump past the backoff without firing the CLI's timer, so r2 claims first
      clock.set(due + 1000);
      const r2 = await DI.resolve(Scheduler, [{ replicaId: 'r2', autoStart: false }]);
      await r2.tickOnce();
      await r2.idle();
      const [run] = await runsOf('flaky');
      expect(run).to.include({ Status: 'succeeded', Attempt: 2 });
      await driveUntil(clock, done);
      expect(out.json<{ run: RunDetail }>().run.status).to.eq('succeeded');
      expect(process.exitCode).to.eq(0);
    });
  });

  describe('through the real @spinajs/cli argv parsing', () => {
    const cli = async (...argv: string[]) => {
      DI.register(() => ['node', 'spinajs', ...argv]).as('__cli_argv_provider__');
      DI.uncache(Cli);
      await DI.resolve(Cli);
    };

    it('repeats --param, sets the exit code and leaves resume to the schedule unless a flag is given', async () => {
      await cli('scheduler:run', 'sum', '--param', 'a=1', '--param', 'b=2', '--local', '--json');
      expect(out.json<{ run: RunInfo }>().run).to.include({ status: 'succeeded', result: 3 });
      expect(process.exitCode).to.eq(0);
      const [first] = await runsOf('sum');

      const retry = sinon.spy(DefaultSchedulerService.prototype, 'retry');
      await cli('scheduler:retry', first.Id, '--json');
      await cli('scheduler:retry', first.Id, '--no-resume', '--json');
      await cli('scheduler:retry', first.Id, '--resume', '--from-step', 'x', '--json');
      expect(retry.args.map((a) => [a[1].resume, a[1].fromStep])).to.deep.eq([
        [undefined, undefined],
        [false, undefined],
        [true, 'x'],
      ]);
      // retrying a succeeded run is an invalid state
      expect(process.exitCode).to.eq(3);

      process.exitCode = 0;
      await cli('scheduler:runs', '--status', 'nope');
      expect(process.exitCode).to.eq(2);
    });
  });
});
