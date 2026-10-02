import { AuthnThrottle } from '@spinajs/authn/contracts';
import type { AuthnContext, ThrottleFlow, ThrottleKey } from '@spinajs/authn/contracts';

/** Scripted refusals only; the backoff reference lives in the kit's tests. */
export class RecordingThrottle extends AuthnThrottle {
  readonly attempts: { keys: readonly ThrottleKey[]; flow: ThrottleFlow; ctx: AuthnContext }[] = [];
  readonly succeeds: { keys: readonly ThrottleKey[]; flow: ThrottleFlow }[] = [];
  private readonly refusals: number[] = [];

  /** The next `times` attempts (default 1) are refused with this delay. */
  refuse(retryAfterSeconds: number, times = 1): void {
    for (let i = 0; i < times; i++) {
      this.refusals.push(retryAfterSeconds);
    }
  }

  async attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
    this.attempts.push({ keys, flow, ctx });
    const retryAfterSeconds = this.refusals.shift();
    return retryAfterSeconds === undefined ? { allowed: true } : { allowed: false, retryAfterSeconds };
  }

  async succeed(keys: readonly ThrottleKey[], flow: ThrottleFlow): Promise<void> {
    this.succeeds.push({ keys, flow });
  }
}
