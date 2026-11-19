import { expect } from 'chai';
import { DI } from '@spinajs/di';
import {
  defineSchedule,
  FakeClock,
  RunModel,
  Scheduler,
  SchedulerService,
  ScheduledTask,
  ScheduleModel,
  TriggeredBy,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';

const by: TriggeredBy = { kind: 'system', id: 'start-up' };
const at = (iso: string) => Date.parse(iso);
let executions = 0;

class HourlyJob extends ScheduledTask {
  public async execute() {
    executions++;
  }
}

const runsOf = async () =>
  (await RunModel.where('Schedule', 'hourly').orderBy('CreatedAt')).map((r) => [r.Trigger, r.Status, r.ScheduledAt]);

describe("misfire: 'skip' and occurrences missed while the application was down", () => {
  let clock: FakeClock;

  /** A new process: the loop is resolved stopped, the app runs every job once, then the loop starts. */
  async function restartWithStartUpPass(replicaId: string): Promise<Scheduler> {
    const s = await DI.resolve(Scheduler, [{ replicaId, autoStart: false }]);
    const service = await DI.resolve(SchedulerService);
    const { runId } = await service.runNow('hourly', { triggeredBy: by });
    expect(await s.runLocally(runId)).to.eq(true);
    await s.idle();
    await s.tickOnce();
    await s.idle();
    return s;
  }

  async function runUntilStopped(stopAt: string): Promise<void> {
    const s = await DI.resolve(Scheduler, [{ replicaId: 'before', autoStart: false }]);
    clock.set('2026-01-05T10:00:00Z');
    await s.tickOnce();
    await s.idle();
    clock.set(stopAt);
    await s.stop();
  }

  beforeEach(async () => {
    executions = 0;
    defineSchedule(HourlyJob, 'hourly', { every: '1h', misfire: 'skip' });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T09:59:30Z' }));
  });
  afterEach(() => undefineSchedule('hourly'));

  it('does not run an occurrence missed during a downtime longer than misfireThreshold', async () => {
    await runUntilStopped('2026-01-05T10:30:00Z');
    clock.set('2026-01-05T12:30:00Z');
    await restartWithStartUpPass('after');

    expect(await runsOf()).to.deep.eq([
      ['schedule', 'succeeded', at('2026-01-05T10:00:00Z')],
      ['manual', 'succeeded', at('2026-01-05T12:30:00Z')],
      ['schedule', 'misfired', at('2026-01-05T11:00:00Z')],
    ]);
    expect(executions).to.eq(2);
    expect((await ScheduleModel.where('Name', 'hourly').first()).NextRunAt).to.eq(at('2026-01-05T13:00:00Z'));
  });

  it('still runs an occurrence missed during a restart shorter than misfireThreshold, right after the start-up pass', async () => {
    // misfireThreshold defaults to max(2 x tick, 5 s) = 5 s here; the 11:00 occurrence fell into a 5 s restart
    await runUntilStopped('2026-01-05T10:59:58Z');
    clock.set('2026-01-05T11:00:03Z');
    await restartWithStartUpPass('after');

    expect(await runsOf()).to.deep.eq([
      ['schedule', 'succeeded', at('2026-01-05T10:00:00Z')],
      ['manual', 'succeeded', at('2026-01-05T11:00:03Z')],
      ['schedule', 'succeeded', at('2026-01-05T11:00:00Z')],
    ]);
    expect(executions).to.eq(3);
  });
});
