import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Job, JobModel, QueueJob } from '@spinajs/queue';
import {
  Clock,
  defineSchedule,
  EmitMirror,
  ErrorGroupModel,
  FakeClock,
  RunAttemptModel,
  RunModel,
  Scheduler,
  ScheduledTask,
  ScheduleModel,
  undefineSchedule,
} from '../../src/index.js';
import { journal } from '../support/fixtures.js';
import { bootRealDb, REAL_DB_TARGETS } from './real-db.js';

@Job()
export class ItEmitMirrorJob extends QueueJob {
  public execute() {
    return Promise.resolve();
  }
}
class ItEmitMirrorTask extends ScheduledTask {}

const JOB_ID = '6b1d0c3e-2a51-4c1f-9a77-3f0e9d1c5b20';

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`emit mirror (${target.name})`, function () {
    this.timeout(60_000);
    let clock: FakeClock;

    beforeEach(async () => {
      defineSchedule(ItEmitMirrorTask, 'it-mirror', { every: '1h', emit: ItEmitMirrorJob, pauseAfterFailures: 3 });
      await bootRealDb(target);
      clock = DI.resolve(Clock) as FakeClock;
      clock.set('2026-01-05T10:00:30Z');
      await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    });
    afterEach(() => undefineSchedule('it-mirror'));

    it('finalizes a mirrored run once under concurrent polls', async () => {
      const now = clock.now();
      const runId = '0b7f3a52-91c4-4e8e-8d0a-2c6f5e4b1a90';
      await RunModel.create({
        Id: runId,
        Schedule: 'it-mirror',
        Trigger: 'schedule',
        Status: 'emitted',
        Attempt: 1,
        MaxAttempts: 1,
        CreatedAt: now,
        StartedAt: now,
        Progress: 0,
        JobId: JOB_ID,
        CancelRequested: false,
        Forced: false,
      });
      await RunAttemptModel.create({ RunId: runId, Attempt: 1, StartedAt: now, Status: 'emitted' });
      await JobModel.create({
        JobId: JOB_ID,
        Name: 'ItEmitMirrorJob',
        Connection: 'memory',
        Status: 'dead',
        LastError: 'smtp down',
        Progress: 0,
        Attempt: 2,
        MaxAttempts: 2,
      });

      const mirror = DI.resolve(EmitMirror);
      const counts = await Promise.all([1, 2, 3, 4, 5].map(() => mirror.sync(now + 1000)));
      expect(counts.reduce((a, b) => a + b, 0)).to.eq(1);

      expect(await RunModel.where('Id', runId).first()).to.include({ Status: 'dead', Reason: 'queue' });
      expect((await journal(runId)).map((e) => e.type)).to.deep.eq(['error', 'status']);
      expect(Number((await ScheduleModel.where('Name', 'it-mirror').first()).ConsecutiveFailures)).to.eq(1);
      const groups = await ErrorGroupModel.where('Schedule', 'it-mirror');
      expect(groups.map((g) => [g.Name, Number(g.Count)])).to.deep.eq([['QueueJobFailedError', 1]]);
    });
  });
}
