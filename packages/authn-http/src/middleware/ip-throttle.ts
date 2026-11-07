import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { Autoinject, Container, NewInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Middleware, OnError, RouteMiddleware } from '@spinajs/http';
import type { IMiddlewareContext, OnErrorHandler, Request, Response } from '@spinajs/http';
import { canPeek } from '@spinajs/authn';
import { AuthnThrottle, ipKey, ipv6PrefixOf } from '@spinajs/authn/contracts';
import type { AuthnContext, ThrottleFlow, ThrottleKey } from '@spinajs/authn/contracts';

import { clientOf } from '../v3/client.js';
import { contextOf } from '../v3/context.js';
import { INVALID_INPUT } from '../validation/answers.js';

const GATE = Symbol('authnIpGate');

interface Gate {
  readonly flow: ThrottleFlow;
  readonly key: ThrottleKey;
  readonly ctx: AuthnContext;
}

/**
 * The IP throttle of an anonymous route, ahead of the bot check and of argument validation (D11(a)). `gate`: refuses
 * while the `ip` key of `flow` is held, counting nothing, since the service behind counts the requests it takes; an
 * input the route's schema refuses is counted by `IpThrottle`'s handler. `count`: counts every request, for a route
 * whose service counts none. A refused request gets the route's `answer`. The account keys stay with the services, which
 * need the validated login.
 */
@NewInstance()
export class AuthnIpThrottleMiddleware extends RouteMiddleware {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Config('authn.throttle.ipv6Prefix')
  protected Ipv6Prefix: unknown;

  @Config('http.throttle.ipv6Prefix')
  protected HttpIpv6Prefix: unknown;

  constructor(
    public readonly flow: ThrottleFlow,
    public readonly answer: ThrottledAnswer,
    public readonly mode: 'gate' | 'count' = 'gate',
  ) {
    super();
  }

  public async onBefore({ req }: IMiddlewareContext): Promise<Response | void> {
    const ctx = contextOf(clientOf(req as Request), 'request');
    const key = ipKey(ctx, ipv6PrefixOf(this.Ipv6Prefix, this.HttpIpv6Prefix)) ?? (this.mode === 'count' ? { kind: 'ip', value: 'unknown' } : null);
    // Without an address there is no ip key to gate on: the service counts what it can.
    if (!key) return;
    const gate: Gate = { flow: this.flow, key, ctx };
    const throttle = await this.Container.resolve(AuthnThrottle);
    if (this.mode === 'count') {
      const verdict = await throttle.attempt([gate.key], gate.flow, gate.ctx);
      return verdict.allowed ? undefined : this.answer(verdict.retryAfterSeconds);
    }
    (req as unknown as Record<symbol, Gate>)[GATE] = gate;
    if (!canPeek(throttle)) return;
    const verdict = await throttle.peek([gate.key], gate.flow, gate.ctx);
    if (!verdict.allowed) return this.answer(verdict.retryAfterSeconds);
  }
}

/** The route's answer to a throttled client. */
export type ThrottledAnswer = (retryAfterSeconds: number) => Response;

/** Counts an input the route's schema refused against the gate's ip key; a refused count is answered as throttled. */
function countedInvalidInput(answer: ThrottledAnswer): OnErrorHandler {
  return async (_err, ctx) => {
    const gate = (ctx.req as unknown as Record<symbol, Gate | undefined>)[GATE];
    if (!gate) return;
    const verdict = await (await ctx.container.resolve(AuthnThrottle)).attempt([gate.key], gate.flow, gate.ctx);
    return verdict.allowed ? undefined : answer(verdict.retryAfterSeconds);
  };
}

/**
 * `AuthnIpThrottleMiddleware` on a route, answering a throttled client with `answer`. Place it below `@BotCheck`, so the
 * gate runs first and a throttled client costs no verifier call, and above the route's `OnInvalidInput`, so an invalid
 * input is counted before the route answers it.
 */
export function IpThrottle(flow: ThrottleFlow, answer: ThrottledAnswer, mode: 'gate' | 'count' = 'gate') {
  const middleware = Middleware(AuthnIpThrottleMiddleware, flow, answer, mode);
  const counted = OnError(INVALID_INPUT, countedInvalidInput(answer), { stages: ['arguments'] });
  return (target: object, propertyKey?: string | symbol, descriptor?: PropertyDescriptor): void => {
    middleware(target, propertyKey, descriptor);
    counted(target, propertyKey, descriptor);
  };
}
