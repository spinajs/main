import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

const properties = {
  // Must exceed the longest time an audited row sits between its insert and its commit (a transactional write in a long
  // transaction): a row committed later lands in a range already sealed, which verification reports for good.
  settleSeconds: { type: 'number', minimum: 0, default: 30 },
  // Events per seal: the memory of one sealing step and the resolution of a tamper report.
  batchSize: { type: 'integer', minimum: 1, maximum: 5000, default: 1000 },
  // Seals per table and run: a large backlog is sealed over several runs.
  maxSeals: { type: 'integer', minimum: 1, maximum: 10000, default: 100 },
};

// propertyNames, not additionalProperties: the configuration's removeAdditional would drop a misspelt key silently.
const AUDIT_SEAL_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/audit-seal.configuration.schema.json',
  $configurationModule: 'audit.seal',
  description: 'Audit sealing configuration (audit.seal.*)',
  type: 'object',
  propertyNames: { enum: Object.keys(properties) },
  properties,
};

registerConfigurationSchemaAtImport(AUDIT_SEAL_CONFIGURATION_SCHEMA);
