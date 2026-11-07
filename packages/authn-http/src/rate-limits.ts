import { createHash } from 'node:crypto';
import { RateLimit } from '@spinajs/http';
import type { IMiddlewareContext, IRateLimitOptions } from '@spinajs/http';

import { AUTHN_HTTP_RATE_LIMITS } from './rate-limit-config.js';
import type { AuthnHttpRateLimitName } from './rate-limit-config.js';
import type { ThrottledAnswer } from './middleware/ip-throttle.js';

/**
 * Counts a pending session (an MFA step in progress) on its own handle, hashed, so users behind one address who are past
 * their password do not spend the anonymous budget of that address.
 */
export function pendingSessionKey({ storage }: IMiddlewareContext): string | undefined {
  const handle = storage.AuthnSession?.handle;
  return handle?.state === 'pending' ? `pending:${createHash('sha256').update(handle.id).digest('hex')}` : undefined;
}

/**
 * The shipped `@RateLimit` of an anonymous authn route. A refused client gets `answer`, the one the route's IP throttle
 * gives, and no route answers `X-RateLimit-*`: the throttled answer must not tell which limiter refused, nor a limit from
 * a failure.
 */
export function AuthnRateLimit(name: AuthnHttpRateLimitName, answer: ThrottledAnswer, key?: IRateLimitOptions['key']): ReturnType<typeof RateLimit> {
  return RateLimit({ config: `authn.http.rateLimit.${name}`, default: AUTHN_HTTP_RATE_LIMITS[name], answer, headers: false, ...(key ? { key } : {}) });
}
