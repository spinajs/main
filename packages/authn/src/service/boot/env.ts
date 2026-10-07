import { DI } from '@spinajs/di';
import { normalizeEnvironment } from '@spinajs/configuration-common';
import { InvalidOption } from '@spinajs/exceptions';

import { THROTTLE_FLOWS } from '../../contracts/throttle.js';
import type { ThrottleParams } from '../../contracts/throttle.js';

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

const atLeast = (v: unknown, min: number): boolean => Number.isInteger(v) && (v as number) >= min;

const refuse = (path: string, rule: string): never => {
  throw new InvalidOption(`authn.throttle.${path} ${rule}`);
};

function checkBackoff(p: unknown, at: string): void {
  if (typeof p !== 'object' || p === null) refuse(at, 'must be { free, baseDelayMs, maxDelayMs }');
  const b = p as Record<string, unknown>;
  for (const [key, min] of [['free', 0], ['baseDelayMs', 0], ['maxDelayMs', 1]] as const) {
    if (!atLeast(b[key], min)) refuse(`${at}.${key}`, `must be an integer of at least ${min}`);
  }
}

/**
 * The schema's throttle ranges, for limits that never went through it (constructor params, a runtime
 * Configuration.set before the first use): a NaN delay, a zero maxDelayMs or a zero resetAfterSeconds switches the
 * backoff off. Throws InvalidOption naming the key.
 */
export function checkThrottleParams(params: ThrottleParams): void {
  const flows = params as unknown as Record<string, unknown> | null | undefined;
  for (const flow of THROTTLE_FLOWS) {
    const f = flows?.[flow];
    if (typeof f !== 'object' || f === null) refuse(flow, 'must be an object');
    const { account, ip } = f as Record<string, unknown>;
    checkBackoff(account, `${flow}.account`);
    if (ip !== undefined) checkBackoff(ip, `${flow}.ip`);
  }
  if (params.global !== undefined && params.global !== null) checkBackoff(params.global, 'global');
  if (!atLeast(params.resetAfterSeconds, 1)) refuse('resetAfterSeconds', 'must be an integer of at least 1');
}

/** A NaN or infinite row cap never fills, so the memory throttle would grow without bound. */
export function checkThrottleMaxRows(maxRows: unknown): void {
  if (!atLeast(maxRows, 1)) refuse('maxRows', 'must be a positive integer');
}
