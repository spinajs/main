import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { normalizeEnvironment } from '@spinajs/configuration-common';

export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * The env names development: `configuredEnv` (the env the configuration loaded) when it is a string,
 * else APP_ENV, else NODE_ENV. A missing env normalizes to production.
 */
export function isExplicitDevelopment(env: EnvLike = process.env, configuredEnv?: unknown): boolean {
  const configured = typeof configuredEnv === 'string' ? configuredEnv : undefined;
  return normalizeEnvironment(configured ?? env.APP_ENV ?? env.NODE_ENV) === 'dev';
}

/**
 * The opt-in development skip of the telemetry checks: `telemetry.auth.skipInDevelopment` is exactly
 * `true`, the env names development, and `configuration.isProduction` is not `true`.
 */
export function telemetrySkipsAuth(env: EnvLike = process.env): boolean {
  const cfg = DI.get(Configuration);
  if (!cfg) return false;
  // FrameworkConfiguration keeps the env whose files it loaded (`--env`, else APP_ENV) in `Env`. The
  // tree's `process.env.APP_ENV` is no substitute: it defaults to 'development'.
  const configuredEnv = (cfg as { Env?: unknown }).Env;
  return cfg.get<unknown>('telemetry.auth.skipInDevelopment') === true && cfg.get<unknown>('configuration.isProduction') !== true && isExplicitDevelopment(env, configuredEnv);
}
