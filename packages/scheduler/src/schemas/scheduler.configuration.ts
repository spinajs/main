const duration = { anyOf: [{ type: 'string' }, { type: 'number', minimum: 0 }] };

export const SCHEDULER_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/scheduler.configuration.schema.json',
  $configurationModule: 'scheduler',
  description: 'Scheduler configuration validation',
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    tick: { type: 'integer', minimum: 100 },
    leaseTtl: { type: 'integer', minimum: 3000 },
    shutdownGrace: { type: 'integer', minimum: 0 },
    progressFlush: { type: 'integer', minimum: 100 },
    runLogLimit: { type: 'integer', minimum: 0 },
    maxStepResultBytes: { type: 'integer', minimum: 0 },
    retention: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        schedule: { type: 'string' },
        runs: duration,
        logs: duration,
        errors: duration,
      },
    },
    events: { type: 'object', properties: { pollInterval: { type: 'integer', minimum: 100 } } },
    cli: {
      type: 'object',
      properties: {
        http: {
          type: 'object',
          properties: {
            baseUrl: { type: 'string' },
            headers: { type: 'object', additionalProperties: { type: 'string' } },
          },
          required: ['baseUrl'],
        },
      },
    },
    schedules: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 128 },
          task: { type: 'string' },
          cron: { type: 'string' },
          every: duration,
          at: { type: 'string' },
          manual: { type: 'boolean' },
          timezone: { type: 'string' },
          jitter: duration,
          misfire: { type: 'string', pattern: '^(skip|run-once|catch-up\\(\\d+\\))$' },
          misfireThreshold: duration,
          overlap: { enum: ['skip', 'queue'] },
          runOn: { enum: ['leader', 'all'] },
          params: { type: 'object' },
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
          resumable: { type: 'boolean' },
          timeout: duration,
          pauseAfterFailures: { type: 'integer', minimum: 1 },
          enabled: { type: 'boolean' },
        },
      },
    },
  },
};

export default SCHEDULER_CONFIGURATION_SCHEMA;
