import 'mocha';
import { expect } from 'chai';
import { runSuite, summaryLine } from '../src/index.js';
import { SUITES } from '../suites/index.js';

// smoke only: the `simulation` CI job (200 seeds per suite) is the seed gate; SIM_SEEDS raises it locally
const SEEDS = Number(process.env.SIM_SEEDS ?? 3);

for (const [name, load] of Object.entries(SUITES)) {
  describe(`simulation suite ${name}`, function () {
    this.timeout(0);

    it(`passes seeds 1..${SEEDS}`, async () => {
      const suite = await load();
      const failures: string[] = [];
      for (let seed = 1; seed <= SEEDS; seed++) {
        const report = await runSuite(suite, seed);
        if (report.failure) failures.push(summaryLine(name, report));
      }
      expect(failures).to.deep.equal([]);
    });

    it('replays a seed identically', async () => {
      const suite = await load();
      const first = await runSuite(suite, 7, 120);
      const second = await runSuite(suite, 7, 120);
      expect(second.faults).to.deep.equal(first.faults);
      expect(second.trace).to.deep.equal(first.trace);
    });
  });
}
