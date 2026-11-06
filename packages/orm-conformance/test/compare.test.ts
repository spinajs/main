import 'mocha';
import { expect } from 'chai';

import type { TargetName } from '../src/case.js';
import { compareTargets, describeVerdict, parseDivergences, type TargetResults } from '../src/compare.js';

const results = (entries: Array<[TargetName, Record<string, unknown>]>) => new Map<TargetName, TargetResults>(entries.map(([t, r]) => [t, new Map(Object.entries(r))]));

describe('compareTargets', () => {
  it('compares every target with PGlite and classifies each case', () => {
    const verdicts = compareTargets(
      results([
        ['pglite', { same: [1], differs: ['a'], accepted: ['x'], stale: [2] }],
        ['sqlite', { same: [1], differs: ['b'], accepted: ['y'], stale: [2] }],
      ]),
      [
        { case: 'accepted', target: 'sqlite', reason: 'collation', issue: 12 },
        { case: 'stale', target: 'sqlite', reason: 'fixed since', issue: 13 },
      ],
    );

    expect(verdicts.map((v) => `${v.case}:${v.status}`)).to.deep.equal(['same:agrees', 'differs:diverges', 'accepted:accepted', 'stale:stale']);
    expect(describeVerdict(verdicts[1])).to.equal('sqlite: expected ["a"] (pglite), got ["b"]');
    expect(describeVerdict(verdicts[3])).to.equal('sqlite: listed in divergences.json (13) but agrees with pglite now; remove the entry');
  });

  it('refuses to compare without the reference', () => {
    expect(() => compareTargets(results([['sqlite', {}]]), [])).to.throw('the reference target pglite did not run');
  });
});

describe('parseDivergences', () => {
  const cases = new Set(['where-eq']);

  it('accepts an issue number or "pending"', () => {
    expect(parseDivergences([{ case: 'where-eq', target: 'mysql', reason: 'r', issue: 'pending' }], cases)).to.have.length(1);
    expect(parseDivergences([{ case: 'where-eq', target: 'mssql', reason: 'r', issue: 7 }], cases)).to.have.length(1);
  });

  it('refuses an unknown case, the reference target, an empty reason and a bad issue', () => {
    expect(() => parseDivergences([{ case: 'nope', target: 'mysql', reason: 'r', issue: 1 }], cases)).to.throw('divergences.json[0]: case nope is not in the corpus');
    expect(() => parseDivergences([{ case: 'where-eq', target: 'pglite', reason: 'r', issue: 1 }], cases)).to.throw('divergences.json[0]: target must be one of sqlite, postgres, mysql, mssql');
    expect(() => parseDivergences([{ case: 'where-eq', target: 'mysql', reason: ' ', issue: 1 }], cases)).to.throw('divergences.json[0]: reason is required');
    expect(() => parseDivergences([{ case: 'where-eq', target: 'mysql', reason: 'r', issue: 0 }], cases)).to.throw('divergences.json[0]: issue must be a GitHub issue number or "pending"');
    expect(() => parseDivergences({}, cases)).to.throw('divergences.json must be an array');
  });
});
