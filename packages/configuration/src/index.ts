/**
 * Reexport for simplicity, we dont need to import configuration-common
 * and remember all this packages :)
 */
export * from '@spinajs/configuration-common';
export * from './sources.js';
export * from './manifest-runtime.js';
export * from './manifest-source.js';
export * from './decorators.js';
export * from './configuration.js';
export * from './exception.js';
export * from './schemas.js';
export * from './schemas/system.js';
export * from './helpers.js';
export * from './fp.js';
export * from './lib-dirs.js';
export { merge, mergeArrays, mergeConfig, isComposedConfigArray, COMPOSED_CONFIG_ARRAYS, type ArrayMerge } from './util-common.js';
