const ReadyResponseSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['up', 'degraded', 'down'], description: 'Worst status across all checks' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          status: { type: 'string', enum: ['up', 'degraded', 'down'] },
          durationMs: { type: 'number' },
          message: { type: 'string', description: 'The check\'s own message; "the check threw" for a check that threw' },
          data: { type: 'object', description: 'data.error is present only for a caller admitted by telemetry.auth.policies.probeDetail' },
        },
      },
    },
  },
};

export default ReadyResponseSchema;
