import { Configuration, explicitAppEnv, normalizeEnvironment } from '@spinajs/configuration';
import type { AppEnvSource } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

export type GuardMode = 'throw' | 'warn' | 'off';

/**
 * `test`: throw; `development`: warn once per call site; any other env, or none: off. A development that no env source
 * named is a fallback, so it counts as none and a forgotten env never warns in production.
 */
export function guardMode(config: AppEnvSource | undefined = DI.get(Configuration) as AppEnvSource | undefined): GuardMode {
  const env = explicitAppEnv(config);
  if (env === undefined) return 'off';
  const n = normalizeEnvironment(env);
  return n === 'test' ? 'throw' : n === 'dev' ? 'warn' : 'off';
}
