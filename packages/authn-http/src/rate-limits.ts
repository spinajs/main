import { createHmac } from 'node:crypto';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { RateLimit } from '@spinajs/http';
import type { IMiddlewareContext, IRateLimitOptions } from '@spinajs/http';

import { AUTHN_HTTP_RATE_LIMITS, AUTHN_HTTP_SESSION_RATE_LIMITS } from './rate-limit-config.js';
import type { AuthnHttpRateLimitName, AuthnHttpSessionRateLimitName } from './rate-limit-config.js';
import type { ThrottledAnswer } from './middleware/ip-throttle.js';
import { tooManyRequests } from './password/fields.js';

// Keeps this HMAC apart from every other use of the cookie secret.
const PENDING_KEY_DOMAIN = 'spinajs.authn-http.rate-limit.pending-session\0';

/**
 * The counting key of a pending session (an MFA step in progress), or undefined (count by address): an HMAC of the
 * raw session id under `secret`, so the throttle store, possibly shared, holds neither the id nor the session store's
 * own key. Without a secret it counts by address.
 */
export function pendingSessionKeyOf(ctx: Pick<IMiddlewareContext, 'storage'>, secret: unknown): string | undefined {
  const handle = ctx.storage.AuthnSession?.handle;
  if (handle?.state !== 'pending' || typeof secret !== 'string' || secret === '') return undefined;
  return `pending:${createHmac('sha256', secret).update(PENDING_KEY_DOMAIN + handle.id).digest('hex')}`;
}

/**
 * `pendingSessionKeyOf` under `http.cookie.secret`, the secret every instance shares, so a pending session counts on
 * one key across instances. Read from the root container, as a middleware answer has no container of its own.
 */
export function pendingSessionKey(ctx: IMiddlewareContext): string | undefined {
  return pendingSessionKeyOf(ctx, DI.get(Configuration)?.get<unknown>('http.cookie.secret'));
}

/**
 * The shipped `@RateLimit` of an anonymous authn route. A refused client gets `answer`, the one the route's IP throttle
 * gives, with the same status, body and headers, and no route sends `X-RateLimit-*`, which would tell a refused client
 * from a failed login.
 */
export function AuthnRateLimit(name: AuthnHttpRateLimitName, answer: ThrottledAnswer, key?: IRateLimitOptions['key']): ReturnType<typeof RateLimit> {
  return RateLimit({ config: `authn.http.rateLimit.${name}`, default: AUTHN_HTTP_RATE_LIMITS[name], answer, headers: false, ...(key ? { key } : {}) });
}

/** authn's own 429 body, as a throttled verification or reset request answers. */
export const throttledRequest = (retryAfterSeconds: number) => tooManyRequests('too many requests, try again later', retryAfterSeconds);

/**
 * The shipped `@RateLimit` of a route with a session: authn's 429 unless `options` names another answer, and, as on
 * every authn route, no `X-RateLimit-*` headers; the answer carries its own `Retry-After`.
 */
export function AuthnSessionRateLimit(name: AuthnHttpSessionRateLimitName, options: Pick<IRateLimitOptions, 'answer' | 'headers' | 'key'> = {}): ReturnType<typeof RateLimit> {
  return RateLimit({ config: `authn.http.rateLimit.${name}`, default: AUTHN_HTTP_SESSION_RATE_LIMITS[name], answer: throttledRequest, headers: false, ...options });
}
