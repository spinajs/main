import assert from 'node:assert/strict';
import type { AuthnContext, AuthnThrottle, ThrottleFlow, ThrottleKey } from '@spinajs/authn/contracts';
import type { FakeClock } from '../fakes/clock.js';
import type { BackoffParams } from '../harness/index.js';

/** Delay after counted attempt n (1-based): 0 when n < free, else min(baseDelayMs × 2^(n − free), maxDelayMs). */
export function backoffDelayMs(p: BackoffParams, n: number): number {
  return n < p.free ? 0 : Math.min(p.baseDelayMs * 2 ** (n - p.free), p.maxDelayMs);
}

/** Earliest offsets (ms from the first attempt) of attempts 1..count made as early as allowed. */
export function backoffSchedule(p: BackoffParams, count: number): readonly number[] {
  const out: number[] = [];
  for (let n = 1; n <= count; n++) {
    out.push(n === 1 ? 0 : out[n - 2] + backoffDelayMs(p, n - 1));
  }
  return out;
}

/** ceil(remainingMs / 1000). */
export function retryAfterSeconds(remainingMs: number): number {
  return Math.ceil(remainingMs / 1000);
}

export interface WalkOptions {
  readonly throttle: AuthnThrottle;
  readonly flow: ThrottleFlow;
  readonly params: BackoffParams;
  readonly clock: FakeClock;
  readonly attempts: number;
  readonly keysFor: (n: number) => readonly ThrottleKey[];
  readonly ctx?: (c: FakeClock) => AuthnContext;
  /** Default true: probe refusals right after an attempt and 1 ms before its slot. */
  readonly probeEarly?: boolean;
}

/**
 * Walks `attempts` counted attempts along the schedule and returns the clock time of the last one.
 * Probes are refused, so they must not be counted (A05); the walk depends on that.
 */
export async function walkBackoff(o: WalkOptions): Promise<Date> {
  const t0 = o.clock.now().getTime();
  const schedule = backoffSchedule(o.params, o.attempts);
  const ctx = o.ctx ?? ((c: FakeClock) => c.ctx());
  const at = (offset: number) => o.clock.set(new Date(t0 + offset));
  const describe = (n: number, offset: number, keys: readonly ThrottleKey[]) => `${o.flow} attempt ${n} at +${offset} ms, keys ${JSON.stringify(keys)}`;

  for (let n = 1; n <= o.attempts; n++) {
    const keys = o.keysFor(n);
    if (n > 1 && o.probeEarly !== false) {
      const d = backoffDelayMs(o.params, n - 1);
      if (d > 0) {
        at(schedule[n - 2]);
        const early = await o.throttle.attempt(keys, o.flow, ctx(o.clock));
        assert.deepEqual(early, { allowed: false, retryAfterSeconds: retryAfterSeconds(d) }, `refused right after attempt ${n - 1}, not counted (${describe(n, schedule[n - 2], keys)})`);
        if (d > 1) {
          at(schedule[n - 1] - 1);
          const late = await o.throttle.attempt(keys, o.flow, ctx(o.clock));
          assert.deepEqual(late, { allowed: false, retryAfterSeconds: 1 }, `refused 1 ms before its slot, not counted (${describe(n, schedule[n - 1] - 1, keys)})`);
        }
      }
    }
    at(schedule[n - 1]);
    const r = await o.throttle.attempt(keys, o.flow, ctx(o.clock));
    assert.deepEqual(r, { allowed: true }, `allowed at its slot (${describe(n, schedule[n - 1], keys)})`);
  }
  return new Date(t0 + schedule[o.attempts - 1]);
}
