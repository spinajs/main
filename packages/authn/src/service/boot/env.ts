import { explicitAppEnv, isDevOrTestEnv } from '@spinajs/configuration-common';
import type { AppEnvSource } from '@spinajs/configuration-common';
import { InvalidOption } from '@spinajs/exceptions';

import { THROTTLE_FLOWS } from '../../contracts/throttle.js';
import type { ThrottleParams } from '../../contracts/throttle.js';

// TODO: manual checking or env related stuff - should be removed
// manual checks - to schema validation or extend validation functions, env fallbacks etc - move into config file it should be explicit in config, not assumed by internal code

/**
 * `http.cookie.secret` as `@spinajs/http` ships it: public, so anyone can sign cookies with it. The same value as
 * `PUBLIC_DEFAULT_COOKIE_SECRET` of `@spinajs/authn-session`, which depends on this package and so cannot be imported.
 */
export const AUTHN_PUBLIC_COOKIE_SECRET = '1234adreewD';

/** Logged at boot and reported by authn:check-config (topic `env`) when authnEnvFellBack. */
export const AUTHN_ENV_FALLBACK_WARNING = 'No app env is set (--env, APP_ENV or NODE_ENV): the configuration fell back to "development", but authn treats the deployment as production and its secret checks are strict; name the env';

/** What the boot checks read; `Configuration` is one. */
export type AuthnConfigSource = AppEnvSource;

/** @deprecated Use `explicitAppEnv` of `@spinajs/configuration`. */
export const authnAppEnv: (config: AuthnConfigSource) => string | undefined = explicitAppEnv;

/** @deprecated Use `isDevOrTestEnv` of `@spinajs/configuration`. */
export const isLenientAuthnEnv: (env: string | undefined) => boolean = isDevOrTestEnv;

/**
 * True when the configuration resolved development that no env source named (SR-16): `explicitAppEnv` then answers
 * undefined and authn treats the deployment as production.
 */
export function authnEnvFellBack(config: AuthnConfigSource): boolean {
  return config.get<unknown>('process.env.APP_ENV') === 'development' && explicitAppEnv(config) === undefined;
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
