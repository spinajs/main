import 'mocha';
import { expect } from 'chai';
import { DEFAULT_RECONNECT, MAX_SERVER_HINT_MS, ReconnectPolicy } from '../src/reconnect.js';

const fixed = (value: number) => (): number => value;

describe('ReconnectPolicy', () => {
  it('defaults to minMs 500, maxMs 30000, jitter 0.3', () => {
    expect(DEFAULT_RECONNECT).to.deep.equal({ minMs: 500, maxMs: 30_000, jitter: 0.3 });
    expect(new ReconnectPolicy().options).to.deep.equal(DEFAULT_RECONNECT);
  });

  it('doubles from minMs and caps at maxMs', () => {
    const policy = new ReconnectPolicy({}, fixed(0));
    expect([0, 1, 2, 5, 6, 50].map((attempt) => policy.delay(attempt))).to.deep.equal([500, 1000, 2000, 16_000, 30_000, 30_000]);
  });

  it('jitter only shortens a delay, by at most the jitter fraction', () => {
    expect(new ReconnectPolicy({}, fixed(1)).delay(0)).to.equal(350);
    expect(new ReconnectPolicy({}, fixed(1)).delay(6)).to.equal(21_000);
    expect(new ReconnectPolicy({}, fixed(0.5)).delay(0)).to.equal(425);
  });

  it('treats retryAfterMs as a floor spread upwards by the jitter', () => {
    expect(new ReconnectPolicy({}, fixed(0)).delay(0, 5000)).to.equal(5000);
    expect(new ReconnectPolicy({}, fixed(1)).delay(0, 5000)).to.equal(6500);
  });

  it('keeps the exponential delay when it is longer than retryAfterMs', () => {
    expect(new ReconnectPolicy({}, fixed(0)).delay(3, 100)).to.equal(4000);
  });

  it('ignores a non-finite or non-positive hint', () => {
    const policy = new ReconnectPolicy({}, fixed(0));
    for (const hint of [NaN, Infinity, -Infinity, 0, -5]) expect(policy.delay(0, hint), String(hint)).to.equal(500);
  });

  it('caps a finite hint at MAX_SERVER_HINT_MS regardless of maxMs', () => {
    expect(MAX_SERVER_HINT_MS).to.equal(300_000);
    for (const maxMs of [100, 30_000]) {
      expect(new ReconnectPolicy({ minMs: 0, maxMs }, fixed(0)).delay(0, 1e12)).to.equal(MAX_SERVER_HINT_MS);
      expect(new ReconnectPolicy({ minMs: 0, maxMs }, fixed(1)).delay(0, 1e12)).to.equal(MAX_SERVER_HINT_MS);
    }
    expect(new ReconnectPolicy({ minMs: 0, maxMs: 100 }, fixed(0)).delay(0, 5000)).to.equal(5000);
  });

  it('never yields NaN for minMs 0 and a huge attempt', () => {
    const policy = new ReconnectPolicy({ minMs: 0, maxMs: 100 }, fixed(0.5));
    for (const attempt of [0, 1, 1023, 1024, 5000, 1e9]) expect(policy.delay(attempt), String(attempt)).to.equal(0);
    expect(new ReconnectPolicy({ minMs: 10, maxMs: 100 }, fixed(0)).delay(1e9)).to.equal(100);
  });

  it('rejects invalid options', () => {
    expect(() => new ReconnectPolicy({ minMs: -1 })).to.throw(RangeError);
    expect(() => new ReconnectPolicy({ minMs: 100, maxMs: 50 })).to.throw(RangeError);
    expect(() => new ReconnectPolicy({ jitter: 1.5 })).to.throw(RangeError);
  });
});
