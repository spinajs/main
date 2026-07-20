/**
 * Browser entry for @spinajs/configuration.
 *
 * Whitelist-only: re-exports the platform-free surface plus the browser
 * Configuration implementation. Deliberately does NOT import ./configuration.js
 * ( path/process/ajv ), ./sources.js ( fs/glob/path ) or ./util.js ( fs/path )
 * so that ajv / glob / fs never enter the browser bundle.
 *
 * The `ajv` import in ./exception.js is type-only and is elided at emit.
 */
export * from '@spinajs/configuration-common';
export * from './decorators.js';
export * from './exception.js';
export * from './fp.js';
export * from './configuration.browser.js';
