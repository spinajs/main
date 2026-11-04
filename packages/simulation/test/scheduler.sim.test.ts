import 'mocha';
import { expect } from 'chai';
import { runSuite } from '../src/index.js';
import { schedulerSuite } from '../suites/scheduler.sim.js';

describe('scheduler suite', function () {
  this.timeout(0);

  it('reaches scheduler.lease-renew and survives a crash there', async () => {
    const report = await runSuite(schedulerSuite({ faults: [{ point: 'scheduler.lease-renew', when: { nth: 1 }, effect: 'crash' }] }), 3, 80);
    expect(report.failure).to.equal(undefined);
    expect(report.faults.map((h) => h.point)).to.deep.equal(['scheduler.lease-renew']);
  });

  it('catches an occurrence fired twice', async () => {
    const report = await runSuite(schedulerSuite({ rogue: true, faults: [] }), 3, 80);
    expect(report.failure?.invariant).to.equal('occurrence-fired-once');
  });

  it('catches an attempt finished by a replica that never held its lease', async () => {
    const report = await runSuite(schedulerSuite({ usurper: true, faults: [] }), 3, 80);
    expect(report.failure?.invariant).to.equal('fenced-finalization');
  });

  // Bet 3 D17 routes model selects to a replica unless `.onPrimary()` was called; the due scans must ask for the primary.
  // Pending until Bet 3 O10 (`v4-o-10-replicas`) lands: `ReplicaRouter` does not exist on v4 yet (see `schedulerSuite`).
  it.skip('keeps the due scans on the primary when a replica router is bound', async () => {
    const report = await runSuite(schedulerSuite({ replicaRouter: true, faults: [] }), 3, 80);
    expect(report.failure).to.equal(undefined);
  });
});
