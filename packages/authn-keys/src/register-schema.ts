import '@spinajs/authn/register-schema';
import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

import { AUTHN_KEYS_CONFIGURATION_SCHEMA } from './schema.js';

// What `@spinajs/authn/register-schema` is for authn.*, for authn.keys: every module of this package that reads it
// imports it.
registerConfigurationSchemaAtImport(AUTHN_KEYS_CONFIGURATION_SCHEMA);
