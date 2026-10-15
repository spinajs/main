import { expect } from 'chai';
import { DI } from '@spinajs/di';
import {
  appendJournalRow,
  Clock,
  defineSchedule,
  FakeClock,
  RunContext,
  RunLogModel,
  RunModel,
  RunStepModel,
  Scheduler,
  SchedulerService,
  ScheduledTask,
  TriggeredBy,
  undefineSchedule,
} from '../../src/index.js';
import { getRun, queuedRun } from '../support/fixtures.js';
import { bootRealDb, REAL_DB_TARGETS } from './real-db.js';

const by: TriggeredBy = { kind: 'user', id: '1' };
const DAY = 86_400_000;
let failing = true;

class SvcItQuick extends ScheduledTask {
  public execute() {
    return Promise.resolve({ ok: true });
  }
}

class SvcItImport extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('load', () => ctx.params);
    await ctx.step('save', () => {
      if (failing) throw new Error('save failed');
    });
  }
}

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`scheduler service (${target.name})`, function () {
    this.timeout(60_000);
    let clock: FakeClock;
    let s: Scheduler;
    let service: SchedulerService;
    const tick = async () => {
      await s.tickOnce();
      await s.idle();
    };

    beforeEach(async () => {
      failing = true;
      defineSchedule(SvcItImport, 'it-import', {
        every: '1h',
        resumable: true,
        retry: { attempts: 2, backoff: 'fixed', delay: '1s' },
        params: { type: 'object', properties: { n: { type: 'integer', default: 1 } } },
        pauseAfterFailures: 1,
      });
      defineSchedule(SvcItQuick, 'it-quick', { manual: true });
      await bootRealDb(target, { retention: { enabled: false, runs: '30d', logs: '7d', errors: '90d' } });
      clock = DI.resolve(Clock) as FakeClock;
      clock.set('2026-01-05T10:00:30Z');
      s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
      service = await DI.resolve(SchedulerService);
    });
    afterEach(() => ['it-import', 'it-quick'].forEach(undefineSchedule));

    it('claims a queued run of another schedule behind a long queue of one schedule', async () => {
      const now = clock.now();
      for (let i = 0; i < 55; i++) await queuedRun('it-import', now - 60_000 + i);
      const other = await queuedRun('it-quick', now);
      await tick();
      expect(await getRun(other.Id)).to.include({ Status: 'succeeded' });
    });

    it('runs, lists, retries with resume, pauses on failure and resumes', async () => {
      const { runId } = await service.runNow('it-import', { params: { n: '4' }, triggeredBy: by });
      await tick();
      await clock.advance(1000);
      await tick();
      expect(await getRun(runId)).to.include({ Status: 'dead', Attempt: 2 });

      const page = await service.listRuns({ schedule: 'it-import', status: ['dead'] });
      expect(page.total).to.equal(1).and.to.be.a('number');
      const info = (await service.listSchedules()).find((x) => x.name === 'it-import')!;
      expect(info).to.include({
        paused: true,
        pausedReason: 'failures',
        health: 'paused-by-failures',
        consecutiveFailures: 1,
      });
      const [group] = await service.listErrors({ schedule: 'it-import' });
      expect(group.count).to.equal(2).and.to.be.a('number');
      expect(await service.setErrorStatus(group.fingerprint, 'resolved', { triggeredBy: by })).to.include({
        status: 'resolved',
      });

      clock.set('2026-01-05T13:20:00Z');
      expect(await service.resume('it-import', { triggeredBy: by })).to.include({
        paused: false,
        consecutiveFailures: 0,
        nextRunAt: '2026-01-05T14:00:00.000Z',
      });

      failing = false;
      const retry = await service.retry(runId, { triggeredBy: by });
      expect(await getRun(retry.runId)).to.include({ Attempt: 3, MaxAttempts: 4, ParentRunId: runId });
      await tick();
      const detail = await service.getRun(retry.runId);
      expect(detail).to.include({ status: 'succeeded', progress: 100 });
      expect(detail.params).to.deep.eq({ n: 4 });
      expect(detail.steps.map((x) => [x.name, x.status])).to.deep.eq([
        ['load', 'skipped'],
        ['save', 'succeeded'],
      ]);
    });

    it('cancels a queued run and prunes past retention', async () => {
      const { runId } = await service.runNow('it-import', { triggeredBy: by });
      expect(await service.cancel(runId, { triggeredBy: by })).to.include({ status: 'aborted', reason: 'cancelled' });

      const now = clock.now();
      const old = await queuedRun('it-import', now - 40 * DAY, { Status: 'succeeded', FinishedAt: now - 40 * DAY });
      await RunStepModel.create({
        RunId: old.Id,
        Attempt: 1,
        Seq: 1,
        Name: 's',
        Status: 'succeeded',
        Weight: 1,
        StartedAt: now - 40 * DAY,
        Progress: 100,
      });
      await appendJournalRow({
        RunId: runId,
        Schedule: 'it-import',
        Seq: 10,
        Attempt: 1,
        Ts: now - 10 * DAY,
        Kind: 'log',
        Data: { type: 'log' } as never,
      });
      expect(await service.prune({ triggeredBy: by })).to.deep.eq({
        orphanedSchedules: 0,
        runs: 1,
        logs: 1,
        errors: 0,
      });
      expect((await RunModel.all()).map((r) => r.Id)).to.deep.eq([runId]);
      expect((await RunLogModel.where('RunId', runId)).map((r) => r.Kind)).to.deep.eq(['status', 'status']);
    });
  });
}
