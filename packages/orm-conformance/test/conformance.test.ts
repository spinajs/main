import 'mocha';
import { expect } from 'chai';
import { readFileSync } from 'node:fs';

import { CASES } from '../cases/index.js';
import { availableTargets, compareTargets, describeVerdict, parseDivergences, runTarget, type TargetName, type TargetResults, type Verdict } from '../src/index.js';

const divergences = parseDivergences(JSON.parse(readFileSync(new URL('../divergences.json', import.meta.url), 'utf8')) as unknown, new Set(CASES.map((c) => c.name)));

describe('orm conformance', function () {
  const targets = availableTargets();
  const byCase = new Map<string, Verdict[]>();

  before(async () => {
    const results = new Map<TargetName, TargetResults>();
    for (const target of targets) {
      results.set(target.name, await runTarget(target, CASES));
    }

    for (const verdict of compareTargets(results, divergences)) {
      byCase.set(verdict.case, [...(byCase.get(verdict.case) ?? []), verdict]);
    }
  });

  after(() => {
    const counts = new Map<string, number>();
    for (const verdict of [...byCase.values()].flat()) {
      const key = `${verdict.target} ${verdict.status}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    console.log(`      targets: ${targets.map((t) => t.name).join(', ')}; verdicts: ${JSON.stringify(Object.fromEntries(counts))}`);
  });

  for (const c of CASES) {
    it(c.name, () => {
      const problems = (byCase.get(c.name) ?? []).filter((v) => v.status === 'diverges' || v.status === 'stale');
      expect(problems.map(describeVerdict)).to.deep.equal([]);
    });
  }

  it('every accepted divergence links an opened issue', () => {
    const pending = divergences.filter((d) => d.issue === 'pending').map((d) => `${d.case} on ${d.target}: ${d.reason}`);
    // An agent writes "pending" and the user opens the issues later. Only the conformance workflow fails on them
    // ( ORM_CONFORMANCE_REQUIRE_ISSUES=1 ), so npm test in build.yml stays green on every branch meanwhile.
    if (process.env.ORM_CONFORMANCE_REQUIRE_ISSUES !== '1') {
      if (pending.length > 0) {
        console.log(`      ${pending.length} divergence(s) pending an issue number; ORM_CONFORMANCE_REQUIRE_ISSUES=1 fails on them`);
      }
      return;
    }

    expect(pending).to.deep.equal([]);
  });
});
