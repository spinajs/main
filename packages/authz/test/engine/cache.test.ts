import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { LruDecisionCache } from '../../src/engine/cache.js';
import { AuthzConfigError } from '../../src/contracts/errors.js';
import { DecisionCache } from '../../src/contracts/service.js';
import { TRUE } from '../../src/contracts/filter.js';
import type { Decision } from '../../src/contracts/decision.js';

const expect = chai.expect;

function decision(permission: string): Decision {
  return Object.freeze({
    allowed: true,
    permission,
    resource: { type: 'doc' },
    principal: { type: 'user', id: 'u1' },
    residual: TRUE,
    fields: { read: ['*'], write: ['*'] },
    roles: {},
    domain: 'default',
  }) as Decision;
}

class FakeClock {
  ms = 1_000_000;
  readonly now = () => new Date(this.ms);
  advance(ms: number) {
    this.ms += ms;
  }
}

describe('LruDecisionCache', () => {
  it('is a DecisionCache', () => {
    expect(new LruDecisionCache()).to.be.instanceOf(DecisionCache);
  });

  it('returns what was set and misses unknown keys', () => {
    const c = new LruDecisionCache();
    const d = decision('doc.read');
    c.set('k', d, ['*'], 1000);
    expect(c.get('k')).to.equal(d);
    expect(c.get('other')).to.equal(undefined);
    expect(c.size).to.equal(1);
  });

  describe('ttl', () => {
    it('expires exactly at the deadline and removes the entry on access', () => {
      const clock = new FakeClock();
      const c = new LruDecisionCache({ clock: clock.now });
      const d = decision('doc.read');
      c.set('k', d, ['*'], 100);
      clock.advance(99);
      expect(c.get('k')).to.equal(d);
      clock.advance(1);
      expect(c.get('k')).to.equal(undefined);
      expect(c.size).to.equal(0);
    });

    it('stores nothing and serves nothing while the clock gives an invalid date', () => {
      let invalid = false;
      const c = new LruDecisionCache({ clock: () => (invalid ? new Date(NaN) : new Date(0)) });
      c.set('k', decision('doc.read'), [], 1000);
      invalid = true;
      expect(c.get('k')).to.equal(undefined);
      c.set('k2', decision('doc.read'), [], 1000);
      expect(c.size).to.equal(0);
    });

    for (const ttl of [0, -1, NaN, Infinity, -Infinity]) {
      it(`stores nothing for ttl ${ttl} and drops an older entry under the key`, () => {
        const c = new LruDecisionCache();
        c.set('k', decision('doc.read'), ['a'], 1000);
        c.set('k', decision('doc.write'), ['a'], ttl);
        expect(c.get('k')).to.equal(undefined);
        expect(c.size).to.equal(0);
        c.set('fresh', decision('doc.read'), ['b'], ttl);
        expect(c.size).to.equal(0);
      });
    }
  });

  describe('lru', () => {
    it('evicts the least recent entry beyond maxEntries', () => {
      const c = new LruDecisionCache({ maxEntries: 2 });
      c.set('a', decision('a.x'), [], 1000);
      c.set('b', decision('b.x'), [], 1000);
      c.set('c', decision('c.x'), [], 1000);
      expect(c.get('a')).to.equal(undefined);
      expect(c.get('b')).to.not.equal(undefined);
      expect(c.get('c')).to.not.equal(undefined);
      expect(c.size).to.equal(2);
    });

    it('get refreshes recency', () => {
      const c = new LruDecisionCache({ maxEntries: 2 });
      c.set('a', decision('a.x'), [], 1000);
      c.set('b', decision('b.x'), [], 1000);
      c.get('a');
      c.set('c', decision('c.x'), [], 1000);
      expect(c.get('b')).to.equal(undefined);
      expect(c.get('a')).to.not.equal(undefined);
      expect(c.get('c')).to.not.equal(undefined);
    });

    it('set of an existing key refreshes recency', () => {
      const c = new LruDecisionCache({ maxEntries: 2 });
      c.set('a', decision('a.x'), [], 1000);
      c.set('b', decision('b.x'), [], 1000);
      c.set('a', decision('a.y'), [], 1000);
      c.set('c', decision('c.x'), [], 1000);
      expect(c.get('b')).to.equal(undefined);
      expect(c.get('a')!.permission).to.equal('a.y');
    });

    it('works with maxEntries 1', () => {
      const c = new LruDecisionCache({ maxEntries: 1 });
      c.set('a', decision('a.x'), ['t'], 1000);
      c.set('b', decision('b.x'), ['t'], 1000);
      expect(c.get('a')).to.equal(undefined);
      expect(c.get('b')!.permission).to.equal('b.x');
      expect(c.size).to.equal(1);
    });

    for (const bad of [0, -1, 1.5, NaN, Infinity, '10' as unknown as number]) {
      it(`rejects maxEntries ${JSON.stringify(bad) ?? String(bad)}`, () => {
        expect(() => new LruDecisionCache({ maxEntries: bad })).to.throw(AuthzConfigError);
      });
    }
  });

  describe('tags', () => {
    it('invalidates by one tag', () => {
      const c = new LruDecisionCache();
      c.set('a', decision('a.x'), ['*', 'model:rbac'], 1000);
      c.set('b', decision('b.x'), ['*', 'model:abac'], 1000);
      c.invalidate(['model:rbac']);
      expect(c.get('a')).to.equal(undefined);
      expect(c.get('b')).to.not.equal(undefined);
    });

    it('invalidates by several tags', () => {
      const c = new LruDecisionCache();
      c.set('a', decision('a.x'), ['x'], 1000);
      c.set('b', decision('b.x'), ['y'], 1000);
      c.set('c', decision('c.x'), ['z'], 1000);
      c.invalidate(['x', 'y', 'unknown']);
      expect(c.get('a')).to.equal(undefined);
      expect(c.get('b')).to.equal(undefined);
      expect(c.get('c')).to.not.equal(undefined);
    });

    it('treats * as an ordinary tag', () => {
      const c = new LruDecisionCache();
      c.set('a', decision('a.x'), ['*', 'x'], 1000);
      c.set('b', decision('b.x'), ['*'], 1000);
      c.set('c', decision('c.x'), ['y'], 1000);
      c.invalidate(['*']);
      expect(c.size).to.equal(1);
      expect(c.get('c')).to.not.equal(undefined);
    });

    it('invalidate([]) does nothing', () => {
      const c = new LruDecisionCache();
      c.set('a', decision('a.x'), ['*'], 1000);
      c.invalidate([]);
      expect(c.size).to.equal(1);
    });

    it('replacing a key replaces its tags', () => {
      const c = new LruDecisionCache();
      c.set('a', decision('a.x'), ['old'], 1000);
      c.set('a', decision('a.y'), ['new'], 1000);
      c.invalidate(['old']);
      expect(c.get('a')!.permission).to.equal('a.y');
      c.invalidate(['new']);
      expect(c.get('a')).to.equal(undefined);
    });

    it('does not keep keys of evicted entries in the tag index', () => {
      const c = new LruDecisionCache({ maxEntries: 1 });
      c.set('a', decision('a.x'), ['t'], 1000);
      c.set('b', decision('b.x'), ['u'], 1000);
      // 'a' was evicted; re-add it without 't': a stale index link would drop it
      c.set('a', decision('a.y'), ['v'], 1000);
      c.invalidate(['t']);
      expect(c.get('a')!.permission).to.equal('a.y');
      expect(c.size).to.equal(1);
    });

    it('does not keep keys of expired entries in the tag index', () => {
      const clock = new FakeClock();
      const c = new LruDecisionCache({ clock: clock.now });
      c.set('a', decision('a.x'), ['t'], 10);
      clock.advance(10);
      expect(c.get('a')).to.equal(undefined);
      c.set('a', decision('a.y'), ['v'], 1000);
      c.invalidate(['t']);
      expect(c.get('a')!.permission).to.equal('a.y');
    });

    it('does not keep keys of invalidated entries in the tag index', () => {
      const c = new LruDecisionCache();
      c.set('a', decision('a.x'), ['t', 'u'], 1000);
      c.invalidate(['t']);
      expect(c.size).to.equal(0);
      c.set('a', decision('a.y'), ['v'], 1000);
      c.invalidate(['u']);
      expect(c.get('a')!.permission).to.equal('a.y');
    });

    it('does not keep keys of entries dropped by a non-cacheable set', () => {
      const c = new LruDecisionCache();
      c.set('a', decision('a.x'), ['t'], 1000);
      c.set('a', decision('a.y'), ['t'], 0);
      c.set('a', decision('a.z'), ['v'], 1000);
      c.invalidate(['t']);
      expect(c.get('a')!.permission).to.equal('a.z');
    });

    it('does not mutate the tags array it is given', () => {
      const c = new LruDecisionCache();
      const tags = Object.freeze(['b', 'a', 'a']);
      c.set('k', decision('a.x'), tags, 1000);
      expect(tags).to.deep.equal(['b', 'a', 'a']);
    });
  });

  describe('model test', () => {
    type Op = { kind: 'set'; key: string; tags: string[]; ttl: number } | { kind: 'get'; key: string } | { kind: 'invalidate'; tags: string[] } | { kind: 'advance'; ms: number };

    const keyArb = fc.constantFrom('a', 'b', 'c', 'd', 'e');
    const tagArb = fc.constantFrom('*', 't1', 't2', 't3');
    const opArb: fc.Arbitrary<Op> = fc.oneof(fc.record({ kind: fc.constant('set' as const), key: keyArb, tags: fc.array(tagArb, { maxLength: 3 }), ttl: fc.oneof(fc.integer({ min: -5, max: 50 }), fc.constantFrom(NaN, Infinity)) }), fc.record({ kind: fc.constant('get' as const), key: keyArb }), fc.record({ kind: fc.constant('invalidate' as const), tags: fc.array(tagArb, { maxLength: 2 }) }), fc.record({ kind: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 30 }) }));

    interface RefEntry {
      key: string;
      d: Decision;
      tags: string[];
      deadline: number;
    }

    it('matches a reference model', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 4 }), fc.array(opArb, { maxLength: 60 }), (maxEntries, ops) => {
          const clock = new FakeClock();
          const c = new LruDecisionCache({ maxEntries, clock: clock.now });
          // least recent first
          let ref: RefEntry[] = [];
          let n = 0;
          for (const op of ops) {
            switch (op.kind) {
              case 'set': {
                const d = decision(`p.n${n++}`);
                c.set(op.key, d, op.tags, op.ttl);
                ref = ref.filter((e) => e.key !== op.key);
                if (Number.isFinite(op.ttl) && op.ttl > 0) {
                  ref.push({ key: op.key, d, tags: op.tags, deadline: clock.ms + op.ttl });
                  while (ref.length > maxEntries) ref.shift();
                }
                break;
              }
              case 'get': {
                const i = ref.findIndex((e) => e.key === op.key);
                let expected: Decision | undefined;
                if (i >= 0) {
                  const e = ref[i];
                  ref.splice(i, 1);
                  if (clock.ms < e.deadline) {
                    expected = e.d;
                    ref.push(e);
                  }
                }
                expect(c.get(op.key)).to.equal(expected);
                break;
              }
              case 'invalidate':
                c.invalidate(op.tags);
                ref = ref.filter((e) => !e.tags.some((t) => op.tags.includes(t)));
                break;
              case 'advance':
                clock.advance(op.ms);
                break;
            }
            expect(c.size).to.be.at.most(maxEntries);
          }
          for (const key of ['a', 'b', 'c', 'd', 'e']) {
            const e = ref.find((x) => x.key === key);
            expect(c.get(key)).to.equal(e && clock.ms < e.deadline ? e.d : undefined);
          }
        }),
        { numRuns: 300 },
      );
    });
  });
});
