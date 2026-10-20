import '@spinajs/authn/register-schema';
import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

import { AUTHN_JWT_CONFIGURATION_SCHEMA, AUTHN_TOKEN_CONFIGURATION_SCHEMA } from './schema.js';

// What `@spinajs/authn/register-schema` is for authn.*, for authn.token and authn.jwt: every module of this package that
// reads them imports it.
registerConfigurationSchemaAtImport(AUTHN_TOKEN_CONFIGURATION_SCHEMA);
registerConfigurationSchemaAtImport(AUTHN_JWT_CONFIGURATION_SCHEMA);
