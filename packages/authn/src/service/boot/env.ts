import { DI } from '@spinajs/di';
import { checkConfigurationValue } from '@spinajs/configuration';
import { normalizeEnvironment } from '@spinajs/configuration-common';
import { deepFreeze } from '@spinajs/util';

import type { ThrottleParams } from '../../contracts/throttle.js';
import { AUTHN_CONFIGURATION_SCHEMA } from '../../schemas/authn.configuration.js';
import type { ThrottleConfig } from '../../throttle/params.js';

// TODO: env fallbacks - move into config file, it should be explicit in config, not assumed by internal code

/**
 * `http.cookie.secret` as `@spinajs/http` ships it: public, so anyone can sign cookies with it. The same value as
 * `PUBLIC_DEFAULT_COOKIE_SECRET` of `@spinajs/authn-session`, which depends on this package and so cannot be imported.
 */
export const AUTHN_PUBLIC_COOKIE_SECRET = '1234adreewD';

/** Logged at boot and reported by authn:check-config (topic `env`) when authnEnvFellBack. */
export const AUTHN_ENV_FALLBACK_WARNING = 'No app env is set (--env, APP_ENV or NODE_ENV): the configuration fell back to "development", but authn treats the deployment as production and its secret checks are strict; name the env';

/** What the boot checks read; `Configuration` is one. */
export interface AuthnConfigSource {
  get<T>(path: string | string[]): T;
}

function resolvedAppEnv(config: AuthnConfigSource): string | undefined {
  const env = config.get<unknown>('process.env.APP_ENV');
  return typeof env === 'string' ? env : undefined;
}

/**
 * The app env as the configuration resolved it from `--env`, APP_ENV or NODE_ENV; undefined when none was set and the
 * configuration fell back to development (SR-16), so authn treats such a deployment as production.
 */
export function authnAppEnv(config: AuthnConfigSource): string | undefined {
  return authnEnvFellBack(config) ? undefined : resolvedAppEnv(config);
}

/** Only development and test relax the secret checks; any other env, an absent one included, is strict (as authn-session). */
export function isLenientAuthnEnv(env: string | undefined): boolean {
  const normalized = normalizeEnvironment(env);
  return normalized === 'dev' || normalized === 'test';
}

/**
 * True when the configuration resolved development and no env source names development (SR-16): authnAppEnv then
 * answers undefined and authn treats the deployment as production. The sources are those Configuration.load reads:
 * its own `Env` (`--env` or APP_ENV), the APP_ENV of a DI-registered `process.env`, and NODE_ENV. A source set to
 * another env after the configuration loaded relaxes nothing, nor does development named only in a config file.
 */
export function authnEnvFellBack(config: AuthnConfigSource & { readonly Env?: unknown }): boolean {
  // Configuration.load reads the root container's 'process.env', so this does too.
  const registered = DI.get<NodeJS.ProcessEnv>('process.env');
  return resolvedAppEnv(config) === 'development' && ![config.Env, registered?.APP_ENV, process.env.APP_ENV, process.env.NODE_ENV].includes('development');
}

// Without its `default`: Ajv's strict mode refuses one at the schema root.
const { default: _default, ...throttleSchema } = AUTHN_CONFIGURATION_SCHEMA.properties.throttle;
const THROTTLE_SCHEMA = { ...throttleSchema, $configurationModule: 'authn.throttle' };

/**
 * Params given to a throttle directly, which never pass through Configuration: checked against the `authn.throttle`
 * schema and returned as a frozen copy with its defaults. Throws InvalidConfiguration naming the key.
 */
export function checkedThrottleParams(params: ThrottleParams): ThrottleParams {
  const { service: _service, maxRows: _maxRows, memory: _memory, ...checked } = checkConfigurationValue(THROTTLE_SCHEMA, params as ThrottleConfig);
  return deepFreeze(checked);
}

/** A row cap given to a MemoryAuthnThrottle directly, checked against `authn.throttle.maxRows`. */
export function checkedThrottleMaxRows(maxRows: number): number {
  return checkConfigurationValue(THROTTLE_SCHEMA, { maxRows } as ThrottleConfig).maxRows!;
}
