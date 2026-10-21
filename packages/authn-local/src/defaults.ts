import { AUTHN_LOCAL_CONFIGURATION_SCHEMA } from './schema.js';
import { frozenCopy } from '@spinajs/util';

const local = AUTHN_LOCAL_CONFIGURATION_SCHEMA.properties;

/** The schema's `authn.local` defaults, for the `deps`/`options` seams that bypass the configuration. */
export const AUTHN_LOCAL_DEFAULTS = frozenCopy({
  hasher: { maxConcurrent: local.hasher.properties.maxConcurrent.default },
  policy: { minLength: local.policy.properties.minLength.default, maxLength: local.policy.properties.maxLength.default },
  generator: { length: local.generator.properties.length.default, characters: local.generator.properties.characters.default },
  reset: { ttlSeconds: local.reset.properties.ttlSeconds.default, url: local.reset.properties.url.default, revokeTokens: local.reset.properties.revokeTokens.default },
  invite: { ttlSeconds: local.invite.properties.ttlSeconds.default },
  expiration: { enabled: local.expiration.properties.enabled.default, maxAgeDays: local.expiration.properties.maxAgeDays.default },
  mail: { delivery: local.mail.properties.delivery.default },
});
