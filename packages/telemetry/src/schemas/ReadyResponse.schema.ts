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
          message: { type: 'string' },
          data: { type: 'object' },
        },
      },
    },
  },
};

export default ReadyResponseSchema;
