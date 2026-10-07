import { DI } from '@spinajs/di';
import { HTTP_CONFIGURATION_SCHEMA } from '@spinajs/http';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';

/** The suites that boot the root Configuration run no authn bootstrapper; `DI.clearCache()` in a suite drops the schemas, so every boot registers them again. */
export function registerRootSchemas(): void {
  const registered = (DI.RootContainer.Cache.get('__configurationSchema__', false) ?? []) as object[];
  for (const schema of [AUTHN_CONFIGURATION_SCHEMA, HTTP_CONFIGURATION_SCHEMA]) {
    if (!registered.includes(schema)) DI.register(schema).asValue('__configurationSchema__');
  }
}
