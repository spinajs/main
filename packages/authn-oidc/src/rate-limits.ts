import type * as express from 'express';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { configuredRateLimit, Response } from '@spinajs/http';
import type { RateLimit, ResponseFunction } from '@spinajs/http';
import { appEnvOf } from '@spinajs/authn-session';

import { isNavigation, oidcFailure } from './login.js';
import type { OidcAnswer } from './login.js';
import { OidcResponse } from './oidc-response.js';
import { AUTHN_OIDC_RATE_LIMITS, AUTHN_OIDC_SESSION_RATE_LIMITS } from './options/schema.js';
import { OidcProviders } from './providers.js';

export type AuthnOidcRateLimitName = keyof typeof AUTHN_OIDC_RATE_LIMITS;

/**
 * A rate-limited begin or callback gets the one failure answer of the OIDC routes (D3) with Retry-After, as a
 * throttled login at the callback does. Whether the request is a navigation is known only once it is answered.
 */
export class OidcThrottledResponse extends Response {
  constructor(public readonly retryAfterSeconds: number) {
    super(null);
  }

  /**
   * The failure path and the env come from the validated OidcProviders the controller uses, else the configuration.
   * Both are read from the root container, as the base Response reads http.AcceptHeaders: an answer given by a
   * middleware has no container of its own.
   */
  public answerFor(
    req: { get(name: string): string | undefined },
    providers: Pick<OidcProviders, 'options' | 'env'> | null | undefined = DI.get(OidcProviders),
    config: Configuration | null | undefined = DI.get(Configuration),
  ): OidcAnswer {
    const validated = providers?.options?.redirects.failure;
    const failurePath = validated ?? config?.get<string>('authn.oidc.redirects.failure') ?? '/';
    const env = validated !== undefined ? providers!.env : config ? appEnvOf(config) : undefined;
    return oidcFailure(isNavigation(req.get('sec-fetch-mode'), req.get('accept')), failurePath, env, this.retryAfterSeconds);
  }

  public async execute(req: express.Request, res: express.Response): Promise<ResponseFunction | void> {
    return new OidcResponse(this.answerFor(req)).execute(req, res);
  }
}

export const oidcThrottled = (retryAfterSeconds: number): OidcThrottledResponse => new OidcThrottledResponse(retryAfterSeconds);

const anonymousRouteLimit = configuredRateLimit('authn.oidc.rateLimit', AUTHN_OIDC_RATE_LIMITS, { headers: false });
const sessionRouteLimit = configuredRateLimit('authn.oidc.rateLimit', AUTHN_OIDC_SESSION_RATE_LIMITS, { headers: false });

/** The shipped `@RateLimit` of an anonymous OIDC route: the route's failure answer and no `X-RateLimit-*` header. */
export function OidcRateLimit(name: AuthnOidcRateLimitName): ReturnType<typeof RateLimit> {
  return anonymousRouteLimit(name, { answer: oidcThrottled });
}

export type AuthnOidcSessionRateLimitName = keyof typeof AUTHN_OIDC_SESSION_RATE_LIMITS;

/** The shipped `@RateLimit` of an OIDC route with a session, per principal; refused as begin and callback are. */
export function OidcSessionRateLimit(name: AuthnOidcSessionRateLimitName): ReturnType<typeof RateLimit> {
  return sessionRouteLimit(name, { answer: oidcThrottled });
}
