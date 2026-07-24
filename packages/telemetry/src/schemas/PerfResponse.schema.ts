const PerfResponseSchema = {
  type: 'object',
  properties: {
    truncated: { type: 'boolean', description: 'True once the measurement-name cap was hit' },
    spans: {
      type: 'array',
      description: 'Timed spans, slowest total first',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Measurement name, eg. orm.query' },
          count: { type: 'number' },
          totalMs: { type: 'number' },
          avgMs: { type: 'number' },
          maxMs: { type: 'number' },
        },
      },
    },
    events: {
      type: 'array',
      description: 'Counter and value events, largest total first',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number', description: 'Number of emissions' },
          total: { type: 'number', description: 'Summed value across emissions' },
        },
      },
    },
  },
};

export default PerfResponseSchema;
