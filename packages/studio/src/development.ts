import { CONFIGURATION_CONTAINER_KEY, Configuration } from '@spinajs/configuration';
import { normalizeEnvironment } from '@spinajs/configuration-common';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** The env names development: `configuredEnv` when it is a string, else APP_ENV, else NODE_ENV. A missing env is production. */
export function isExplicitDevelopment(env: EnvLike = process.env, configuredEnv?: unknown): boolean {
  const configured = typeof configuredEnv === 'string' ? configuredEnv : undefined;
  return normalizeEnvironment(configured ?? env.APP_ENV ?? env.NODE_ENV) === 'dev';
}

export interface StudioSkipSettings {
  /** `studio.auth.skipInDevelopment` */
  readonly skipInDevelopment: unknown;
  /** `configuration.isProduction` */
  readonly isProduction: unknown;
  /** The env the Configuration loaded its files for ({@link configuredEnvOf}). */
  readonly configuredEnv?: unknown;
}

/** The opt-in development skip: the flag is exactly `true`, the env names development, and `isProduction` is not `true`. */
export function studioSkipsAuth(settings: StudioSkipSettings, env: EnvLike = process.env): boolean {
  return settings.skipInDevelopment === true && settings.isProduction !== true && isExplicitDevelopment(env, settings.configuredEnv);
}

/** The env the Configuration that `instance`'s `@Config` properties read loaded its files for. */
export function configuredEnvOf(instance: object): unknown {
  const container = (instance as Record<string, IContainer | undefined>)[CONFIGURATION_CONTAINER_KEY] ?? DI.RootContainer;
  return (container.get(Configuration) as { Env?: unknown } | undefined)?.Env;
}
