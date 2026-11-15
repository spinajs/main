import { expect } from 'chai';
import { computeBackoff, isRetryable, NonRetryableError, NormalizedRetry } from '../src/index.js';

const fixed: NormalizedRetry = { attempts: 3, backoff: 'fixed', delayMs: 60_000, maxDelayMs: 3_600_000 };
const expo: NormalizedRetry = { attempts: 5, backoff: 'exponential', delayMs: 60_000, maxDelayMs: 1_800_000 };
const mid = () => 0.5;

describe('retry backoff', () => {
  it('computes fixed and exponential backoff with bounded jitter', () => {
    expect(computeBackoff(fixed, 3)).to.eq(60_000);
    expect(computeBackoff(expo, 1, mid)).to.eq(60_000);
    expect(computeBackoff(expo, 3, mid)).to.eq(240_000);
    expect(computeBackoff(expo, 1, () => 0)).to.eq(54_000);
    expect(computeBackoff(expo, 1, () => 1)).to.eq(66_000);
    expect(computeBackoff(expo, 10, () => 1)).to.eq(1_800_000);
  });

  it('honours NonRetryableError and retryOn', () => {
    expect(isRetryable(fixed, new Error('x'))).to.eq(true);
    expect(isRetryable(fixed, new NonRetryableError('x'))).to.eq(false);
    expect(isRetryable({ ...fixed, retryOn: (e) => (e as Error).message !== 'fatal' }, new Error('fatal'))).to.eq(false);
    const throwing = () => {
      throw new Error('bug');
    };
    expect(isRetryable({ ...fixed, retryOn: throwing }, new Error('x'))).to.eq(false);
  });

  it('keeps the inner error of a NonRetryableError', () => {
    const inner = new Error('cause');
    const err = new NonRetryableError('no', inner);
    expect(err).to.include({ name: 'NonRetryableError', message: 'no', inner });
  });
});
