import { expect } from 'chai';
import { DI } from '@spinajs/di';
import {
  defineSchedule,
  duration,
  FakeClock,
  formatEvent,
  Page,
  RunDetail,
  RunInfo,
  ScheduleInfo,
  Scheduler,
  ScheduledTask,
  SchedulerErrorsCommand,
  SchedulerListCommand,
  SchedulerRunsCommand,
  SchedulerRunShowCommand,
  SchedulerShowCommand,
  table,
  undefineSchedule,
  when,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { captureConsole } from './support/console.js';
import { queuedRun } from './support/fixtures.js';

class CliReadOk extends ScheduledTask {
  public execute() {
    return 1;
  }
}
class CliReadBad extends ScheduledTask {
  public execute(): Promise<unknown> {
    return Promise.reject(new Error('bad 7'));
  }
}

describe('CLI read commands', () => {
  let clock: FakeClock;
  let s: Scheduler;
  let out: ReturnType<typeof captureConsole>;
  const execute = async (name: string) => {
    const run = await queuedRun(name, clock.now());
    await s.tickOnce();
    await s.idle();
    await clock.advance(1000);
    return run.Id;
  };

  beforeEach(async () => {
    process.exitCode = 0;
    defineSchedule(CliReadOk, 'cli-ok', { every: '5m' });
    defineSchedule(CliReadBad, 'cli-bad', { manual: true });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z' }));
    s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    out = captureConsole();
  });
  afterEach(() => {
    out.restore();
    process.exitCode = 0;
    ['cli-ok', 'cli-bad'].forEach(undefineSchedule);
  });

  it('formats tables, times and durations', () => {
    expect(table(['A', 'LONGER'], [['xyz', '1']])).to.deep.eq(['A    LONGER', 'xyz  1']);
    expect(when('2026-01-05T10:00:00.000Z')).to.eq('2026-01-05 10:00:00Z');
    expect(when(null)).to.eq('-');
    expect([duration(250), duration(1500), duration(125_000), duration(null)]).to.deep.eq([
      '250ms',
      '1.5s',
      '2m 5s',
      '-',
    ]);
    expect(
      formatEvent({
        type: 'status',
        status: 'running',
        reason: null,
        id: 1,
        seq: 1,
        runId: 'r',
        schedule: 's',
        attempt: 1,
        ts: '2026-01-05T10:00:01.000Z',
      }),
    ).to.eq('10:00:01 status   running');
  });

  it('scheduler:list prints a table and JSON', async () => {
    await (await DI.resolve(SchedulerListCommand)).execute({});
    expect(out.lines[0]).to.match(/^NAME\s+SPEC\s+NEXT RUN\s+PAUSED\s+HEALTH\s+LAST\s+PROGRESS$/);
    expect(
      out.lines.some((l) => l.startsWith('cli-ok') && l.includes('every 5m') && l.includes('2026-01-05 10:05:00Z')),
    ).to.eq(true);
    out.lines.length = 0;
    await (await DI.resolve(SchedulerListCommand)).execute({ json: true });
    expect(out.json<ScheduleInfo[]>().map((x) => x.name)).to.include.members(['cli-ok', 'cli-bad']);
  });

  it('scheduler:show reports unknown schedules with exit code 4', async () => {
    await (await DI.resolve(SchedulerShowCommand)).execute('cli-ok', { json: true });
    expect(out.json<ScheduleInfo>().name).to.eq('cli-ok');
    out.lines.length = 0;
    await (await DI.resolve(SchedulerShowCommand)).execute('nope', {});
    expect(process.exitCode).to.eq(4);
    expect(out.errors[0]).to.contain("Schedule 'nope' not found");
  });

  it('prints errors as JSON in --json mode', async () => {
    await (await DI.resolve(SchedulerShowCommand)).execute('nope', { json: true });
    expect(process.exitCode).to.eq(4);
    expect(out.json()).to.deep.eq({ error: { code: 'not-found', message: "Schedule 'nope' not found" } });
  });

  it('scheduler:runs filters by schedule and status', async () => {
    await execute('cli-ok');
    await execute('cli-bad');
    await (await DI.resolve(SchedulerRunsCommand)).execute(undefined, { status: 'failed', json: true });
    const page = out.json<Page<RunInfo>>();
    expect(page.items.map((r) => r.schedule)).to.deep.eq(['cli-bad']);
    out.lines.length = 0;
    await (await DI.resolve(SchedulerRunsCommand)).execute('cli-ok', {});
    expect(out.lines[0]).to.match(/^ID\s+STATUS\s+TRIGGER\s+ATTEMPT\s+CREATED\s+DURATION\s+PROGRESS\s+MESSAGE$/);
    expect(out.lines).to.have.length(2);
  });

  it('scheduler:runs rejects a bad --limit or --status with exit code 2', async () => {
    await (await DI.resolve(SchedulerRunsCommand)).execute(undefined, { limit: 'ten' });
    expect(process.exitCode).to.eq(2);
    expect(out.errors.join('\n')).to.contain('/limit');
    process.exitCode = 0;
    await (await DI.resolve(SchedulerRunsCommand)).execute(undefined, { status: 'faild', json: true });
    expect(process.exitCode).to.eq(2);
    expect(out.json<{ error: { code: string } }>().error.code).to.eq('invalid-params');
    process.exitCode = 0;
    out.lines.length = 0;
    await (await DI.resolve(SchedulerRunsCommand)).execute(undefined, { limit: '1', json: true });
    expect(out.json<Page<RunInfo>>().limit).to.eq(1);
    expect(process.exitCode).to.eq(0);
  });

  it('scheduler:run:show and scheduler:errors', async () => {
    const id = await execute('cli-bad');
    await (await DI.resolve(SchedulerRunShowCommand)).execute(id, { json: true });
    expect(out.json<RunDetail>()).to.include({ id, status: 'failed' });
    out.lines.length = 0;
    await (await DI.resolve(SchedulerRunShowCommand)).execute(id, {});
    expect(out.lines.join('\n')).to.contain('status:   failed').and.contain('Error: bad 7');
    out.lines.length = 0;
    await (await DI.resolve(SchedulerErrorsCommand)).execute('cli-bad', {});
    expect(out.lines[0]).to.match(/^FINGERPRINT\s+SCHEDULE\s+NAME\s+COUNT\s+LAST SEEN\s+STATUS\s+MESSAGE$/);
    expect(out.lines[1]).to.contain('cli-bad').and.contain('bad 7');
    out.lines.length = 0;
    await (await DI.resolve(SchedulerErrorsCommand)).execute(undefined, { status: 'gone' });
    expect(process.exitCode).to.eq(2);
  });
});
