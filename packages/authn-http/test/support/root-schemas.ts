import { DI } from '@spinajs/di';
import { HTTP_CONFIGURATION_SCHEMA } from '@spinajs/http';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import { AUTHN_SESSION_CONFIGURATION_SCHEMA } from '@spinajs/authn-session/schemas';
import { AUTHN_TOTP_CONFIGURATION_SCHEMA } from '@spinajs/authn-totp/schemas';
import { AUTHN_KEYS_CONFIGURATION_SCHEMA } from '@spinajs/authn-keys/schemas';
import { AUTHN_LOCAL_CONFIGURATION_SCHEMA } from '@spinajs/authn-local/schemas';
import { AUTHN_JWT_CONFIGURATION_SCHEMA, AUTHN_TOKEN_CONFIGURATION_SCHEMA } from '@spinajs/authn-token/schemas';

import { AUTHN_HTTP_CONFIGURATION_SCHEMA } from '../../src/schema.js';

/** The suites that boot the root Configuration run no authn bootstrapper; `DI.clearCache()` in a suite drops the schemas, so every boot registers them again. */
export function registerRootSchemas(): void {
  const registered = (DI.RootContainer.Cache.get('__configurationSchema__', false) ?? []) as object[];
  const authn = [AUTHN_CONFIGURATION_SCHEMA, AUTHN_HTTP_CONFIGURATION_SCHEMA, AUTHN_SESSION_CONFIGURATION_SCHEMA, AUTHN_TOKEN_CONFIGURATION_SCHEMA, AUTHN_JWT_CONFIGURATION_SCHEMA, AUTHN_KEYS_CONFIGURATION_SCHEMA, AUTHN_LOCAL_CONFIGURATION_SCHEMA, AUTHN_TOTP_CONFIGURATION_SCHEMA];
  for (const schema of [...authn, HTTP_CONFIGURATION_SCHEMA]) {
    if (!registered.includes(schema)) DI.register(schema).asValue('__configurationSchema__');
  }
}
