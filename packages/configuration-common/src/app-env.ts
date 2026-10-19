import { normalizeEnvironment } from './environment.js';

/** What the app env helpers read; a `Configuration` is one. */
export interface AppEnvSource {
  get<T>(path: string | string[]): T;
  readonly NamedEnv?: string;
}

/**
 * The resolved `process.env.APP_ENV`, or undefined when it is `development` that no env source named: the
 * configuration fell back to it (or only a config file set it), so callers treat the deployment as unset.
 */
export function explicitAppEnv(config: AppEnvSource | undefined): string | undefined {
  const env = config?.get<unknown>('process.env.APP_ENV');
  if (typeof env !== 'string') return undefined;
  return env === 'development' && config!.NamedEnv !== 'development' ? undefined : env;
}

/** Development and test; any other env, an absent or empty one included, is not. */
export function isDevOrTestEnv(env: string | null | undefined): boolean {
  const normalized = normalizeEnvironment(env);
  return normalized === 'dev' || normalized === 'test';
}

/**
 * A boolean is taken as is (the caller's `@Config('configuration.isProduction')`). A string is an env name. A
 * configuration answers with its `configuration.isProduction` flag, else its `process.env.APP_ENV`. Anything else, or a
 * configuration with neither, falls back to APP_ENV, then NODE_ENV, then `development` of the process.
 */
export function isProduction(source: boolean | string | AppEnvSource | undefined): boolean {
  if (typeof source === 'boolean') return source;
  if (typeof source === 'string') return normalizeEnvironment(source) === 'prod';
  if (source) {
    const flag = source.get<unknown>('configuration.isProduction');
    if (typeof flag === 'boolean') return flag;
    const env = source.get<unknown>('process.env.APP_ENV');
    if (typeof env === 'string') return normalizeEnvironment(env) === 'prod';
  }
  // globalThis: this module is part of the browser entry too.
  const env = globalThis.process?.env;
  return normalizeEnvironment(env?.APP_ENV ?? env?.NODE_ENV ?? 'development') === 'prod';
}
