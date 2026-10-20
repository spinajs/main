import { Configuration, normalizeEnvironment } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

export type GuardMode = 'throw' | 'warn' | 'off';

interface ConfigSource {
  get<T>(path: string | string[]): T;
  readonly Env?: unknown;
}

// The rule of authnAppEnv (packages/authn/src/service/boot/env.ts): a development the configuration
// fell back to, which no env source names, counts as unset, so a forgotten env never warns in production.
function appEnv(config: ConfigSource | undefined): string | undefined {
  const env = config?.get<unknown>('process.env.APP_ENV');
  if (typeof env !== 'string') return undefined;
  if (env !== 'development') return env;
  const registered = DI.get<NodeJS.ProcessEnv>('process.env');
  return [config?.Env, registered?.APP_ENV, process.env.APP_ENV, process.env.NODE_ENV].includes('development') ? env : undefined;
}

/** `test`: throw; `development`: warn once per call site; any other env, or none: off. */
export function guardMode(config: ConfigSource | undefined = DI.get(Configuration) as unknown as ConfigSource | undefined): GuardMode {
  const env = appEnv(config);
  if (env === undefined) return 'off';
  const n = normalizeEnvironment(env);
  return n === 'test' ? 'throw' : n === 'dev' ? 'warn' : 'off';
}
