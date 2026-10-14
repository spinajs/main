import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import { KeyedBackoff, backoffDelayMs } from '../src/index.js';
import type { BackoffParams, KeyedBackoffGate, KeyedBackoffOptions } from '../src/index.js';

const P: BackoffParams = { free: 5, baseDelayMs: 1000, maxDelayMs: 60_000 };
const LONG: BackoffParams = { free: 1, baseDelayMs: 600_000, maxDelayMs: 600_000 };
const DAY = 86_400_000;

const gate = (key: string, backoff: BackoffParams = P): KeyedBackoffGate => ({ key, backoff });

const make = (o: Partial<KeyedBackoffOptions> = {}): KeyedBackoff => new KeyedBackoff({ maxRows: 1000, resetAfterMs: DAY, ...o });

const keys = (t: KeyedBackoff): string[] => [...t.entries()].map(([k]) => k);

function expectRefused(v: { allowed: boolean; retryAfterSeconds?: number }, seconds: number, why = ''): void {
  expect(v.allowed, `refused ${why}`).to.equal(false);
  expect(v.retryAfterSeconds, `Retry-After ${why}`).to.equal(seconds);
}

describe('backoffDelayMs', () => {
  it('is 0 below free, then doubles from baseDelayMs up to maxDelayMs', () => {
    const seq = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => backoffDelayMs(P, n));
    expect(seq).to.deep.equal([0, 0, 0, 0, 1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);
  });
});

