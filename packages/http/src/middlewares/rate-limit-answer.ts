import type * as express from 'express';

import { HTTP_STATUS_CODE } from '../interfaces.js';
import type { Response } from '../interfaces.js';
import { RawJsonResponse } from '../response-methods/rawJson.js';
import type { IThrottleHit } from './Throttle.js';

const TOO_MANY_REQUESTS_BODY = Object.freeze({ error: Object.freeze({ code: 'E_TOO_MANY_REQUESTS', message: 'Too many requests, try again later' }) });

export const tooManyRequests = (): Response => new RawJsonResponse(HTTP_STATUS_CODE.TOO_MANY_REQUESTS, TOO_MANY_REQUESTS_BODY);

/** Seconds until the window of `hit` resets, at least 1. */
export const retryAfterSeconds = (hit: IThrottleHit): number => Math.max(1, Math.ceil((hit.resetAt - Date.now()) / 1000));

export function setRateLimitHeaders(res: express.Response, limit: number, hit: IThrottleHit): void {
  res.set('X-RateLimit-Limit', String(limit));
  res.set('X-RateLimit-Remaining', String(Math.max(0, limit - hit.count)));
  res.set('X-RateLimit-Reset', String(Math.ceil(hit.resetAt / 1000)));
}

/** Sets the `X-RateLimit-*` headers for `hit`; over `limit`, also `Retry-After`, and returns the 429 answer. */
export function rateLimitAnswer(res: express.Response, limit: number, hit: IThrottleHit): Response | undefined {
  setRateLimitHeaders(res, limit, hit);

  if (hit.count > limit) {
    res.set('Retry-After', String(retryAfterSeconds(hit)));
    return tooManyRequests();
  }
  return undefined;
}
