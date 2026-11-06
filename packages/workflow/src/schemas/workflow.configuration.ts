const duration = { anyOf: [{ type: 'string' }, { type: 'number', minimum: 0 }] };

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
