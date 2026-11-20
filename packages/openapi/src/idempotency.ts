import type { OpenAPIV3_1 } from 'openapi-types';
import type { Parameter } from './paths.js';

// This file repeats IDEMPOTENCY_DOC and IDEMPOTENT_REPLAYED_HEADER of @spinajs/http, which is only a devDependency here;
// test/idempotency.test.ts compares them.
const KEY_DESCRIPTION = 'Runs the request at most once per key: a repeat gets the stored reply. 1 to 255 characters: bare visible ASCII without "," and ";", or a quoted string';

export const IDEMPOTENCY_ANSWERS: Readonly<Record<'400' | '409' | '422', string>> = {
  '400': 'The Idempotency-Key header is missing on a route that requires it, malformed, or not a random UUID in a shared scope',
  '409': 'A request with the same Idempotency-Key is still in progress, or claiming the key conflicted',
  '422': 'The Idempotency-Key was already used with a different request',
};

export const RETRY_AFTER_HEADER: OpenAPIV3_1.HeaderObject = { description: 'Seconds until a retry may get the reply', schema: { type: 'integer' } };

export const REPLAYED_HEADER_NAME = 'Idempotent-Replayed';

export const REPLAYED_HEADER: OpenAPIV3_1.HeaderObject = { description: 'true on a reply replayed for a repeated Idempotency-Key', schema: { type: 'string' } };

export function idempotencyParameter(required: boolean): Parameter {
  return { name: 'Idempotency-Key', in: 'header', required, description: KEY_DESCRIPTION, schema: { type: 'string', minLength: 1, maxLength: 512 } };
}
