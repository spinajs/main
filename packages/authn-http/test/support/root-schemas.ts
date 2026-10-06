import { DI } from '@spinajs/di';
import { HTTP_CONFIGURATION_SCHEMA } from '@spinajs/http';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';

/** The suites that boot the root Configuration run no authn bootstrapper; `DI.clearCache()` in a suite drops the schemas, so every boot registers them again. */
export function registerRootSchemas(): void {
  DI.register(AUTHN_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  DI.register(HTTP_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
}
