import { strict as assert } from 'node:assert';
import fc from 'fast-check';
import 'mocha';

import { rlsConformance, rlsMismatch, userPrincipal } from '../../src/index.js';

describe('rlsConformance', () => {
  it('rlsMismatch: equal needs the same rows, superset only the rows .accessible() returns', () => {
    assert.equal(rlsMismatch(['a', 'b'], ['b', 'a'], 'equal'), undefined);
    assert.equal(rlsMismatch(['a'], ['a', 'b'], 'equal'), 'RLS shows rows .accessible() does not: b');
    assert.equal(rlsMismatch(['a'], ['a', 'b'], 'superset'), undefined);
    assert.equal(rlsMismatch(['a', 'c'], ['b'], 'superset'), 'RLS hides rows .accessible() returns: a, c');
  });

  it('passes when the two sides agree on every world', async () => {
    const rows = new Map<number, string[]>();
    await rlsConformance<number>({
      world: fc.integer({ min: 0, max: 5 }),
      load: async (n) => void rows.set(0, Array.from({ length: n }, (_, i) => `r${i}`)),
      comparisons: () => [{ principal: userPrincipal('alice'), permission: 'doc:read' }],
      accessible: async () => rows.get(0)!,
      rls: async () => [...rows.get(0)!].reverse(),
      numRuns: 10,
    });
  });

  it('fails naming the principal, the rows and a replay seed', async () => {
    let world = 0;
    await assert.rejects(
      rlsConformance<number>({
        world: fc.integer({ min: 0, max: 3 }),
        load: async (n) => void (world = n),
        comparisons: () => [{ principal: userPrincipal('alice'), permission: 'doc:read' }],
        accessible: async () => (world > 1 ? ['r1'] : []),
        rls: async () => [],
        numRuns: 50,
        seed: 7,
      }),
      (e: Error) => /user:alice doc:read \(equal\): RLS hides rows \.accessible\(\) returns: r1/.test(e.message) && /replay with \{ seed: 7 \}/.test(e.message),
    );
  });
});
