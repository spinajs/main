import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

// parseDuration's grammar (src/duration.ts), units case-insensitive; the lookahead refuses a zero amount.
const DURATION = { type: 'string', pattern: '^\\s*(?=\\d*\\.?\\d*[1-9])\\d+(\\.\\d+)?\\s*([mM][sS]|[sSmMhHdDwW])\\s*$' };
const MILLISECONDS = { type: 'integer', minimum: 1 };

/** Open at its root: cache.orm, cache.redis and later sections have schemas of their own. */
export const CACHE_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/cache.configuration.schema.json',
  $configurationModule: 'cache',
  description: 'Cache configuration (cache.*)',
  type: 'object',
  properties: {
    maxTtl: { anyOf: [DURATION, MILLISECONDS], default: '1h', description: 'Cap of ttl + swr of every entry, counted from the reading of its tag versions' },
    ttlJitter: { type: 'number', minimum: 0, maximum: 0.5, default: 0.1, description: 'Read, applied from the next version: every ttl will be shortened by a random fraction of itself up to this' },
    caches: {
      type: 'object',
      description: 'Named caches; an entry is open for the keys of its store',
      additionalProperties: {
        type: 'object',
        properties: {
          store: { type: 'string', minLength: 1, description: 'Class name of the CacheStore; default MemoryCacheStore' },
          maxEntries: { type: 'integer', minimum: 0 },
          maxBytes: { type: 'integer', minimum: 0 },
          consistency: { enum: ['eventual', 'strict'] },
        },
      },
    },
  },
};

registerConfigurationSchemaAtImport(CACHE_CONFIGURATION_SCHEMA);
