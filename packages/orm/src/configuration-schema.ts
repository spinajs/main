import { DI } from '@spinajs/di';
import { CONFIGURATION_SCHEMA } from '@spinajs/configuration-common';
import { DEFAULT_EXPLAIN_OPTIONS } from './explain/options.js';

export const ORM_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/orm.configuration.schema.json',
  $configurationModule: 'db',
  description: 'ORM configuration (db.*)',
  type: 'object',
  properties: {
    // enum, not type: 'boolean': coerceTypes would read null and 0 as false and switch the check off
    StrictTableCheck: { enum: [true, false], default: true },
    MigrationCheck: { enum: ['fail', 'warn', 'off'], default: 'fail' },
    Explain: {
      type: 'object',
      properties: {
        Enabled: { enum: [true, false], default: DEFAULT_EXPLAIN_OPTIONS.Enabled },
        SlowQueryMs: { type: 'number', minimum: 0, default: DEFAULT_EXPLAIN_OPTIONS.SlowQueryMs },
        MaxPerMinute: { type: 'integer', minimum: 0, default: DEFAULT_EXPLAIN_OPTIONS.MaxPerMinute },
        CaptureBindings: { enum: [true, false], default: DEFAULT_EXPLAIN_OPTIONS.CaptureBindings },
      },
    },
    Models: {
      type: 'object',
      properties: {
        Source: { enum: ['database', 'manifest'], default: 'database' },
      },
    },
    WriteCapture: {
      type: 'object',
      // propertyNames, not additionalProperties: false: removeAdditional would drop a misspelt key silently, and a
      // misspelt Required switches the check off.
      propertyNames: { enum: ['MaxRows', 'Required'] },
      properties: {
        // 0: unlimited
        MaxRows: { type: 'integer', minimum: 0, default: 0 },
        // table names; empty: no table needs an observer
        Required: { type: 'array', items: { type: 'string', minLength: 1 }, default: [] },
      },
    },
  },
};

// @spinajs/orm depends on configuration-common only, so registerConfigurationSchema() is out of reach.
DI.register(ORM_CONFIGURATION_SCHEMA).asValue(CONFIGURATION_SCHEMA.key);
