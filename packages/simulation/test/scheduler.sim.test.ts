import 'mocha';
import { expect } from 'chai';
import { runSuite, type SimReport } from '../src/index.js';
import { schedulerSuite, type SchedulerSeedStats } from '../suites/scheduler.sim.js';

const details = (report: SimReport): string[] => (report.failure?.error as { details?: string[] } | undefined)?.details ?? [];

describe('scheduler suite', function () {
  this.timeout(0);

  it('reaches scheduler.lease-renew and survives a crash there', async () => {
    const report = await runSuite(schedulerSuite({ faults: [{ point: 'scheduler.lease-renew', when: { nth: 1 }, effect: 'crash' }] }), 3, 80);
    expect(report.failure).to.equal(undefined);
    expect(report.faults.map((h) => h.point)).to.deep.equal(['scheduler.lease-renew']);
  });

  it('drives reaped bodies into the finishRun fence', async () => {
    const seeds: SchedulerSeedStats[] = [];
    const suite = schedulerSuite({ observe: (s) => seeds.push(s) });
    for (const seed of [1, 2, 3]) expect((await runSuite(suite, seed)).failure).to.equal(undefined);
    expect(seeds.reduce((n, s) => n + s.staleFinishes, 0)).to.be.at.least(seeds.length);
  });

  it('catches an occurrence fired twice', async () => {
    const report = await runSuite(schedulerSuite({ rogue: true, faults: [] }), 3, 80);
    expect(report.failure?.invariant).to.equal('occurrence-fired-once');
    expect(details(report)).to.have.length.greaterThan(0);
    for (const scheduledAt of details(report)) expect(scheduledAt).to.match(/^\d+$/);
  });

  it('catches an attempt finished by a replica that never held its lease', async () => {
    const report = await runSuite(schedulerSuite({ usurper: true, faults: [] }), 3, 80);
    expect(report.failure?.invariant).to.equal('fenced-finalization');
    expect(details(report)).to.have.length.greaterThan(0);
    for (const row of details(report)) expect(row).to.match(/:end@usurper\.\d+$/);
  });

  it('catches a finished attempt whose outcome is rewritten', async () => {
    const report = await runSuite(schedulerSuite({ resurrector: true, faults: [] }), 3, 80);
    expect(report.failure?.invariant).to.equal('fenced-finalization');
    expect(details(report)[0]).to.match(/^attempt-outcome /);
  });

  // Bet 3 D17 routes model selects to a replica unless `.onPrimary()` was called; the due scans must ask for the primary.
  // Pending until Bet 3 O10 (`v4-o-10-replicas`) lands: `ReplicaRouter` does not exist on v4 yet (see `schedulerSuite`).
  it.skip('keeps the due scans on the primary when a replica router is bound', async () => {
    const report = await runSuite(schedulerSuite({ replicaRouter: true, faults: [] }), 3, 80);
    expect(report.failure).to.equal(undefined);
  });
});
