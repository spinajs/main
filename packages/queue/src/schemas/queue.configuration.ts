import { POSITIVE_DURATION_PATTERN } from './queue.outbox.configuration.js';

export const QUEUE_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/queue.configuration.schema.json',
  $configurationModule: 'queue',
  description: 'Queue configuration (queue.*), only the keys added in 4.x',
  type: 'object',
  properties: {
    deduplicateEvents: { type: 'boolean' },
    // the string branch with its pattern comes first, as in the outbox schema: an integer branch first would take null as 0
    deduplicateTtl: { anyOf: [{ type: 'string', pattern: POSITIVE_DURATION_PATTERN }, { type: 'integer', minimum: 1 }] },
  },
};
