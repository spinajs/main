import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

import { UPLOAD_CONFIGURATION_SCHEMA } from './schema.js';

// The scheduler subpath and the CLI command load after the Configuration resolved, too late for the Bootstrapper.
registerConfigurationSchemaAtImport(UPLOAD_CONFIGURATION_SCHEMA);
