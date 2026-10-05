import type { ThrottleFlow } from '../contracts/throttle.js';

export interface BackoffParams {
  readonly free: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/** A key kind without params does not gate in that flow. */
export interface ThrottleFlowParams {
  readonly account?: BackoffParams;
  readonly ip?: BackoffParams;
}

export interface ThrottleParams {
  readonly login: ThrottleFlowParams;
  readonly mfa: ThrottleFlowParams;
  readonly reset: ThrottleFlowParams;
  readonly reauth: ThrottleFlowParams;
  readonly resetAfterSeconds: number;
  /** Off (null) unless configured: one attacker could slow every login. */
  readonly global?: BackoffParams | null;
}

/** `authn.throttle` as the schema delivers it: the limits, plus the service name and the row cap. */
export type ThrottleConfig = ThrottleParams & { readonly service?: string; readonly maxRows?: number };

export const THROTTLE_FLOWS: readonly ThrottleFlow[] = Object.freeze(['login', 'mfa', 'reset', 'reauth']);

const backoff = (free: number, baseDelayMs: number, maxDelayMs: number): BackoffParams => Object.freeze({ free, baseDelayMs, maxDelayMs });

// Same values as the schema defaults (test/boot/config-defaults.test.ts); for tests and callers of explicit params.
export const DEFAULT_THROTTLE_PARAMS: ThrottleParams = Object.freeze({
  login: Object.freeze({ account: backoff(5, 1000, 60000), ip: backoff(20, 1000, 300000) }),
  mfa: Object.freeze({ account: backoff(3, 1000, 300000), ip: backoff(20, 1000, 300000) }),
  reset: Object.freeze({ account: backoff(1, 60000, 3600000), ip: backoff(5, 10000, 900000) }),
  reauth: Object.freeze({ account: backoff(3, 1000, 300000) }),
  resetAfterSeconds: 86400,
  global: null,
});

/** The wait after counted attempt n (1-based): 0 until n reaches free, then min(baseDelayMs × 2^(n − free), maxDelayMs). */
export function backoffDelayMs(p: BackoffParams, n: number): number {
  return n < p.free ? 0 : Math.min(p.baseDelayMs * 2 ** (n - p.free), p.maxDelayMs);
}

// Same values as the schema defaults (test/boot/config-defaults.test.ts); the fallback of explicit params.
export const DEFAULT_THROTTLE_MAX_ROWS = 1_000_000;
