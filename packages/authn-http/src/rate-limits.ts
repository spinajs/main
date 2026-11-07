import { createHmac } from 'node:crypto';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { RateLimit } from '@spinajs/http';
import type { IMiddlewareContext, IRateLimitOptions } from '@spinajs/http';

import { AUTHN_HTTP_RATE_LIMITS, AUTHN_HTTP_SESSION_RATE_LIMITS } from './rate-limit-config.js';
import type { AuthnHttpRateLimitName, AuthnHttpSessionRateLimitName } from './rate-limit-config.js';
import type { ThrottledAnswer } from './middleware/ip-throttle.js';
import { tooManyRequests } from './password/fields.js';

/**
 * Counts a pending session (an MFA step in progress) on its own handle, so users behind one address who are past their
 * password do not spend the budget of that address. Only the session AuthnMiddleware restored counts, never a value the
 * client sends: a client that could pick the key would get a fresh counter per request. HMAC under http.cookie.secret
 * (shared by every instance, unlike a per-process key) so the store holds no usable handle. No pending session or no
 * secret: undefined, so the client address counts.
 */
export function pendingSessionKey({ req, storage }: IMiddlewareContext): string | undefined {
  const handle = storage?.AuthnSession?.handle;
  if (handle?.state !== 'pending' || typeof handle.id !== 'string' || handle.id === '') return undefined;
  // cookie-parser puts the configured secret on req.
  const secret = (req as { secret?: unknown } | undefined)?.secret ?? DI.get(Configuration)?.get<string>('http.cookie.secret');
  if (typeof secret !== 'string' || secret === '') return undefined;
  return `pending:${createHmac('sha256', secret).update(handle.id).digest('hex')}`;
}

/**
 * The shipped `@RateLimit` of an anonymous authn route. A refused client gets `answer`, the one the route's IP throttle
 * gives, and no route answers `X-RateLimit-*`: the throttled answer must not tell which limiter refused, nor a limit from
 * a failure.
 */
export function AuthnRateLimit(name: AuthnHttpRateLimitName, answer: ThrottledAnswer, key?: IRateLimitOptions['key']): ReturnType<typeof RateLimit> {
  return RateLimit({ config: `authn.http.rateLimit.${name}`, default: AUTHN_HTTP_RATE_LIMITS[name], answer, headers: false, ...(key ? { key } : {}) });
}

/** authn's own 429 body, as a throttled verification or reset request answers. */
export const throttledRequest = (retryAfterSeconds: number) => tooManyRequests('too many requests, try again later', retryAfterSeconds);

/** The shipped `@RateLimit` of a route with a session; the answer is authn's 429 unless `options` names another. */
export function AuthnSessionRateLimit(name: AuthnHttpSessionRateLimitName, options: Pick<IRateLimitOptions, 'answer' | 'headers' | 'key'> = {}): ReturnType<typeof RateLimit> {
  return RateLimit({ config: `authn.http.rateLimit.${name}`, default: AUTHN_HTTP_SESSION_RATE_LIMITS[name], answer: throttledRequest, ...options });
}
