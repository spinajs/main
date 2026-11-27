import 'mocha';
import { expect } from 'chai';
import fc from 'fast-check';

import { stateAt } from '../src/index.js';
import { changeSequence, escapedHistory, foldForward, instantAt, keyInput, keysOf } from './arbitraries.js';

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

  // P1: with writes that escaped the stream, a known state is still the true one.
  it('stateAt answers the true state or a gap when writes escaped the stream', () => {
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
});
