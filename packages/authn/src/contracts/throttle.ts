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
   * Counts the attempt before verification and claims its slot atomically; a refused attempt is not counted (A05, A06).
   * A refusal means: verify nothing, answer as A02 with Retry-After = retryAfterSeconds.
   */
  abstract attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>;
  /** Resets the account key and removes that account's attempts from the IP key (A06). For 'reset' nothing is cleared; only time clears those keys (§22.13). */
  abstract succeed(keys: readonly ThrottleKey[], flow: ThrottleFlow): Promise<void>;
}
