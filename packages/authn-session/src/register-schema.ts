import '@spinajs/authn/register-schema';
import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

import { AUTHN_SESSION_CONFIGURATION_SCHEMA } from './schema.js';

// `@spinajs/authn-session/register-schema`: what `@spinajs/authn/register-schema` is for authn.*, for authn.session. A
// module of any package that reads authn.session imports it.
registerConfigurationSchemaAtImport(AUTHN_SESSION_CONFIGURATION_SCHEMA);
