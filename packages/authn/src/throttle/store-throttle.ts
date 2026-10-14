import { InvalidArgument } from '@spinajs/exceptions';
import { Throttle } from '@spinajs/util';
import type { ThrottleFlowRules, ThrottleStore } from '@spinajs/util';

import { AuthnThrottle, THROTTLE_FLOWS } from '../contracts/throttle.js';
import type { BackoffParams, ThrottleFlow, ThrottleKey, ThrottleParams } from '../contracts/throttle.js';
import type { AuthnContext } from '../contracts/credentials.js';
import type { PeekableThrottle } from './peek.js';

type Verdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * An `AuthnThrottle` over a util `Throttle`: the flow rules come from `ThrottleParams` and are the same for every store;
 * a subclass supplies the params, the `ThrottleStore` and the key ids. Side-effect free, also as
 * `@spinajs/authn/store-throttle`.
 */
export abstract class StoreAuthnThrottle extends AuthnThrottle implements PeekableThrottle {
  /** Read once by the first attempt, peek or succeed. */
  protected abstract readonly params: ThrottleParams;

  private throttle: Promise<Throttle> | undefined;

  /** Built lazily, once. */
  protected abstract store(): Promise<ThrottleStore>;

  /** Stores keep this id, never the plain key value (SR-19). */
  protected abstract keyId(flow: ThrottleFlow, key: ThrottleKey): string;

  public async attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext): Promise<Verdict> {
    const nowMs = this.nowMs(ctx, 'attempt');
    return (await this.throttled()).attempt(keys, flow, nowMs);
  }

  /** Refuses as `attempt` would for a delay, counting nothing. */
  public async peek(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext): Promise<Verdict> {
    const nowMs = this.nowMs(ctx, 'peek');
    return (await this.throttled()).peek(keys, flow, nowMs);
  }

  public async succeed(keys: readonly ThrottleKey[], flow: ThrottleFlow): Promise<void> {
    await (await this.throttled()).succeed(keys, flow, Date.now());
  }

  /**
   * login, mfa and reauth: account, ip and global gate; account-ip counts, and a success takes its attempts off the ip
   * row (D8) and clears account and account-ip. reset: the same gates and counts; a success clears nothing (§22.13).
   */
  protected rules(params: ThrottleParams): Record<ThrottleFlow, ThrottleFlowRules> {
    const rules = {} as Record<ThrottleFlow, ThrottleFlowRules>;
    for (const flow of THROTTLE_FLOWS) {
      const { account, ip } = params[flow];
      const gates: Record<string, BackoffParams> = {};
      if (account) gates.account = account;
      if (ip) gates.ip = ip;
      if (params.global) gates.global = params.global;
      const onSuccess = { ...(ip ? { lower: [{ kind: 'ip', by: 'account-ip' }] } : {}), clear: ['account', 'account-ip'] };
      rules[flow] = { gates, ...(ip ? { counted: ['account-ip'] } : {}), ...(flow === 'reset' ? {} : { onSuccess }) };
    }
    return rules;
  }

  // A failed build is not kept: a store that could not start now may start on the next call.
  private throttled(): Promise<Throttle> {
    this.throttle ??= this.build().catch((e: unknown) => {
      this.throttle = undefined;
      throw e;
    });
    return this.throttle;
  }

  private async build(): Promise<Throttle> {
    const flows = this.rules(this.params);
    const store = await this.store();
    return new Throttle({ flows, store, keyId: (flow, key) => this.keyId(flow as ThrottleFlow, key) });
  }

  private nowMs(ctx: AuthnContext, method: string): number {
    const nowMs = ctx?.now instanceof Date ? ctx.now.getTime() : NaN;
    if (!Number.isFinite(nowMs)) throw new InvalidArgument(`${this.constructor.name}.${method}: ctx.now must be a valid Date`);
    return nowMs;
  }
}