describe('KeyedBackoff', () => {
  describe('backoff and decay', () => {
    it('follows the delay sequence and counts only allowed attempts', () => {
      const t = make();
      let now = 0;
      for (let i = 0; i < 5; i++) expect(t.attempt([gate('a')], [], now).allowed).to.equal(true);
      expectRefused(t.attempt([gate('a')], [], now + 500), 1, 'inside the first delay');
      expect(t.row('a')?.attempts).to.equal(5);
      now += 1000;
      expect(t.attempt([gate('a')], [], now).allowed).to.equal(true);
      expectRefused(t.attempt([gate('a')], [], now), 2);
    });

    it('answers Retry-After rounded up, at least 1 s', () => {
      const t = make();
      for (let i = 0; i < 5; i++) t.attempt([gate('a', { free: 1, baseDelayMs: 1500, maxDelayMs: 1500 })], [], 0);
      expectRefused(t.attempt([gate('a')], [], 1), 2);
      expectRefused(t.attempt([gate('a')], [], 1499), 1);
    });

    it('a key idle for resetAfterMs starts from zero', () => {
      const t = make({ resetAfterMs: 60_000 });
      for (let i = 0; i < 5; i++) t.attempt([gate('a')], [], 0);
      t.attempt([gate('a')], [], 59_999);
      expect(t.row('a')?.attempts).to.equal(6);
      t.attempt([gate('a')], [], 119_998);
      expect(t.row('a')?.attempts).to.equal(7);
      t.attempt([gate('a')], [], 180_000);
      expect(t.row('a')?.attempts).to.equal(1);
    });

    it('a row whose delay outlasts resetAfterMs keeps delaying until it ends', () => {
      const t = make({ resetAfterMs: 1000 });
      t.attempt([gate('a', LONG)], [], 0);
      expectRefused(t.attempt([gate('a', LONG)], [], 5000), 595);
      expect(t.attempt([gate('a', LONG)], [], 600_000).allowed).to.equal(true);
      expect(t.row('a')?.attempts).to.equal(1);
    });

    it('stamps a new run on a decayed key', () => {
      const t = make({ resetAfterMs: 1000 });
      t.attempt([gate('a')], [], 0);
      const first = t.row('a')!.run;
      t.attempt([gate('a')], [], 2000);
      expect(t.row('a')!.run).to.be.greaterThan(first);
    });

    it('takes the delay from the delay option', () => {
      const t = make({ delay: (_p: BackoffParams, n: number) => n * 100 });
      t.attempt([gate('a')], [], 0);
      t.attempt([gate('a')], [], 1000);
      expect(t.row('a')?.nextMs).to.equal(1200);
    });
  });

  describe('gates and counted keys', () => {
    it('refuses with the longest running delay among several gates', () => {
      const t = make();
      t.attempt([gate('short', { free: 1, baseDelayMs: 2000, maxDelayMs: 2000 })], [], 0);
      t.attempt([gate('long', { free: 1, baseDelayMs: 9000, maxDelayMs: 9000 })], [], 0);
      expectRefused(t.attempt([gate('short'), gate('long'), gate('fresh')], [], 1000), 8);
    });

    it('a refused attempt counts nothing, not even counted keys', () => {
      const t = make();
      t.attempt([gate('a', LONG)], [], 0);
      expectRefused(t.attempt([gate('a', LONG), gate('b')], ['book'], 1000), 599);
      expect(keys(t)).to.deep.equal(['a']);
      expect(t.row('a')?.attempts).to.equal(1);
    });

    it('counts a counted key without gating it, and it keeps an infinite free', () => {
      const t = make();
      for (let i = 0; i < 50; i++) expect(t.attempt([], ['book'], 0).allowed).to.equal(true);
      expect(t.row('book')).to.include({ attempts: 50, free: Infinity, nextMs: 0 });
    });

    it('counts a key listed twice, or both gated and counted, once', () => {
      const t = make();
      t.attempt([gate('a'), gate('a')], ['a', 'b', 'b'], 0);
      expect(t.row('a')?.attempts).to.equal(1);
      expect(t.row('b')?.attempts).to.equal(1);
      expect(t.size).to.equal(2);
    });

    it('records the free of the gate on the row', () => {
      const t = make();
      t.attempt([gate('a')], [], 0);
      expect(t.row('a')?.free).to.equal(5);
    });
  });

  describe('peek', () => {
    it('refuses while a delay holds and counts nothing', () => {
      const t = make();
      t.attempt([gate('a', LONG)], [], 0);
      expectRefused(t.peek([gate('a', LONG), gate('x')], 1000), 599);
      expect(t.peek([gate('x')], 1000).allowed).to.equal(true);
      expect(keys(t)).to.deep.equal(['a']);
      expect(t.row('a')?.attempts).to.equal(1);
    });

    it('lets a fresh key through a full table, which only attempt refuses', () => {
      const t = make({ maxRows: 2 });
      t.attempt([gate('a', LONG), gate('b', LONG)], [], 0);
      expectRefused(t.attempt([gate('c', LONG)], [], 1000), 599);
      expect(t.peek([gate('c', LONG)], 1000).allowed).to.equal(true);
    });
  });

  describe('sweep and row', () => {
    it('sweeps idle rows with each attempt and keeps memory bounded', () => {
      const t = make({ maxRows: 100_000 });
      for (let i = 0; i < 1000; i++) t.attempt([], [`k${i}`, `l${i}`, `m${i}`], 0);
      expect(t.size).to.equal(3000);
      for (let i = 0; i < 10_000; i++) t.attempt([], ['keep'], DAY);
      expect(t.size).to.be.at.most(1);
    });

    it('sweep(nowMs, batch) checks at most batch rows and resumes where it stopped', () => {
      const t = make({ resetAfterMs: 1000 });
      for (let i = 0; i < 4; i++) t.attempt([gate(`held${i}`, LONG)], [], 0);
      for (let i = 0; i < 8; i++) t.attempt([], [`k${i}`], 0);
      // Nothing is stale at 0: this pass only ends wherever the attempts left the cursor.
      t.sweep(0, 100);
      t.sweep(5000, 4);
      expect(t.size, 'the first batch reaches only the delaying rows').to.equal(12);
      t.sweep(5000, 4);
      expect(t.size, 'the second batch resumes past them').to.equal(8);
      t.sweep(5000, 4);
      expect(t.size).to.equal(4);
    });

    it('sweep(nowMs, 0) checks nothing', () => {
      const t = make({ resetAfterMs: 1000 });
      t.attempt([], ['k'], 0);
      t.sweep(5000, 0);
      expect(t.size).to.equal(1);
    });

    it('never sweeps a row that still delays someone', () => {
      const t = make({ resetAfterMs: 1000 });
      t.attempt([gate('held', LONG)], [], 0);
      for (let i = 0; i < 100; i++) t.attempt([], ['other'], 2000);
      expectRefused(t.attempt([gate('held', LONG)], [], 2000), 598);
    });

    it('row(key, nowMs) expires a stale row, row(key) does not', () => {
      const t = make({ resetAfterMs: 1000 });
      t.attempt([gate('a')], [], 0);
      expect(t.row('a')).to.not.equal(undefined);
      expect(t.row('a', 999)).to.not.equal(undefined);
      expect(t.row('a', 1000)).to.equal(undefined);
      expect(t.size).to.equal(0);
    });

    it('delete removes a row and reports whether there was one', () => {
      const t = make();
      t.attempt([], ['a'], 0);
      expect(t.delete('a')).to.equal(true);
      expect(t.delete('a')).to.equal(false);
      expect(t.size).to.equal(0);
    });

    it('re-inserts a counted row, so entries() lists the oldest last attempt first', () => {
      const t = make();
      t.attempt([], ['a'], 0);
      t.attempt([], ['b'], 1);
      t.attempt([], ['a'], 2);
      expect(keys(t)).to.deep.equal(['b', 'a']);
    });
  });

  describe('capacity', () => {
    it('drops expired rows when full, oldest first', () => {
      const t = make({ maxRows: 9, resetAfterMs: 60_000, sweepBatch: 1 });
      for (const u of ['a', 'b', 'c']) t.attempt([gate(`${u}1`), gate(`${u}2`)], [`${u}3`], 0);
      expect(t.size).to.equal(9);
      expect(t.attempt([gate('d1'), gate('d2')], ['d3'], 61_000).allowed).to.equal(true);
      expect(t.size).to.equal(9);
      expect(keys(t)).to.include.members(['d1', 'd2', 'd3']);
      expect(keys(t)).to.not.include.members(['a1', 'a2', 'a3']);
    });

    it('then evicts rows that delay nobody, oldest last attempt first', () => {
      const t = make({ maxRows: 9, sweepBatch: 1 });
      const set = (u: string): [KeyedBackoffGate[], string[]] => [[gate(`${u}1`), gate(`${u}2`)], [`${u}3`]];
      let now = 0;
      for (const u of ['a', 'b', 'c', 'a']) {
        t.attempt(...set(u), now);
        now += 1000;
      }
      expect(t.attempt(...set('d'), now).allowed).to.equal(true);
      expect(t.size).to.equal(9);
      expect(keys(t)).to.not.include.members(['b1', 'b2', 'b3']);
      expect(keys(t)).to.include.members(['a1', 'a2', 'a3', 'c1', 'c2', 'c3', 'd1', 'd2', 'd3']);
    });

    it('evicts rows below free before a deeper row', () => {
      const t = make({ maxRows: 30, sweepBatch: 1 });
      let now = 0;
      for (let i = 0; i < 6; i++) {
        t.attempt([gate('victim')], [], now);
        now += 2 ** Math.max(0, i - 4) * 1000;
      }
      now += 2000;
      for (let i = 0; i < 100; i++) expect(t.attempt([gate(`f${i}a`), gate(`f${i}b`, { ...P, free: 3 })], [], now).allowed).to.equal(true);
      expect(t.row('victim')?.attempts).to.equal(6);
    });

    it('never evicts a row that delays someone', () => {
      const t = make({ maxRows: 4, sweepBatch: 1 });
      t.attempt([gate('held', LONG)], [], 0);
      for (const [i, v] of ['b', 'c', 'd'].entries()) t.attempt([], [v], 1000 * (i + 1));
      expect(t.attempt([], ['e'], 4000).allowed).to.equal(true);
      expect(keys(t)).to.not.include('b');
      expect(keys(t)).to.include('held');
      expectRefused(t.attempt([gate('held', LONG)], [], 5000), 595);
    });

    it('refuses when every row delays someone, counts nothing and reports once', () => {
      let full = 0;
      const t = make({ maxRows: 4, sweepBatch: 1, onFull: () => full++ });
      for (const v of ['a1', 'a2', 'a3', 'a4']) expect(t.attempt([gate(v, LONG)], [], 0).allowed).to.equal(true);
      expectRefused(t.attempt([gate('a5', LONG)], [], 1000), 599);
      expectRefused(t.attempt([gate('a6', LONG)], [], 2000), 598);
      expect(t.row('a5')).to.equal(undefined);
      expect(t.size).to.equal(4);
      expect(full).to.equal(1);
      expect(t.attempt([gate('a5', LONG)], [], 600_000).allowed).to.equal(true);
    });

    it('swallows a throw in onFull, still refuses, and calls it again on the next scan', () => {
      let calls = 0;
      const t = make({
        maxRows: 4,
        sweepBatch: 1,
        onFull: () => {
          calls++;
          throw new Error('no log');
        },
      });
      for (const v of ['a1', 'a2', 'a3', 'a4']) t.attempt([gate(v, LONG)], [], 0);
      expectRefused(t.attempt([gate('a5', LONG)], [], 1000), 599);
      expect(calls).to.equal(1);
      expect(t.row('a5')).to.equal(undefined);
      t.release();
      expectRefused(t.attempt([gate('a5', LONG)], [], 2000), 598);
      expect(calls).to.equal(2);
    });

    it('reports again for a new full episode', () => {
      let full = 0;
      const t = make({ maxRows: 2, sweepBatch: 1, onFull: () => full++ });
      t.attempt([gate('a', LONG), gate('b', LONG)], [], 0);
      t.attempt([gate('c', LONG)], [], 1000);
      expect(full).to.equal(1);
      expect(t.attempt([gate('d', LONG)], [], 600_000).allowed).to.equal(true);
      expect(t.attempt([gate('e', LONG)], [], 600_001).allowed).to.equal(true);
      t.attempt([gate('f', LONG)], [], 600_002);
      expect(full).to.equal(2);
    });

    it('release clears the hold-off, so the next attempt scans again', () => {
      const t = make({ maxRows: 1000 });
      for (let i = 0; i < 995; i++) t.attempt([gate(`held${i}`, LONG)], [], 0);
      for (let i = 0; i < 5; i++) t.attempt([], [`idle${i}`], 0);
      for (let i = 0; i < 5; i++) t.attempt([gate(`new${i}`, LONG)], [], 0);
      expectRefused(t.attempt([gate('new5', LONG)], [], 0), 1, 'held off');
      t.release();
      expectRefused(t.attempt([gate('new5', LONG)], [], 0), 600, 'rescanned');
    });

    it('refuses for fullRetryMs when nothing delays and nothing can be evicted', () => {
      const t = make({ maxRows: 2, fullRetryMs: 30_000 });
      // Rows below free are evictable, so the table is only unevictable through delays; a needed count above maxRows is the other case.
      expectRefused(t.attempt([], ['a', 'b', 'c'], 0), 30, 'three new rows cannot fit in two');
      expect(t.size).to.equal(0);
    });

    it('holds off a rescan when eviction frees less than the slack', () => {
      const t = make({ maxRows: 1000 });
      for (let i = 0; i < 995; i++) t.attempt([gate(`held${i}`, LONG)], [], 0);
      for (let i = 0; i < 5; i++) t.attempt([], [`idle${i}`], 0);
      for (let i = 0; i < 5; i++) expect(t.attempt([gate(`new${i}`, LONG)], [], 0).allowed, `new ${i + 1}`).to.equal(true);
      expectRefused(t.attempt([gate('new5', LONG)], [], 0), 1, 'refused without a rescan');
      expectRefused(t.attempt([gate('new6', LONG)], [], 1000), 599, 'after the hold-off every row still delays');
    });

    it('uses holdOffMs for the hold-off', () => {
      const t = make({ maxRows: 1000, holdOffMs: 5000 });
      for (let i = 0; i < 995; i++) t.attempt([gate(`held${i}`, LONG)], [], 0);
      for (let i = 0; i < 5; i++) t.attempt([], [`idle${i}`], 0);
      for (let i = 0; i < 5; i++) t.attempt([gate(`new${i}`, LONG)], [], 0);
      expectRefused(t.attempt([gate('new5', LONG)], [], 4000), 1);
      expectRefused(t.attempt([gate('new6', LONG)], [], 5000), 595);
    });
  });

  describe('invalid input', () => {
    const bad: [string, Partial<KeyedBackoffOptions>][] = [
      ['maxRows 0', { maxRows: 0 }],
      ['maxRows 1.5', { maxRows: 1.5 }],
      ['maxRows NaN', { maxRows: NaN }],
      ['resetAfterMs 0', { resetAfterMs: 0 }],
      ['resetAfterMs -1', { resetAfterMs: -1 }],
      ['resetAfterMs NaN', { resetAfterMs: NaN }],
      ['sweepBatch 0', { sweepBatch: 0 }],
      ['sweepBatch 2.5', { sweepBatch: 2.5 }],
      ['fullRetryMs 0', { fullRetryMs: 0 }],
      ['holdOffMs -1', { holdOffMs: -1 }],
    ];
    for (const [what, o] of bad) {
      it(`rejects ${what}`, () => {
        expect(() => make(o)).to.throw(InvalidArgument);
      });
    }

    it('accepts holdOffMs 0', () => {
      expect(() => make({ holdOffMs: 0 })).to.not.throw();
    });

    it('rejects a sweep batch that is not an integer >= 0', () => {
      const t = make();
      for (const batch of [-1, 1.5, NaN, Infinity]) expect(() => t.sweep(0, batch), `batch ${batch}`).to.throw(InvalidArgument);
    });

    it('rejects a non-finite nowMs everywhere', () => {
      const t = make();
      expect(() => t.attempt([], ['a'], NaN)).to.throw(InvalidArgument);
      expect(() => t.attempt([], ['a'], Infinity)).to.throw(InvalidArgument);
      expect(() => t.peek([gate('a')], NaN)).to.throw(InvalidArgument);
      expect(() => t.sweep(NaN)).to.throw(InvalidArgument);
      expect(() => t.row('a', NaN)).to.throw(InvalidArgument);
      expect(t.size).to.equal(0);
    });
  });
});
