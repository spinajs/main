import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { normalizeEnvironment } from '@spinajs/configuration-common';

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** APP_ENV (else NODE_ENV) names development. A missing env normalizes to production. */
export function isExplicitDevelopment(env: EnvLike = process.env): boolean {
  return normalizeEnvironment(env.APP_ENV ?? env.NODE_ENV) === 'dev';
}

/**
 * The opt-in development skip of the telemetry checks: `telemetry.auth.skipInDevelopment` is exactly
 * `true`, the env names development, and `configuration.isProduction` is not `true`.
 */
export function telemetrySkipsAuth(env: EnvLike = process.env): boolean {
  const cfg = DI.get(Configuration);
  if (!cfg) return false;
  return cfg.get<unknown>('telemetry.auth.skipInDevelopment') === true && cfg.get<unknown>('configuration.isProduction') !== true && isExplicitDevelopment(env);
}
