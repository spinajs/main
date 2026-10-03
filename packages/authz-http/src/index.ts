export * from './api.js';
export * from './http-config.js';
export * from './principals/index.js';
export * from './access/index.js';

// api.ts holds the frozen signatures as stubs; an explicit export wins over `export *`.
export { Access, AllowAnonymous, Unscoped } from './access/decorators.js';
