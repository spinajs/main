import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { LeaseStore, RunModel, ScheduleModel, SqlDbTimeSource } from '../../src/index.js';
import { bootRealDb, REAL_DB_TARGETS } from './real-db.js';

const MIN = 60_000;
// Beyond 2^31 on purpose: the columns must be BIGINT on every driver.
const T = Date.parse('2026-01-05T10:00:00Z');

const queued = (id: string, extra: Partial<RunModel> = {}) =>
  RunModel.create({
    Id: id,
    Schedule: 'a',
    Trigger: 'manual',
    Status: 'queued',
    Attempt: 1,
    MaxAttempts: 3,
    CreatedAt: T,
    Progress: 0,
    CancelRequested: false,
    Forced: false,
    ...extra,
  });

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`lease integration (${target.name})`, function () {
    this.timeout(60_000);

    beforeEach(async () => {
      await bootRealDb(target);
      await ScheduleModel.create({
        Name: 'a',
        Definition: {},
        DefinitionHash: 'h',
        NextRunAt: T,
        Paused: false,
        HardPaused: false,
        ConsecutiveFailures: 0,
        Orphaned: false,
        UpdatedAt: T,
      });
    });

    it('reads database time', async () => {
      const ms = await DI.resolve(SqlDbTimeSource).read();
      expect(Math.abs(ms - Date.now())).to.be.lessThan(10_000);
    });

    it('three replicas: N occurrences produce exactly N claims', async () => {
      const stores = ['r1', 'r2', 'r3'].map((id) => DI.resolve(LeaseStore, [id]));
      const N = 20;
      let wins = 0;
      for (let i = 0; i < N; i++) {
        const o = { name: 'a', expectedNextRunAt: T + i * MIN, nextRunAt: T + (i + 1) * MIN, now: T + i * MIN };
        const results = await Promise.all(stores.map((s) => s.tryClaimOccurrence(o)));
        expect(results.filter(Boolean)).to.have.length(1);
        wins++;
        const owner = stores[results.indexOf(true)];
        await owner.releaseScheduleLease('a', o.now);
      }
      expect(wins).to.eq(N);
      expect((await ScheduleModel.where('Name', 'a').first()).NextRunAt).to.eq(T + N * MIN);
    });

    it('a manual run claim and a scheduled claim race for one lease', async () => {
      const r1 = DI.resolve(LeaseStore, ['r1']);
      const r2 = DI.resolve(LeaseStore, ['r2']);
      const run = await queued('m1', { MaxAttempts: 1 });
      const [manual, scheduled] = await Promise.all([
        r1.claimRun(run, T),
        r2.tryClaimOccurrence({ name: 'a', expectedNextRunAt: T, nextRunAt: T + MIN, now: T }),
      ]);
      expect([manual, scheduled].filter(Boolean)).to.have.length(1);
    });

    it('three replicas race for one queued run: exactly one runs it', async () => {
      const stores = ['r1', 'r2', 'r3'].map((id) => DI.resolve(LeaseStore, [id]));
      await queued('q1', { Forced: true });
      const observed = await Promise.all(stores.map(() => RunModel.where('Id', 'q1').first()));
      const results = await Promise.all(stores.map((s, i) => s.claimRun(observed[i], T)));
      expect(results.filter(Boolean)).to.have.length(1);
      const row = await RunModel.where('Id', 'q1').first();
      expect(row).to.include({
        Status: 'running',
        LeaseOwner: stores[results.indexOf(true)].ReplicaId,
        LeaseUntil: T + stores[0].LeaseTtl,
        StartedAt: T,
      });
    });

    // MySQL counts only changed rows unless the client sets CLIENT_FOUND_ROWS (mysql2 does by
    // default); a heartbeat in the same millisecond writes identical values and must still count.
    it('a renewal that writes identical values still counts as owned', async () => {
      const r1 = DI.resolve(LeaseStore, ['r1']);
      expect(await r1.claimRun(await queued('q1'), T)).to.eq(true);
      expect(await r1.renewScheduleLease('a', T)).to.eq(true);
      expect(await r1.renewScheduleLease('a', T)).to.eq(true);
      expect(await r1.renewRun('q1', 'a', T + 1000, { Progress: 10 })).to.deep.eq({ ok: true, cancelRequested: false });
      expect(await r1.renewRun('q1', 'a', T + 1000, { Progress: 10 })).to.deep.eq({ ok: true, cancelRequested: false });
    });

    it('an expiry racing a late heartbeat: exactly one wins', async () => {
      const r1 = DI.resolve(LeaseStore, ['r1']);
      const r2 = DI.resolve(LeaseStore, ['r2']);
      expect(await r1.claimRun(await queued('q1'), T)).to.eq(true);
      const stale = await RunModel.where('Id', 'q1').first();
      const late = T + r1.LeaseTtl + 1;
      const [renewed, expired] = await Promise.all([
        r1.renewRun('q1', null, late),
        r2.expireRun(stale, late, { status: 'retrying', reason: 'lease-expired', nextAttemptAt: late + MIN }),
      ]);
      expect([renewed.ok, expired].filter(Boolean)).to.have.length(1);
      const row = await RunModel.where('Id', 'q1').first();
      expect(row).to.include(
        expired ? { Status: 'retrying', LeaseUntil: null } : { Status: 'running', LeaseUntil: late + r1.LeaseTtl },
      );
    });
  });
}
