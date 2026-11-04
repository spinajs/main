import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

// parseDuration's grammar (durable/src/duration.ts), units case-insensitive
const DURATION = { type: 'string', pattern: '^\\s*\\d+(\\.\\d+)?\\s*([mM][sS]|[sSmMhHdDwW])\\s*$' };

/** The `idempotency` module (docs/idempotency/README.md); Ajv fills the defaults and refuses a wrong value at boot. */
export const IDEMPOTENCY_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/idempotency.configuration.schema.json',
  $configurationModule: 'idempotency',
  description: 'Idempotency service configuration (idempotency.*)',
  type: 'object',
  properties: {
    store: { type: 'string', minLength: 1, default: 'OrmIdempotencyStore', description: 'Class name of the IdempotencyStore' },
    lease: { ...DURATION, default: '30s', description: 'How long a claim holds without a renewal' },
    sweepBatch: { type: 'integer', minimum: 1, default: 500, description: 'Rows one sweep deletes at most' },
    sweepEvery: { ...DURATION, default: '5m', description: 'Interval at which an app schedule should call IdempotencyService.sweep()' },
  },
};

// The http gate imports this package with import(), after the Configuration resolved: too late for a Bootstrapper.
registerConfigurationSchemaAtImport(IDEMPOTENCY_CONFIGURATION_SCHEMA);
