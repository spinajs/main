import type { IDocumentedAnswer, IDocumentedHeader, IRouteMiddlewareDoc } from '../interfaces.js';
import { PROBLEM_CONTENT_TYPE, PROBLEM_DETAILS_SCHEMA } from '../problem.js';
import { IDEMPOTENT_REPLAYED_HEADER } from './options.js';

/** The wording both API document builders use; @spinajs/openapi repeats it and its tests compare the two. */
export const IDEMPOTENCY_DOC = Object.freeze({
  keyDescription: 'Runs the request at most once per key: a repeat gets the stored reply. 1 to 255 characters: bare visible ASCII without "," and ";", or a quoted string',
  // the header value, not the key: the quoted form adds two quotes and may escape each of the 255 characters
  keySchema: { type: 'string', minLength: 1, maxLength: 512 },
  replayedDescription: 'true on a reply replayed for a repeated Idempotency-Key',
  retryAfterDescription: 'Seconds until a retry may get the reply',
  answers: {
    '400': 'The Idempotency-Key header is missing on a route that requires it, malformed, or not a random UUID in a shared scope',
    '409': 'A request with the same Idempotency-Key is still in progress, or claiming the key conflicted',
    '422': 'The Idempotency-Key was already used with a different request',
  },
} as const);

const problem = (description: string, headers?: Record<string, IDocumentedHeader>): IDocumentedAnswer => ({
  description,
  schema: PROBLEM_DETAILS_SCHEMA,
  contentType: PROBLEM_CONTENT_TYPE,
  ...(headers ? { headers } : {}),
});

export function idempotencyDocumentation(required: boolean): IRouteMiddlewareDoc {
  return {
    requestHeaders: { 'Idempotency-Key': { description: IDEMPOTENCY_DOC.keyDescription, required, schema: { ...IDEMPOTENCY_DOC.keySchema } } },
    headers: { [IDEMPOTENT_REPLAYED_HEADER]: { description: IDEMPOTENCY_DOC.replayedDescription, type: 'string' } },
    responses: {
      '400': problem(IDEMPOTENCY_DOC.answers['400']),
      '409': problem(IDEMPOTENCY_DOC.answers['409'], { 'Retry-After': { description: IDEMPOTENCY_DOC.retryAfterDescription, type: 'integer' } }),
      '422': problem(IDEMPOTENCY_DOC.answers['422']),
    },
  };
}
