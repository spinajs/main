import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import {
  computeFingerprint,
  ErrorGroupModel,
  ErrorTracker,
  HealthTracker,
  ScheduleModel,
  StructuredError,
} from '../../src/index.js';
import { QueryContext } from '@spinajs/orm';
import { waitFor } from '../support/env.js';
import { bootRealDb, defaultDriver, heldOpen, REAL_DB_TARGETS } from './real-db.js';

const T = Date.parse('2026-01-05T10:00:00Z');
const err = (message: string): StructuredError => ({
  name: 'Error',
  message,
  attempt: 1,
  occurredAt: new Date(T).toISOString(),
  stack: `Error: ${message}\n    at Job.execute (/app/lib/Job.js:3:9)`,
});

const LOCK_WAITS: Record<string, string> = {
  postgres: `SELECT COUNT(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'`,
  mysql: `SELECT COUNT(*) AS n FROM information_schema.innodb_trx WHERE trx_state = 'LOCK WAIT'`,
};

async function someoneWaitsForALock(target: string): Promise<boolean> {
  // polling slowly leaves pooled connections to the statement under test
  await new Promise((resolve) => setTimeout(resolve, 100));
  const rows = (await (await defaultDriver()).executeOnDb(LOCK_WAITS[target], [], QueryContext.Select)) as Array<{
    n: number | string;
  }>;
  return Number(rows[0].n) > 0;
}

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`error groups and health (${target.name})`, function () {
    this.timeout(60_000);

    beforeEach(async () => {
      await bootRealDb(target);
    });
    afterEach(() => sinon.restore());

    it('concurrent replicas count a new group in one row', async () => {
      const tracker = DI.resolve(ErrorTracker);
      const N = 20;
      await Promise.all(
        Array.from({ length: N }, (_, i) => tracker.record('it', `r${i}`, err(`row ${i} failed`), T + i)),
      );
      const groups = await ErrorGroupModel.where('Schedule', 'it');
      expect(groups).to.have.length(1);
      expect(Number(groups[0].Count)).to.eq(N);
    });

    it('an insert that loses the race on the unique index bumps the winner', async () => {
      const e = err('boom');
      const fingerprint = computeFingerprint('it', e);
      const held = await heldOpen(() =>
        ErrorGroupModel.create({
          Schedule: 'it',
          Fingerprint: fingerprint,
          Name: 'Error',
          SampleMessage: 'boom',
          SampleStack: null,
          Count: 1,
          FirstSeen: T,
          LastSeen: T,
          LastRunId: 'r1',
          Status: 'open',
        }),
      );
      const create = sinon.spy(ErrorGroupModel, 'create');
      const recording = DI.resolve(ErrorTracker).record('it', 'r2', e, T + 1);
      await waitFor(() => someoneWaitsForALock(target.name), 20_000);
      await held.commit();
      expect(await recording).to.deep.eq({ fingerprint, regressed: false });
      // Postgres does not see the uncommitted row, so the insert runs and loses on the unique index;
      // InnoDB's locking UPDATE waits for the row lock instead and bumps the committed row
      expect(create.callCount).to.eq(target.name === 'postgres' ? 1 : 0);
      const g = await ErrorGroupModel.where('Schedule', 'it').first();
      expect({ Count: Number(g.Count), LastRunId: g.LastRunId }).to.deep.eq({ Count: 2, LastRunId: 'r2' });
    });

    it('a resolved group regresses exactly once under concurrency', async () => {
      const tracker = DI.resolve(ErrorTracker);
      const { fingerprint } = await tracker.record('it', 'r0', err('boom'), T);
      await ErrorGroupModel.update({ Status: 'resolved' }).where('Fingerprint', fingerprint);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => tracker.record('it', `r${i + 1}`, err('boom'), T + i)),
      );
      expect(results.filter((r) => r.regressed)).to.have.length(1);
      const g = await ErrorGroupModel.where('Fingerprint', fingerprint).first();
      expect({ Status: g.Status, Count: Number(g.Count) }).to.deep.eq({ Status: 'open', Count: 11 });
    });

    it('concurrent failures are all counted and pause the schedule once', async () => {
      await ScheduleModel.create({
        Name: 'it',
        Definition: {},
        DefinitionHash: 'h',
        NextRunAt: null,
        Paused: false,
        HardPaused: false,
        ConsecutiveFailures: 0,
        Orphaned: false,
        UpdatedAt: T,
      });
      const health = DI.resolve(HealthTracker);
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => health.recordFailure('it', 4, T + i)));
      expect(results.filter((r) => r.paused)).to.have.length(1);
      const row = await ScheduleModel.where('Name', 'it').first();
      expect({ n: Number(row.ConsecutiveFailures), paused: row.Paused, reason: row.PausedReason }).to.deep.eq({
        n: 10,
        paused: true,
        reason: 'failures',
      });
      await health.recordSuccess('it', T + 100);
      const after = await ScheduleModel.where('Name', 'it').first();
      expect({ n: Number(after.ConsecutiveFailures), at: after.LastSuccessAt }).to.deep.eq({ n: 0, at: T + 100 });
    });
  });
}
