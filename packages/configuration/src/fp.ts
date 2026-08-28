import { Class } from '@spinajs/di';
import { cfg, service } from './helpers.js';

/**
 *
 * Get configuration value from path
 *
 * Kept for compatibility - delegates to the imperative {@link cfg}.
 *
 * @param path
 * @returns
 */
export function _cfg<T>(path: string, defaultValue?: T) {
  return () => cfg<T>(path, defaultValue);
}

/**
 * Resolves service from DI container base on path from configuration
 * eg. _service("email.smtp") will resolve service from DI container registered at "email.smtp" path in configuration
 *
 * Kept for compatibility - delegates to the imperative {@link service}.
 *
 * @param path
 * @returns
 */
export function _service<T>(path: string, type: Class<T>, options?: []): () => Promise<T> {
  return () => service<T>(path, type, options);
}
