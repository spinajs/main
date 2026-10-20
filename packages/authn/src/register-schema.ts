import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

import { AUTHN_CONFIGURATION_SCHEMA } from './schemas/authn.configuration.js';

// `@spinajs/authn/register-schema`: a module of any authn package that reads authn.* imports it. Such a module can load
// after boot (a directory scan, a CLI command) in a process where the @spinajs/authn root and its Bootstrapper never
// load, and the contracts and ./schemas stay free of side effects.
registerConfigurationSchemaAtImport(AUTHN_CONFIGURATION_SCHEMA);
