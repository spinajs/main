// parseDuration's grammar (durable/src/duration.ts), units case-insensitive
const DURATION = { type: 'string', pattern: '^\\s*\\d+(\\.\\d+)?\\s*([mM][sS]|[sSmMhHdDwW])\\s*$' };
const MILLISECONDS = { type: 'integer', minimum: 0 };

// The validator coerces types and anyOf stops at its first valid branch. A plain string branch would turn 5000 into
// '5000' and pass; a number branch tried first would take null as 0 and true as 1. The pattern refuses all three, and
// the integer branch then keeps a number a number.
const duration = { anyOf: [DURATION, MILLISECONDS] };

export const WORKFLOW_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/workflow.configuration.schema.json',
  $configurationModule: 'workflow',
  description: 'Workflow engine configuration validation',
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    tick: { type: 'integer', minimum: 50 },
    concurrency: { type: 'integer', minimum: 1 },
    leaseTtl: { type: 'integer', minimum: 3000 },
    shutdownGrace: { type: 'integer', minimum: 0 },
    maxStepResultBytes: { type: 'integer', minimum: 0 },
    compensateOnCancel: { type: 'boolean' },
    compensationTimeout: { type: 'integer', minimum: 1 },
    retry: {
      type: 'object',
      required: ['attempts'],
      properties: {
        attempts: { type: 'integer', minimum: 1 },
        backoff: { enum: ['fixed', 'exponential'] },
        delay: duration,
        maxDelay: duration,
      },
    },
  },
};
