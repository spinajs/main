import 'mocha';
import { expect } from 'chai';
import { runSuite } from '../src/index.js';
import { idempotencySuite } from '../suites/idempotency.sim.js';

describe('idempotency suite', function () {
  this.timeout(0);

  it('reaches idempotency.after-claim and survives a crash there', async () => {
    const report = await runSuite(idempotencySuite({ faults: [{ point: 'idempotency.after-claim', when: { nth: 1 }, effect: 'crash' }] }), 3, 80);
    expect(report.failure).to.equal(undefined);
    expect(report.faults.map((h) => h.point)).to.deep.equal(['idempotency.after-claim']);
  });

  it('catches work that runs outside a claim', async () => {
    const report = await runSuite(idempotencySuite({ bypass: true, faults: [] }), 3, 80);
    expect(report.failure?.invariant).to.be.oneOf(['one-execution-per-claim', 'stored-reply-has-one-effect-under-the-final-claim']);
  });
});
