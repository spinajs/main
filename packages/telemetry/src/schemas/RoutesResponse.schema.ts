import RequestStatsSnapshotSchema from './RequestStatsSnapshot.schema.js';

const RoutesResponseSchema = {
  type: 'object',
  properties: {
    truncated: { type: 'boolean', description: 'True once the route cap was hit and new routes stopped being tracked' },
    routes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'HTTP method' },
          route: { type: 'string', description: 'Matched route path, or the raw path when nothing matched' },
          stats: RequestStatsSnapshotSchema,
        },
      },
    },
  },
};

export default RoutesResponseSchema;
