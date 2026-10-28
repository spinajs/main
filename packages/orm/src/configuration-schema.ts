import { DI } from '@spinajs/di';
import { CONFIGURATION_SCHEMA } from '@spinajs/configuration-common';

export const ORM_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/orm.configuration.schema.json',
  $configurationModule: 'db',
  description: 'ORM configuration (db.*)',
  type: 'object',
  properties: {
    // enum, not type: 'boolean': coerceTypes would read null and 0 as false and switch the check off
    StrictTableCheck: { enum: [true, false], default: true },
  },
};

// @spinajs/orm depends on configuration-common only, so registerConfigurationSchema() is out of reach.
DI.register(ORM_CONFIGURATION_SCHEMA).asValue(CONFIGURATION_SCHEMA.key);
