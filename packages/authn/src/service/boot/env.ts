import { DI } from '@spinajs/di';
import { normalizeEnvironment } from '@spinajs/configuration';

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

const given = (v: unknown): boolean => typeof v === 'string' && v !== '';

/**
 * True when nothing named the env and the configuration fell back to development (SR-16): authnAppEnv then answers
 * undefined and authn treats the deployment as production. The sources are those Configuration.load reads: its own
 * `Env` (`--env` or APP_ENV), the APP_ENV of a DI-registered `process.env`, and NODE_ENV.
 */
export function authnEnvFellBack(config: AuthnConfigSource & { readonly Env?: unknown }): boolean {
  // Configuration.load reads the root container's 'process.env', so this does too.
  const registered = DI.get<NodeJS.ProcessEnv>('process.env');
  return !given(config.Env) && !given(registered?.APP_ENV) && !given(process.env.APP_ENV) && !given(process.env.NODE_ENV) && resolvedAppEnv(config) === 'development';
}
