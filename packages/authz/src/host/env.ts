import { DI } from '@spinajs/di';
import { Configuration, normalizeEnvironment } from '@spinajs/configuration';

export function isProduction(): boolean {
  // Never resolve here: creating a Configuration is not this helper's job.
  if (DI.has(Configuration)) {
    try {
      const flag = DI.get(Configuration)?.get<unknown>('configuration.isProduction');
      if (typeof flag === 'boolean') return flag;
    } catch {
      // fall back to the environment
    }
  }
  return normalizeEnvironment(process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development') === 'prod';
}
