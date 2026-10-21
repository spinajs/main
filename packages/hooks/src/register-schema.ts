import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

import { HOOKS_CONFIGURATION_SCHEMA } from './schema.js';

registerConfigurationSchemaAtImport(HOOKS_CONFIGURATION_SCHEMA);
