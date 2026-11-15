import type * as express from 'express';

import { HTTP_STATUS_CODE } from '../interfaces.js';
import type { IDocumentedAnswer, IDocumentedHeader, Response } from '../interfaces.js';
import { RawJsonResponse } from '../response-methods/rawJson.js';
import type { IThrottleHit } from './Throttle.js';

const TOO_MANY_REQUESTS_BODY = Object.freeze({ error: Object.freeze({ code: 'E_TOO_MANY_REQUESTS', message: 'Too many requests, try again later' }) });

export const tooManyRequests = (): Response => new RawJsonResponse(HTTP_STATUS_CODE.TOO_MANY_REQUESTS, TOO_MANY_REQUESTS_BODY);

const ANSWER_DOC = Symbol.for('spinajs:http:answer-doc');

/** What a throttled answer sends: its status, a description, a `Retry-After` header and a named body type. */
export interface IAnswerDoc {
  status: number;
  description: string;
  retryAfter?: boolean;
  /** A named type resolved like `@response 429 {AuthnError}`. */
  type?: string;
}

/** Marks a throttled answer with what it sends, for API documents. */
export function documentedAnswer<F extends (retryAfterSeconds: number) => Response>(fn: F, doc: IAnswerDoc): F {
  return Object.assign(fn, { [ANSWER_DOC]: doc });
}

export const answerDocOf = (fn: unknown): IAnswerDoc | undefined => (fn as { [ANSWER_DOC]?: IAnswerDoc } | undefined)?.[ANSWER_DOC];

const integerHeader = (description: string): IDocumentedHeader => ({ description, type: 'integer' });

export const retryAfterDoc = (): Record<string, IDocumentedHeader> => ({ 'Retry-After': integerHeader('Seconds until the limit lets a request through again') });

/** The headers `setRateLimitHeaders` sets; a closed route (`limit: 0`) sends no `X-RateLimit-Reset`. */
export function rateLimitHeadersDoc(closed = false): Record<string, IDocumentedHeader> {
  return {
    'X-RateLimit-Limit': integerHeader('Requests allowed in the window'),
    'X-RateLimit-Remaining': integerHeader('Requests left in the current window'),
    ...(closed ? {} : { 'X-RateLimit-Reset': integerHeader('When the current window resets, in Unix seconds') }),
  };
}

/**
 * The default 429. Only the plain one (not closed, no `X-RateLimit-*`) is the shared `TooManyRequests` component: the
 * others differ from it in their headers.
 */
export function tooManyRequestsDoc(closed: boolean, headers: boolean): IDocumentedAnswer {
  const doc: IDocumentedAnswer = {
    description: 'Too many requests',
    schema: {
      type: 'object',
      required: ['error'],
      properties: { error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string', enum: ['E_TOO_MANY_REQUESTS'] }, message: { type: 'string' } } } },
    },
  };
  if (!closed && !headers) return { ...doc, component: 'TooManyRequests', headers: retryAfterDoc() };
  const sent = { ...(closed ? {} : retryAfterDoc()), ...(headers ? rateLimitHeadersDoc(closed) : {}) };
  return Object.keys(sent).length > 0 ? { ...doc, headers: sent } : doc;
}

/** Seconds until the window of `hit` resets, at least 1. */
export const retryAfterSeconds = (hit: IThrottleHit): number => Math.max(1, Math.ceil((hit.resetAt - Date.now()) / 1000));

export function setRateLimitHeaders(res: express.Response, limit: number, hit: IThrottleHit): void {
  res.set('X-RateLimit-Limit', String(limit));
  res.set('X-RateLimit-Remaining', String(Math.max(0, limit - hit.count)));
  res.set('X-RateLimit-Reset', String(Math.ceil(hit.resetAt / 1000)));
}

/** Over `limit`, the 429 answer carrying its own `Retry-After`; nothing is set on `res`. */
export function quietRateLimitAnswer(limit: number, hit: IThrottleHit): Response | undefined {
  return hit.count > limit ? tooManyRequests().setHeader('Retry-After', String(retryAfterSeconds(hit))) : undefined;
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
