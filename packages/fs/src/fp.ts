import { _resolve } from '@spinajs/di';

/**
 * Gets filesystem by its name
 * 
 * @param name filesystem name ( must be defined in config file)
 * @returns 
 */
export function _fs(name: string) {
  return _resolve('__file_provider__', [name]);
}
