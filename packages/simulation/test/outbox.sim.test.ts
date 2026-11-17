import 'mocha';
import { expect } from 'chai';
import { runSuite } from '../src/index.js';
import { outboxSuite, type OutboxSeedStats } from '../suites/outbox.sim.js';

describe('outbox suite', function () {
  this.timeout(0);

  it('redelivers a duplicate that arrives while a dead consumer still holds the key, and handles it once', async () => {
    const seeds: OutboxSeedStats[] = [];
    const suite = outboxSuite({ observe: (stats) => seeds.push(stats) });
    for (const seed of [1, 2, 3]) expect((await runSuite(suite, seed)).failure).to.equal(undefined);
    expect(seeds).to.have.length(3);
    expect(seeds.reduce((n, s) => n + s.inFlightDuplicates, 0)).to.be.greaterThan(0);
  });

  it('survives a relay crash between publish and mark', async () => {
    const report = await runSuite(outboxSuite({ faults: [{ point: 'outbox.before-mark', when: { nth: 1 }, effect: 'crash' }] }), 3, 80);
    expect(report.failure).to.equal(undefined);
    expect(report.faults.map((h) => h.point)).to.deep.equal(['outbox.before-mark']);
  });

  it('catches a consumer that does not deduplicate a redelivery', async () => {
    const report = await runSuite(outboxSuite({ deduplicate: false, faults: [{ point: 'queue.before-ack', when: { nth: 1 }, effect: 'crash' }] }), 3, 80);
    expect(report.failure?.invariant).to.equal('handled-at-most-once');
  });

  it('catches a consumer that does not deduplicate a broker duplicate', async () => {
    const report = await runSuite(outboxSuite({ deduplicate: false, faults: [{ point: 'outbox.after-publish', when: 'always', effect: 'duplicate' }] }), 3, 80);
    expect(report.failure?.invariant).to.equal('handled-at-most-once');
  });
});
