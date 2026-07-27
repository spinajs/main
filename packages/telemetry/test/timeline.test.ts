import 'mocha';
import { expect } from 'chai';

import { Timeline } from './../src/index.js';

describe('Timeline — rolling ring of RequestStats buckets', () => {
  it('records land in the bucket for their timestamp', () => {
    const tl = new Timeline(60, 60_000);
    const t = 10 * 60_000; // exact bucket boundary -> key 10
    tl.record(200, 5, t);
    tl.record(500, 5, t + 1000); // same bucket
    tl.record(200, 5, t + 60_000); // next bucket ( key 11 )

    const j = tl.toJSON();
    expect(Object.keys(j)).to.have.members(['10', '11']);
    expect(j['10'].responses).to.eq(2);
    expect(j['10'].errors).to.eq(1);
    expect(j['11'].responses).to.eq(1);
  });

  it('keyFor buckets by floor(timestamp / bucketMs)', () => {
    const tl = new Timeline(60, 60_000);
    expect(tl.keyFor(0)).to.eq(0);
    expect(tl.keyFor(59_999)).to.eq(0);
    expect(tl.keyFor(60_000)).to.eq(1);
    expect(tl.keyFor(125_000)).to.eq(2);
  });

  it('tick rotates and expires buckets older than length', () => {
    const tl = new Timeline(3, 60_000); // keep only 3 buckets
    const base = 0;
    tl.record(200, 1, base + 0 * 60_000); // key 0
    tl.record(200, 1, base + 1 * 60_000); // key 1
    tl.record(200, 1, base + 2 * 60_000); // key 2
    expect(Object.keys(tl.toJSON()).sort()).to.deep.eq(['0', '1', '2']);

    // advance to key 3 -> oldest allowed is 3 - 3 + 1 = 1, so key 0 expires
    tl.tick(base + 3 * 60_000);
    expect(Object.keys(tl.toJSON()).sort()).to.deep.eq(['1', '2', '3']);

    // advance to key 5 -> keys < 3 expire. tick() only opens the CURRENT bucket
    // ( key 5 ) and expires old ones; it does not backfill the empty key 4.
    tl.tick(base + 5 * 60_000);
    expect(Object.keys(tl.toJSON()).sort()).to.deep.eq(['3', '5']);
  });

  it('is deterministic with injected timestamps ( no reliance on the real clock )', () => {
    const tl = new Timeline(60, 1000, 25);
    const t = 42_000; // key 42 at bucketMs=1000
    tl.record(200, 10, t);
    const j = tl.toJSON();
    expect(Object.keys(j)).to.deep.eq(['42']);
    expect(j['42'].apdex_satisfied).to.eq(1);
  });
});
