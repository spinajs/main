import { expect } from 'chai';
import { DI } from '@spinajs/di';
import {
  Clock,
  FakeClock,
  LeaseStore,
  RunContext,
  RunEvent,
  RunEventHub,
  RunEventWriter,
  RunExecutor,
  RunStepModel,
  Scheduler,
  ScheduledTask,
  SchedulerService,
  undefineSchedule,
} from '../../src/index.js';
import { waitFor } from '../support/env.js';
import { deferred, getRun, journal, makeDef, queuedRun, seedSchedules } from '../support/fixtures.js';
import {
  defineJsonRoundTripSchedule,
  expectJsonRoundTrip,
  JSON_ROUND_TRIP_SCHEDULE,
} from '../support/json-round-trip.js';
import { bootRealDb, REAL_DB_TARGETS } from './real-db.js';

const T = Date.parse('2026-01-05T10:00:00Z');
let gate = deferred();
let reachedGate = false;

class Import extends ScheduledTask {
  public async execute(ctx: RunContext) {
    ctx.expectSteps(2);
    await ctx.step('load', () => ({ rows: [1, 2] }));
    await ctx.step('process', async (s) => {
      for (let i = 1; i <= 8; i++) s.progress({ done: i, total: 10 });
      s.message('eight of ten');
      ctx.log.warn('slow row', { row: 8 });
      await ctx.checkpoint({ cursor: 8 });
      reachedGate = true;
      await gate.promise;
    });
    ctx.result({ imported: 8 });
  }
}
class Fails extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('parse', () => {
      throw new SyntaxError('bad csv');
    });
  }
}

const LONG_STEP = 'n'.repeat(128);
class OddSizes extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step(LONG_STEP, (s) => s.progress({ done: 2.5, total: 3_000_000_000 }), { weight: 0.5 });
    await ctx.step('b', () => 1, { weight: 1.5 });
  }
}

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`run context (${target.name})`, function () {
    this.timeout(60_000);
    let clock: FakeClock;
    let leases: LeaseStore;

    async function start(name: string, task: new () => ScheduledTask) {
      const def = makeDef(name, { manual: true }, task);
      await seedSchedules([def], T);
      const row = await queuedRun(name, T);
      expect(await leases.claimRun(row, T)).to.eq(true);
      return { row, handle: DI.resolve(RunExecutor, [leases]).start(row, def) };
    }

    beforeEach(async () => {
      gate = deferred();
      reachedGate = false;
      defineJsonRoundTripSchedule();
      // runLogLimit 1: the second progress row is dropped, so the run gets capped
      await bootRealDb(target, { runLogLimit: 1 });
      clock = DI.resolve(Clock) as FakeClock;
      leases = DI.resolve(LeaseStore, ['r1']);
    });

    it('records steps, flushed progress, log lines, the checkpoint and the result', async () => {
      const { row, handle } = await start('import', Import);
      await waitFor(() => reachedGate, 10_000);

      await clock.advance(1000);
      await waitFor(async () => (await getRun(row.Id)).Progress === 90, 10_000);
      await waitFor(
        async () => (await RunStepModel.where('RunId', row.Id).where('Name', 'process').first()).Done === 8,
        10_000,
      );
      expect(await getRun(row.Id)).to.deep.include({ CurrentStep: 'process', Checkpoint: { cursor: 8 } });

      gate.resolve();
      await handle.done;

      const steps = await RunStepModel.where('RunId', row.Id).orderBy('Seq');
      expect(steps.map((s) => [s.Name, s.Status, s.Progress, s.Done, s.Total, s.Message])).to.deep.eq([
        ['load', 'succeeded', 100, null, null, null],
        ['process', 'succeeded', 100, 8, 10, 'eight of ten'],
      ]);
      expect(steps[0].Result).to.deep.eq({ rows: [1, 2] });
      expect(steps.map((s) => s.ResultStored)).to.deep.eq([true, true]);
      const run = await getRun(row.Id);
      expect(run).to.deep.include({ Status: 'succeeded', Progress: 100, Result: { imported: 8 } });

      const events = await journal(row.Id);
      const log = events.find((e) => e.type === 'log');
      expect(log).to.deep.include({ level: 'warn', message: 'slow row', step: 'process', data: { row: 8 } });
      expect(events.filter((e) => e.type === 'progress')).to.have.length(1);
    });

    it('stores fractional weights and large or fractional done / total as given', async () => {
      const { row, handle } = await start('odd-sizes', OddSizes);
      await handle.done;
      expect((await getRun(row.Id)).Status).to.eq('succeeded');
      const steps = await RunStepModel.where('RunId', row.Id).orderBy('Seq');
      expect(steps.map((s) => [s.Name, s.Weight, s.Done, s.Total])).to.deep.eq([
        [LONG_STEP, 0.5, 2.5, 3_000_000_000],
        ['b', 1.5, null, null],
      ]);
    });

    afterEach(() => undefineSchedule(JSON_ROUND_TRIP_SCHEDULE));

    it('round-trips run results, step results and checkpoints of every JSON shape', async () => {
      clock.set('2026-01-05T10:00:30Z');
      const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
      await expectJsonRoundTrip(await DI.resolve(SchedulerService), s, clock);
    });

    it('stores the failing step error as JSON', async () => {
      const { row, handle } = await start('fails', Fails);
      await handle.done;
      const [step] = await RunStepModel.where('RunId', row.Id);
      expect(step).to.include({ Status: 'failed', ResultStored: false });
      expect(step.Error).to.include({ name: 'SyntaxError', step: 'parse' });
      expect((await getRun(row.Id)).Error).to.include({ step: 'parse' });
    });

    it('marks a capped run and rebuilds its latest progress for subscribers', async () => {
      const { row, handle } = await start('import', Import);
      await waitFor(() => reachedGate, 10_000);
      await clock.advance(1000);
      await waitFor(async () => (await journal(row.Id)).some((e) => e.type === 'progress'), 10_000);

      // the step moves on; its next progress row is dropped by the cap
      await RunStepModel.update({ Progress: 90, Done: 9 }).where('RunId', row.Id).where('Name', 'process');
      expect(
        await DI.resolve(RunEventWriter).write(row, 1, {
          type: 'progress',
          progress: 95,
          step: 'process',
          stepProgress: 90,
        }),
      ).to.eq(null);
      expect((await getRun(row.Id)).ProgressCapped).to.eq(true);

      const got: RunEvent[] = [];
      const off = await DI.resolve(RunEventHub).subscribe({ runId: row.Id }, (e) => got.push(e));
      off();
      const synthetic = got.filter((e) => e.type === 'progress' && e.synthetic);
      expect(synthetic.map((e) => e.type === 'progress' && [e.step, e.stepProgress, e.done])).to.deep.eq([
        ['load', 100, undefined],
        ['process', 90, 9],
      ]);

      gate.resolve();
      await handle.done;
    });
  });
}
