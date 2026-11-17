import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

export const AUDIT_SHIP_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/audit-ship.configuration.schema.json',
  $configurationModule: 'audit.ship',
  description: 'Audit shipping configuration (audit.ship.*)',
  type: 'object',
  properties: {
    // Events per delivery; 500 is the ceiling a sink's dedup select can take on every driver.
    batchSize: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
    // Deliveries per trail and connection in one run; the rest waits for the next run.
    maxBatches: { type: 'integer', minimum: 1, default: 50 },
    // A delivery still pending then counts as failed and its events stay buffered; a late success is a duplicate.
    deliverTimeoutMs: { type: 'integer', minimum: 1, default: 30000 },
  },
  additionalProperties: false,
};

registerConfigurationSchemaAtImport(AUDIT_SHIP_CONFIGURATION_SCHEMA);
