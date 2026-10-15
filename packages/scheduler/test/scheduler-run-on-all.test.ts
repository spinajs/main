import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { defineSchedule, RunModel, Scheduler, ScheduledTask, ScheduleModel, undefineSchedule } from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { deferred } from './support/fixtures.js';

let gate = deferred();
class LocalWork extends ScheduledTask {
  public async execute() {
    await gate.promise;
  }
}

describe('Scheduler: runOn all', () => {
  beforeEach(() => {
    gate = deferred();
    defineSchedule(LocalWork, 'local-cache', { every: '1m', runOn: 'all' });
  });
  afterEach(() => undefineSchedule('local-cache'));

  it('runs on every replica and records each run', async () => {
    gate.resolve();
    const { clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z' });
    const all = await Promise.all(
      ['r1', 'r2', 'r3'].map((replicaId) => DI.resolve(Scheduler, [{ replicaId, autoStart: false }])),
    );
    await Promise.all(all.map((s) => s.tickOnce()));
    clock.set('2026-01-05T10:01:00Z');
    await Promise.all(all.map((s) => s.tickOnce()));
    await Promise.all(all.map((s) => s.idle()));
    const runs = await RunModel.where('Schedule', 'local-cache');
    expect(runs.map((r) => r.Status)).to.deep.eq(['succeeded', 'succeeded', 'succeeded']);
    expect(runs.every((r) => r.Forced)).to.eq(true);
    expect(runs.every((r) => r.ScheduledAt === Date.parse('2026-01-05T10:01:00Z'))).to.eq(true);
    expect((await ScheduleModel.where('Name', 'local-cache').first()).NextRunAt).to.eq(null);
  });

  it('skips locally while the previous local run is still going', async () => {
    const { clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z' });
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    await s.tickOnce();
    clock.set('2026-01-05T10:01:00Z');
    await s.tickOnce();
    clock.set('2026-01-05T10:02:00Z');
    await s.tickOnce();
    expect(
      (await RunModel.where('Schedule', 'local-cache').orderBy('CreatedAt')).map((r) => r.Status),
    ).to.deep.eq(['running', 'skipped']);
    gate.resolve();
    await s.idle();
  });

  it('does not catch up after downtime: the next local run is the first after now', async () => {
    gate.resolve();
    const { clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z' });
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    await s.tickOnce();
    clock.set('2026-01-05T10:05:30Z');
    await s.tickOnce();
    await s.idle();
    clock.set('2026-01-05T10:06:00Z');
    await s.tickOnce();
    await s.idle();
    const runs = await RunModel.where('Schedule', 'local-cache').orderBy('CreatedAt');
    expect(runs.map((r) => new Date(r.ScheduledAt!).toISOString())).to.deep.eq([
      '2026-01-05T10:01:00.000Z',
      '2026-01-05T10:06:00.000Z',
    ]);
  });

  it('wakes up for the next local occurrence instead of waiting a whole tick', async () => {
    gate.resolve();
    const { clock } = await bootTestEnv({ now: '2026-01-05T10:00:59.900Z', scheduler: { tick: 30_000 } });
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1' }]);
    // the first tick at boot planned 10:01:00; the timer must fire then, not 30 s later
    await clock.advance(0);
    for (let i = 0; i < 20 && (await RunModel.where('Schedule', 'local-cache')).length === 0; i++) {
      await clock.advance(50);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await RunModel.where('Schedule', 'local-cache')).to.have.length(1);
    await s.stop();
  });
});
