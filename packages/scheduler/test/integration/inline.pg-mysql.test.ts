import { expect } from 'chai';
import { DI } from '@spinajs/di';
import {
  defaultReplicaId,
  defineSchedule,
  RunModel,
  ScheduledTask,
  ScheduleModel,
  ScheduleOverlap,
  SchedulerService,
  undefineSchedule,
} from '../../src/index.js';
import { queuedRun } from '../support/fixtures.js';
import { bootRealDb, REAL_DB_TARGETS } from './real-db.js';

class InlineIt extends ScheduledTask {}

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`inline runs (${target.name})`, function () {
    this.timeout(60_000);

    beforeEach(async () => {
      defineSchedule(InlineIt, 'it-inline', { manual: true });
      defineSchedule(InlineIt, 'it-inline-all', { manual: true, runOn: 'all' });
      await bootRealDb(target);
    });
    afterEach(() => ['it-inline', 'it-inline-all'].forEach(undefineSchedule));

    it('inserts the claimed run row, finishes it and releases the schedule lease', async () => {
      const service = await DI.resolve(SchedulerService);
      let during: RunModel | undefined;
      const value = await service.runInline('it-inline', async (ctx) => {
        during = await RunModel.where('Id', ctx.runId).first();
        return { ok: true };
      });

      expect(value).to.deep.eq({ ok: true });
      expect(during).to.include({ Status: 'running', Trigger: 'manual', Forced: false });
      expect(during?.LeaseOwner).to.be.a('string');
      expect(await RunModel.where('Id', during!.Id).first()).to.include({ Status: 'succeeded', LeaseOwner: null });
      expect((await ScheduleModel.where('Name', 'it-inline').first())?.LeaseOwner).to.eq(null);
    });

    it("refuses a runOn: 'all' call while this replica holds a live run of the schedule", async () => {
      const service = await DI.resolve(SchedulerService);
      const now = Date.now();
      const held = await queuedRun('it-inline-all', now, {
        Status: 'running',
        Forced: true,
        LeaseOwner: defaultReplicaId(),
        LeaseUntil: now + 3_600_000,
      });

      const err = (await service.runInline('it-inline-all', () => Promise.resolve(1)).catch((e: unknown) => e)) as ScheduleOverlap;
      expect(err).to.be.instanceOf(ScheduleOverlap);
      expect(err.runId).to.eq(held.Id);
    });
  });
}
