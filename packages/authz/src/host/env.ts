import { normalizeEnvironment } from '@spinajs/configuration';

/**
 * `flag` is the caller's @Config('configuration.isProduction'). Without a boolean (a Configuration that does not load
 * the shipped configuration module, or a value that never went through its schema) the environment decides.
 */
export function isProduction(flag: boolean | undefined): boolean {
  return typeof flag === 'boolean' ? flag : normalizeEnvironment(process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development') === 'prod';
}
