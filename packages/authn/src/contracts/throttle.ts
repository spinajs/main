import type { AuthnContext } from './credentials.js';

export interface ThrottleKey {
  readonly kind: 'ip' | 'account' | 'account-ip' | 'global' | (string & {});
  /** The caller passes the plain value; stores keep a keyed hash of it, since logins are personal data (SR-19). */
  readonly value: string;
}

export type ThrottleFlow = 'login' | 'mfa' | 'reset' | 'reauth';

/** Backoff, never a lock (H31). MemoryAuthnThrottle (core), DbAuthnThrottle (authn-orm). */
export abstract class AuthnThrottle {
  /**
   * Counts the attempt and claims its slot atomically: before verification for interactive strategies, after a failure for
   * per-request ones (K5); a refused attempt is not counted (A05, A06).
   * A refusal means: verify nothing, answer as A02 with Retry-After = retryAfterSeconds.
   */
  abstract attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>;
  /** Resets the account key and removes that account's attempts from the IP key (A06). For 'reset' nothing is cleared; only time clears those keys (§22.13). */
  abstract succeed(keys: readonly ThrottleKey[], flow: ThrottleFlow): Promise<void>;
  /** Optional; the authn service calls it at boot with its configuration, so a throttle that cannot run on it fails the boot. */
  checkConfiguration?(configuration: { get<T>(path: string | string[]): T }): void | Promise<void>;
}

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

export const THROTTLE_FLOWS: readonly ThrottleFlow[] = Object.freeze(['login', 'mfa', 'reset', 'reauth']);

const backoff = (free: number, baseDelayMs: number, maxDelayMs: number): BackoffParams => Object.freeze({ free, baseDelayMs, maxDelayMs });

/** Design §22.5 `authn.throttle`; the schema defaults equal it (test/boot/config-defaults.test.ts). */
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
