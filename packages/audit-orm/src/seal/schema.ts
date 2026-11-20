import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

import { MIN_SEAL_SECRET_LENGTH } from './config.js';
import { AUDIT_SEAL_KEY_ID_WIDTH } from './table.js';

const properties = {
  // Must exceed the longest time an audited row sits between its insert and its commit (a transactional write in a long
  // transaction): a row committed later lands in a range already sealed, which verification reports for good.
  settleSeconds: { type: 'number', minimum: 0, default: 30 },
  // Events per seal: the memory of one sealing step and the resolution of a tamper report.
  batchSize: { type: 'integer', minimum: 1, maximum: 5000, default: 1000 },
  // Seals per table and run: a large backlog is sealed over several runs.
  maxSeals: { type: 'integer', minimum: 1, maximum: 10000, default: 100 },
  // The first key signs new seals, every listed key verifies the seals it signed: rotate by adding the new key first.
  keys: {
    type: 'array',
    items: {
      type: 'object',
      required: ['id', 'secret'],
      propertyNames: { enum: ['id', 'secret'] },
      properties: { id: { type: 'string', minLength: 1, maxLength: AUDIT_SEAL_KEY_ID_WIDTH }, secret: { type: 'string', minLength: MIN_SEAL_SECRET_LENGTH } },
    },
  },
  // Per table, the end of the keyless seals sealed before the keys were set; with keys and no entry, none is lawful.
  keylessUpTo: {
    type: 'object',
    additionalProperties: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } }] },
  },
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
