import { expect } from 'chai';
import { DI } from '@spinajs/di';
import {
  defineSchedule,
  FakeClock,
  RunModel,
  Scheduler,
  ScheduledTask,
  ScheduleModel,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { deferred, journal } from './support/fixtures.js';

const at = (iso: string) => Date.parse(iso);
let gate = deferred();
class PolicyQuick extends ScheduledTask {
  public async execute() {
    return 1;
  }
}
class PolicyGated extends ScheduledTask {
  public async execute() {
    await gate.promise;
  }
}
const NAMES = ['skip', 'run-once', 'catch-up', 'queue', 'small-delay', 'catch-up-busy', 'cron-skip'];
const runsOf = (name: string) => RunModel.where('Schedule', name).orderBy('CreatedAt');

describe('Scheduler: misfire and overlap', () => {
  let clock: FakeClock;
  let s: Scheduler;

  async function boot(name: string, options: object, task: new () => ScheduledTask = PolicyQuick) {
    defineSchedule(task, name, options);
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z' }));
    s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
  }
  const tick = async () => {
    await s.tickOnce();
    await s.idle();
  };

  beforeEach(() => {
    gate = deferred();
    gate.resolve();
  });
  afterEach(() => NAMES.forEach(undefineSchedule));

  it('skip: records one misfired run after downtime and does not execute', async () => {
    await boot('skip', { every: '1m', misfire: 'skip' });
    clock.set('2026-01-05T10:10:30Z');
    await tick();
    const runs = await runsOf('skip');
    expect(runs.map((r) => r.Status)).to.deep.eq(['misfired']);
    expect(runs[0].Message).to.contain('missed 10 occurrence(s)');
    expect((await ScheduleModel.where('Name', 'skip').first()).NextRunAt).to.eq(at('2026-01-05T10:11:00Z'));
    expect((await journal(runs[0].Id)).map((e) => e.type === 'status' && [e.status, e.reason])).to.deep.eq([
      ['misfired', 'misfire'],
    ]);
  });

  it('skip: says so when more occurrences were missed than it counted', async () => {
    await boot('cron-skip', { cron: '* * * * *', misfire: 'skip' });
    clock.set('2026-03-05T10:10:30Z');
    await tick();
    const runs = await runsOf('cron-skip');
    expect(runs.map((r) => r.Status)).to.deep.eq(['misfired']);
    expect(runs[0].Message).to.match(/missed more than \d+ occurrence\(s\)/);
    expect((await ScheduleModel.where('Name', 'cron-skip').first()).NextRunAt).to.eq(at('2026-03-05T10:11:00Z'));
  });

  it('run-once: runs once as catch-up for the latest missed occurrence', async () => {
    await boot('run-once', { every: '1m', misfire: 'run-once' });
    clock.set('2026-01-05T10:10:30Z');
    await tick();
    const runs = await runsOf('run-once');
    expect(runs.map((r) => [r.Status, r.Trigger, r.ScheduledAt])).to.deep.eq([
      ['succeeded', 'catch-up', at('2026-01-05T10:10:00Z')],
    ]);
    expect(runs[0].Message).to.contain('9 earlier occurrence(s)');
  });

  it('catch-up(3): runs the last three missed occurrences one after another', async () => {
    await boot('catch-up', { every: '1m', misfire: 'catch-up(3)' });
    clock.set('2026-01-05T10:10:30Z');
    for (let i = 0; i < 4; i++) await tick();
    const runs = await runsOf('catch-up');
    expect(runs.map((r) => r.ScheduledAt)).to.deep.eq([
      at('2026-01-05T10:08:00Z'),
      at('2026-01-05T10:09:00Z'),
      at('2026-01-05T10:10:00Z'),
    ]);
    expect(runs.every((r) => r.Trigger === 'catch-up' && r.Status === 'succeeded')).to.eq(true);
  });

  it('catch-up waits for the lease instead of recording a skip', async () => {
    gate = deferred();
    await boot('catch-up-busy', { every: '1m', misfire: 'catch-up(2)' }, PolicyGated);
    clock.set('2026-01-05T10:05:30Z');
    await s.tickOnce();
    // the second catch-up occurrence is due now, but the first one still runs
    await s.tickOnce();
    expect((await runsOf('catch-up-busy')).map((r) => [r.Status, r.ScheduledAt])).to.deep.eq([
      ['running', at('2026-01-05T10:04:00Z')],
    ]);
    gate.resolve();
    await s.idle();
    await tick();
    expect((await runsOf('catch-up-busy')).map((r) => [r.Status, r.ScheduledAt])).to.deep.eq([
      ['succeeded', at('2026-01-05T10:04:00Z')],
      ['succeeded', at('2026-01-05T10:05:00Z')],
    ]);
  });

  it('overlap queue: one queued run behind the current one, further ones skipped', async () => {
    gate = deferred();
    await boot('queue', { every: '1m', overlap: 'queue' }, PolicyGated);
    clock.set('2026-01-05T10:01:00Z');
    await s.tickOnce();
    clock.set('2026-01-05T10:02:00Z');
    await s.tickOnce();
    clock.set('2026-01-05T10:03:00Z');
    await s.tickOnce();
    const runs = await runsOf('queue');
    expect(runs.map((r) => r.Status)).to.deep.eq(['running', 'queued', 'skipped']);
    expect(runs[1]).to.include({ Reason: 'overlap', Trigger: 'schedule', ScheduledAt: at('2026-01-05T10:02:00Z') });
    expect(runs[1].Message).to.contain(runs[0].Id);
    gate.resolve();
    await s.idle();
    await tick();
    expect((await runsOf('queue')).map((r) => r.Status)).to.deep.eq(['succeeded', 'succeeded', 'skipped']);
  });

  it('a small delay inside the threshold is a normal scheduled run', async () => {
    await boot('small-delay', { every: '1m' });
    clock.set('2026-01-05T10:01:03Z');
    await tick();
    expect((await runsOf('small-delay')).map((r) => r.Trigger)).to.deep.eq(['schedule']);
  });
});
