/**
 * We export default configuration for webpack modules
 * Normally we load configuration from disk via filesystem
 * But webpack is bundlig all files into one.
 *
 * When we export, we can see configuration variable
 * in webpack module cache and webpack config loader can see it
 */
export { default } from './config/validation.js';
export * from './decorators.js';
export * from './exceptions/index.js';
export * from './sources.js';
export * from './validator.js';
