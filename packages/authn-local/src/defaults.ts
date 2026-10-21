import { AUTHN_LOCAL_CONFIGURATION_SCHEMA } from './schema.js';
import { frozenCopy } from '@spinajs/util';

const local = AUTHN_LOCAL_CONFIGURATION_SCHEMA.properties;

/** One thread of the libuv pool stays free for the other work that needs it (fs, dns, crypto). */
export function defaultMaxConcurrent(): number {
  const pool = Number(process.env.UV_THREADPOOL_SIZE ?? 4);
  return Math.max(1, (Number.isFinite(pool) ? Math.floor(pool) : 4) - 1);
}

/** The schema's `authn.local` defaults, for the `deps`/`options` seams that bypass the configuration. */
export const AUTHN_LOCAL_DEFAULTS = frozenCopy({
  hasher: { maxQueue: local.hasher.properties.maxQueue.default },
  policy: { minLength: local.policy.properties.minLength.default, maxLength: local.policy.properties.maxLength.default, similarity: local.policy.properties.similarity.default },
  hibp: { url: local.hibp.properties.url.default, timeoutMs: local.hibp.properties.timeoutMs.default },
  generator: { length: local.generator.properties.length.default, characters: local.generator.properties.characters.default },
  reset: { ttlSeconds: local.reset.properties.ttlSeconds.default, url: local.reset.properties.url.default, revokeTokens: local.reset.properties.revokeTokens.default },
  invite: { ttlSeconds: local.invite.properties.ttlSeconds.default },
  verify: { ttlSeconds: local.verify.properties.ttlSeconds.default, url: local.verify.properties.url.default },
  expiration: { enabled: local.expiration.properties.enabled.default, maxAgeDays: local.expiration.properties.maxAgeDays.default },
  mail: { delivery: local.mail.properties.delivery.default },
});
