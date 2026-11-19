import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import {
  defineSchedule,
  FakeClock,
  RunModel,
  Scheduler,
  SchedulerService,
  ScheduledTask,
  ScheduleModel,
  ScheduleNotFound,
  TriggeredBy,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv, waitFor } from './support/env.js';

chai.use(chaiAsPromised);

const by: TriggeredBy = { kind: 'system', id: 'start-up' };
const at = (iso: string) => Date.parse(iso);
let executions = 0;

class MarkHandledJob extends ScheduledTask {
  public async execute() {
    executions++;
  }
}
class MarkHandledOnce extends ScheduledTask {
  public async execute() {}
}

const NAMES = ['hourly', 'once'];
const runsOf = async (name: string) =>
  (await RunModel.where('Schedule', name).orderBy('CreatedAt')).map((r) => [r.Trigger, r.Status, r.ScheduledAt]);
const nextRunAt = async (name: string) => (await ScheduleModel.where('Name', name).first()).NextRunAt;

describe('Scheduler.markHandled', () => {
  let clock: FakeClock;
  let s: Scheduler;

  /** The application's own start-up pass: every job once, in this process, before the loop starts. */
  async function runStartupPass(name: string): Promise<void> {
    const { runId } = await (await DI.resolve(SchedulerService)).runNow(name, { triggeredBy: by });
    expect(await s.runLocally(runId)).to.eq(true);
    await s.idle();
  }
  const tick = async () => {
    await s.tickOnce();
    await s.idle();
  };

  beforeEach(async () => {
    executions = 0;
    defineSchedule(MarkHandledJob, 'hourly', { every: '1h' });
    defineSchedule(MarkHandledOnce, 'once', { at: '2026-01-05T10:00:00Z' });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T09:59:30Z' }));
    s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
  });
  afterEach(() => NAMES.forEach(undefineSchedule));

  it('runs nothing until the next occurrence after a start-up pass, also for an occurrence due two seconds ago', async () => {
    clock.set('2026-01-05T10:00:02Z');
    expect(await nextRunAt('hourly')).to.eq(at('2026-01-05T10:00:00Z'));

    await runStartupPass('hourly');
    expect(await s.markHandled('hourly')).to.eq(true);
    await tick();

    expect(await runsOf('hourly')).to.deep.eq([['manual', 'succeeded', at('2026-01-05T10:00:02Z')]]);
    expect(executions).to.eq(1);
    expect(await nextRunAt('hourly')).to.eq(at('2026-01-05T11:00:00Z'));

    clock.set('2026-01-05T11:00:00Z');
    await tick();
    expect((await runsOf('hourly')).at(-1)).to.deep.eq(['schedule', 'succeeded', at('2026-01-05T11:00:00Z')]);
  });

  it('after a restart, a pass, markHandled and start(), the loop runs nothing until the next occurrence', async () => {
    await s.stop();
    clock.set('2026-01-05T10:00:02Z');
    // a new process: its definition sync meets the stored next run that passed while it was down
    s = await DI.resolve(Scheduler, [{ replicaId: 'after-restart', autoStart: false }]);
    expect(await nextRunAt('hourly')).to.eq(at('2026-01-05T10:00:00Z'));

    await runStartupPass('hourly');
    expect(await s.markHandled('hourly')).to.eq(true);
    s.start();
    for (let i = 0; i < 20; i++) await clock.advance(250);
    await s.idle();
    expect(await runsOf('hourly')).to.deep.eq([['manual', 'succeeded', at('2026-01-05T10:00:02Z')]]);
    expect(await nextRunAt('hourly')).to.eq(at('2026-01-05T11:00:00Z'));
    // the unmarked one-off fired in the same window, so the started loop did tick
    expect((await runsOf('once')).map(([trigger]) => trigger)).to.deep.eq(['schedule']);

    clock.set('2026-01-05T10:59:59Z');
    await waitFor(async () => {
      await clock.advance(250);
      const runs = await runsOf('hourly');
      return runs.length === 2 && runs[1][1] === 'succeeded';
    });
    await s.stop();
    expect((await runsOf('hourly')).at(-1)).to.deep.eq(['schedule', 'succeeded', at('2026-01-05T11:00:00Z')]);
    expect(executions).to.eq(2);
  });

  it('refuses an unknown schedule', async () => {
    await expect(s.markHandled('ghost')).to.be.rejectedWith(ScheduleNotFound);
  });

  it('keeps a next run that is still ahead, writes no run, and says that nothing was moved', async () => {
    expect(await s.markHandled('hourly')).to.eq(false);
    expect(await nextRunAt('hourly')).to.eq(at('2026-01-05T10:00:00Z'));
    expect(await RunModel.all()).to.have.length(0);
  });

  it('moves the next run of a paused schedule the same way', async () => {
    await ScheduleModel.update({ Paused: true, PausedReason: 'manual' }).where('Name', 'hourly');
    clock.set('2026-01-05T10:30:00Z');
    expect(await s.markHandled('hourly')).to.eq(true);
    expect(await nextRunAt('hourly')).to.eq(at('2026-01-05T11:00:00Z'));
  });

  it('leaves a schedule without a further occurrence with no next run', async () => {
    clock.set('2026-01-05T10:00:05Z');
    expect(await s.markHandled('once')).to.eq(true);
    expect(await nextRunAt('once')).to.eq(null);
    await tick();
    expect(await runsOf('once')).to.deep.eq([]);
  });

  it('loses to the loop when the loop claimed the occurrence first, says so, and the occurrence runs once', async () => {
    clock.set('2026-01-05T10:00:02Z');
    await tick();
    expect(await s.markHandled('hourly')).to.eq(false);
    expect(await runsOf('hourly')).to.deep.eq([['schedule', 'succeeded', at('2026-01-05T10:00:00Z')]]);
    expect(await nextRunAt('hourly')).to.eq(at('2026-01-05T11:00:00Z'));
  });
});
