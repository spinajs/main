import { createHash } from 'node:crypto';
import { parseDuration, type NormalizedRetry, type RetryPolicyOptions } from '@spinajs/durable';
import { InvalidArgument } from '@spinajs/exceptions';

export function normalizeRetry(o: RetryPolicyOptions, where: string): NormalizedRetry {
  if (!Number.isInteger(o.attempts) || o.attempts < 1) throw new InvalidArgument(`${where}: retry.attempts must be an integer >= 1`);
  const backoff = o.backoff ?? 'exponential';
  const delayMs = parseDuration(o.delay ?? '1s', `${where} retry.delay`);
  const maxDelayMs = parseDuration(o.maxDelay ?? Math.max(delayMs, 300_000), `${where} retry.maxDelay`);
  return { attempts: o.attempts, backoff, delayMs, maxDelayMs, retryOn: o.retryOn };
}

/** A number in [0, 1) derived from `seed`: replays and simulation seeds see the same value, `Math.random` would not. */
export function unitHash(seed: string): number {
  return createHash('sha256').update(seed).digest().readUInt32BE(0) / 0x1_0000_0000;
}
