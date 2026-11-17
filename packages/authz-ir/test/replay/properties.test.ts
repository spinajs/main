import 'mocha';
import { expect } from 'chai';
import fc from 'fast-check';

import { IREvaluator, stateAt } from '../../src/index.js';
import { changeSequence, completedSource, completion, escapedHistory, foldForward, gapSelection, gappedSource, instantAt, irAndTuples, keyInput, keysOf } from './arbitraries.js';

describe('replay properties', function () {
  this.timeout(60_000);

  // P1: reverse equals forward wherever before-images exist, and is never wrong without them.
  it('stateAt equals the forward fold of the changes at or before T', () => {
    fc.assert(
      fc.property(changeSequence(), fc.integer({ min: 0, max: 14 }), fc.boolean(), (seq, tIndex, retainBefore) => {
        const t = instantAt(tIndex);
        for (const key of keysOf()) {
          const expected = foldForward(seq.initial[key], seq.changes.filter((c) => c.key === key && c.at <= t));
          const withImages = stateAt(t, keyInput(seq, key, t, { beforeImages: true, retainBefore: true }));
          expect(withImages).to.deep.include({ known: true, value: expected });
          const without = stateAt(t, keyInput(seq, key, t, { beforeImages: false, retainBefore }));
          if (without.known) expect(without.value).to.deep.equal(expected);
        }
      }),
      { numRuns: 500 },
    );
  });

  // P1, R1 rule: with writes that escaped the log, a known state is still the true one.
  it('stateAt answers the true state or a gap when writes escaped the log', () => {
    let known = 0;
    fc.assert(
      fc.property(escapedHistory(), (h) => {
        const s = stateAt(h.t, h.input);
        if (!s.known) return;
        known++;
        expect(s.value).to.deep.equal(h.truth);
      }),
      { numRuns: 5000 },
    );
    expect(known).to.be.greaterThan(500);
  });

  // P2: Kleene soundness: a determinate truth with gap reads equals the truth of any completion.
  it('a determinate truth with gap reads equals the truth of any completion', async () => {
    let determinate = 0;
    await fc.assert(
      fc.asyncProperty(irAndTuples(), gapSelection(), completion(), async (w, gaps, fill) => {
        const input = { principal: w.principal, permission: 'doc:view', resource: { type: 'doc', id: 'd1' } };
        const partial = await new IREvaluator(w.ir, gappedSource(w, gaps)).check(input);
        if (partial.truth === 'unknown') return;
        determinate++;
        const full = await new IREvaluator(w.ir, completedSource(w, gaps, fill)).check(input);
        expect(full.truth).to.equal(partial.truth);
      }),
      { numRuns: 300 },
    );
    expect(determinate).to.be.greaterThan(30);
  });
});
