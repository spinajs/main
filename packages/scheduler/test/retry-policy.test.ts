import { expect } from 'chai';
import {
  computeBackoff,
  decideAfterFailure,
  isRetryable,
  NonRetryableError,
  NormalizedRetry,
  RunAbortedError,
} from '../src/index.js';

const fixed: NormalizedRetry = { attempts: 3, backoff: 'fixed', delayMs: 60_000, maxDelayMs: 3_600_000 };
const expo: NormalizedRetry = { attempts: 5, backoff: 'exponential', delayMs: 60_000, maxDelayMs: 1_800_000 };
const mid = () => 0.5;

describe('retry policy', () => {
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
    expect(
      isRetryable(
        {
          ...fixed,
          retryOn: () => {
            throw new Error('bug');
          },
        },
        new Error('x'),
      ),
    ).to.eq(false);
  });

  it('decides retrying, dead, failed and aborted', () => {
    const err = new Error('boom');
    expect(decideAfterFailure({ emit: false, attempt: 1, error: err })).to.deep.eq({ status: 'failed', countsAsFailure: true });
    expect(decideAfterFailure({ retry: fixed, emit: false, attempt: 1, error: err })).to.deep.eq({
      status: 'retrying',
      delayMs: 60_000,
      countsAsFailure: false,
    });
    expect(decideAfterFailure({ retry: fixed, emit: false, attempt: 3, error: err })).to.deep.eq({
      status: 'dead',
      countsAsFailure: true,
    });
    expect(
      decideAfterFailure({ retry: fixed, emit: false, attempt: 1, error: new NonRetryableError('no') }),
    ).to.deep.eq({ status: 'failed', countsAsFailure: true });
    expect(decideAfterFailure({ retry: fixed, emit: true, attempt: 1, error: err })).to.deep.eq({
      status: 'failed',
      countsAsFailure: true,
    });
    expect(
      decideAfterFailure({
        retry: fixed,
        emit: false,
        attempt: 1,
        error: new RunAbortedError('cancelled'),
        abortReason: 'cancelled',
      }),
    ).to.deep.eq({ status: 'aborted', countsAsFailure: false });
    expect(
      decideAfterFailure({
        retry: fixed,
        emit: false,
        attempt: 1,
        error: new RunAbortedError('shutdown'),
        abortReason: 'shutdown',
      }).status,
    ).to.eq('retrying');
    expect(
      decideAfterFailure({ emit: false, attempt: 1, error: new RunAbortedError('timeout'), abortReason: 'timeout' }),
    ).to.deep.eq({ status: 'aborted', countsAsFailure: true });
  });

  it('retries a shutdown or an expired lease even when retryOn rejects the abort', () => {
    const onlyHttp: NormalizedRetry = { ...fixed, retryOn: (e) => (e as Error).name === 'HttpError' };
    for (const reason of ['shutdown', 'lease-expired'] as const) {
      expect(
        decideAfterFailure({ retry: onlyHttp, emit: false, attempt: 1, error: new RunAbortedError(reason), abortReason: reason })
          .status,
      ).to.eq('retrying');
      expect(
        decideAfterFailure({ retry: onlyHttp, emit: false, attempt: 3, error: new RunAbortedError(reason), abortReason: reason }),
      ).to.deep.eq({ status: 'dead', countsAsFailure: true });
    }
    // a timeout is the task's own failure, so retryOn decides
    expect(
      decideAfterFailure({ retry: onlyHttp, emit: false, attempt: 1, error: new RunAbortedError('timeout'), abortReason: 'timeout' }),
    ).to.deep.eq({ status: 'aborted', countsAsFailure: true });
  });
});
