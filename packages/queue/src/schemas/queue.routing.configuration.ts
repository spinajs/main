// The validator coerces in place: a bare integer would take null and false as 0, true as 1 and a blank string as 0. The
// typed guard refuses those first (null and a boolean become strings there, which the integer branch cannot take back);
// what the guard coerces of a number, the integer branch coerces back.
const milliseconds = { allOf: [{ not: { type: 'string', pattern: '^\\s*$' } }, { type: 'integer', minimum: 0 }] };

const ROUTE = {
  type: 'object',
  properties: {
    backoff: {
      type: 'object',
      required: ['kind', 'delayMs'],
      properties: { kind: { enum: ['fixed', 'exponential'] }, delayMs: milliseconds, maxDelayMs: milliseconds },
    },
    onEventFailure: { enum: ['drop', 'retry'] },
    groupBy: { type: 'string', minLength: 1 },
  },
};

export const QUEUE_ROUTING_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/queue.routing.configuration.schema.json',
  $configurationModule: 'queue',
  description: 'queue.routing: the delivery options added in 4.x',
  type: 'object',
  properties: {
    routing: {
      type: 'object',
      additionalProperties: { anyOf: [{ type: 'string' }, ROUTE, { type: 'array', items: { anyOf: [{ type: 'string' }, ROUTE] } }] },
    },
  },
};
