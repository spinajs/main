export * from './api.js';
export * from './http-config.js';
export * from './domains.js';
export * from './principals/index.js';
export * from './access/index.js';

// api.ts holds the frozen signatures as stubs; these explicit exports put the implementations in
// their place (an explicit export wins over `export *`).
export { Access, AllowAnonymous, Unscoped } from './access/decorators.js';
