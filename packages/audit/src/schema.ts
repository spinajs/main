import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

const paths = { type: 'array', items: { type: 'string', minLength: 1 } };
const positive = { type: 'integer', minimum: 1 };
// propertyNames, not additionalProperties: the configuration's removeAdditional would drop a misspelt key silently and
// weaken the section. The enum is derived from the properties, so the two cannot drift.
const closed = (properties: Record<string, unknown>): Record<string, unknown> => ({ type: 'object', propertyNames: { enum: Object.keys(properties) }, properties });
const retry = { attempts: { type: 'integer', minimum: 1, maximum: 10 }, delay: { anyOf: [{ type: 'integer' }, { type: 'string' }] } };
const trail = {
  store: { type: 'string', minLength: 1 },
  table: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]{0,62}$' },
  connection: { type: 'string', minLength: 1 },
  onFailure: { enum: ['continue', 'reject'] },
  retry: closed(retry),
  integrity: { enum: ['none', 'sealed'] },
  omit: paths,
  mask: paths,
  hash: paths,
  retentionDays: positive,
  sink: { type: 'string', minLength: 1 },
  reader: { type: 'string', minLength: 1 },
  archiveConnection: { type: 'string', minLength: 1 },
};

// No defaults inside `trails`: trailConfig() lays a trail over the built-in of its name, which a schema default would hide.
// The root stays open: audit.http, audit.data, audit.ship and the like belong to other packages, each with its own schema.
export const AUDIT_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/audit.configuration.schema.json',
  $configurationModule: 'audit',
  description: 'Audit trail configuration (audit.*)',
  type: 'object',
  properties: {
    trails: {
      type: 'object',
      propertyNames: { pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' },
      additionalProperties: closed(trail),
    },
    confirmTimeoutMs: positive,
    hashKey: closed({ secret: { type: ['string', 'null'], minLength: 32 } }),
    deferred: closed({ flushMs: positive, maxBatch: positive, maxBuffered: positive, timeoutMs: positive, blockCeilingMs: positive }),
  },
};

registerConfigurationSchemaAtImport(AUDIT_CONFIGURATION_SCHEMA);
