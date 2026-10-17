import { isProduction as isProductionSource } from '@spinajs/configuration';

/**
 * `flag` is the caller's @Config('configuration.isProduction'). Without a boolean (a Configuration that does not load
 * the shipped configuration module, or a value that never went through its schema) the environment decides.
 */
export function isProduction(flag: boolean | undefined): boolean {
  // The configuration helper reads a string as an env name and a non-null object as a Configuration; an unvalidated
  // flag must be neither.
  return isProductionSource(typeof flag === 'boolean' ? flag : undefined);
}
