/** The grammar of parseDuration (durable/src/duration.ts), units in either case. */
export const DURATION_PATTERN = '^\\s*\\d+(\\.\\d+)?\\s*([mM][sS]|[sSmMhHdDwW])\\s*$';

/** The same, without a zero amount: the lookahead wants a digit from 1 to 9 somewhere in the number. */
export const POSITIVE_DURATION_PATTERN = '^\\s*(?=\\d*\\.?\\d*[1-9])\\d+(\\.\\d+)?\\s*([mM][sS]|[sSmMhHdDwW])\\s*$';

// The order and the pattern both carry weight under the validator's type coercion. The string branch is first and
// passes only a duration with a unit; a number is coerced to a string there, fails the pattern, and the integer branch
// coerces it back. An integer branch tried first would take null as 0 and true as 1.
const duration = { anyOf: [{ type: 'string', pattern: DURATION_PATTERN }, { type: 'integer', minimum: 0 }] };
const positiveDuration = { anyOf: [{ type: 'string', pattern: POSITIVE_DURATION_PATTERN }, { type: 'integer', minimum: 1 }] };

export const QUEUE_OUTBOX_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/queue.outbox.configuration.schema.json',
  $configurationModule: 'queue.outbox',
  description: 'Transactional outbox of @spinajs/queue (queue.outbox.*)',
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    relay: { type: 'boolean' },
    connections: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
    mode: { type: 'string', enum: ['when-in-transaction', 'always'] },
    tick: { type: 'integer', minimum: 10 },
    batchSize: { type: 'integer', minimum: 1, maximum: 1000 },
    claimTtl: { type: 'integer', minimum: 1000 },
    maxPublishMs: { type: 'integer', minimum: 1 },
    maxAge: positiveDuration,
    backoff: {
      type: 'object',
      properties: { backoff: { type: 'string', enum: ['fixed', 'exponential'] }, delay: duration, maxDelay: duration },
      additionalProperties: false,
    },
    retention: duration,
  },
  additionalProperties: false,
};
