import RequestStatsSnapshotSchema from './RequestStatsSnapshot.schema.js';

const StatsResponseSchema = {
  type: 'object',
  properties: {
    all: { ...RequestStatsSnapshotSchema, description: 'Lifetime request stats' },
    timeline: {
      type: 'object',
      description: 'Rolling per-bucket stats, keyed by floor( timestamp / bucketMs )',
      additionalProperties: RequestStatsSnapshotSchema,
    },
  },
};

export default StatsResponseSchema;
