export * from './api.js';
export * from './http-config.js';
export * from './principals/index.js';
export * from './access/index.js';
export * from './fields.js';
export * from './access/principal-policies.js';
export * from './controllers/AccessController.js';
export * from './explain/index.js';
export * from './swagger.js';

// api.ts holds the frozen signatures as stubs; an explicit export wins over `export *`.
export { Access, AllowAnonymous, Unscoped } from './access/decorators.js';
export { fromBody, fromModel, fromParam, fromQuery } from './access/extractors.js';
export { CurrentPrincipal } from './principals/current-principal.js';
