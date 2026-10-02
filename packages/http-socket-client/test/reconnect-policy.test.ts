import 'mocha';
import { expect } from 'chai';
import { DEFAULT_RECONNECT, ReconnectPolicy } from '../src/reconnect.js';

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

  it('rejects invalid options', () => {
    expect(() => new ReconnectPolicy({ minMs: -1 })).to.throw(RangeError);
    expect(() => new ReconnectPolicy({ minMs: 100, maxMs: 50 })).to.throw(RangeError);
    expect(() => new ReconnectPolicy({ jitter: 1.5 })).to.throw(RangeError);
  });
});
