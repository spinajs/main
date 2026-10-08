import type { AuthnContext } from '../contracts/credentials.js';
import type { AuthnThrottle, ThrottleFlow, ThrottleKey } from '../contracts/throttle.js';

/**
 * A throttle that tells whether a backoff delay holds any of the keys now, counting nothing. With one,
 * `DefaultAuthnService` counts only the failures of per-request strategies (K5): it peeks before verify and calls
 * `attempt` after a failure, so parallel requests with valid credentials never add up in the throttle.
 *
 * The peek and the later count are not one step: a parallel burst is verified in full and adds one backoff step,
 * not one per request. That is safe only for credentials nobody can guess (tokens of 128 bits or more, asymmetric
 * signatures); a non-interactive strategy over a weak secret must not rely on this throttle.
 */
export interface PeekableThrottle {
  peek(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>;
}

export const canPeek = (t: AuthnThrottle): t is AuthnThrottle & PeekableThrottle => typeof (t as Partial<PeekableThrottle>).peek === 'function';
