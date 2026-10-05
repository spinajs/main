import { normalizeEnvironment } from '@spinajs/configuration';

/**
 * `flag` is the caller's @Config('configuration.isProduction'). Without it (a Configuration that does not load the
 * shipped configuration module, such as a test one) the environment decides, which a schema cannot read.
 */
export function isProduction(flag: boolean | undefined): boolean {
  return flag ?? normalizeEnvironment(process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development') === 'prod';
}
