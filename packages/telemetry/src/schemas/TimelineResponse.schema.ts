import RequestStatsSnapshotSchema from './RequestStatsSnapshot.schema.js';

const TimelineResponseSchema = {
  type: 'object',
  properties: {
    bucketMs: { type: 'number', description: 'Bucket width in ms' },
    length: { type: 'number', description: 'Number of buckets retained in the ring' },
    buckets: {
      type: 'array',
      description: 'Live buckets, oldest first',
      items: {
        type: 'object',
        properties: {
          key: { type: 'number', description: 'floor( timestamp / bucketMs )' },
          from: { type: 'number', description: 'Bucket start, epoch ms' },
          to: { type: 'number', description: 'Bucket end, epoch ms' },
          stats: RequestStatsSnapshotSchema,
        },
      },
    },
  },
};

export default TimelineResponseSchema;
