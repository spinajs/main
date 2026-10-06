export * from './api.js';
export * from './scope-attributes/index.js';
export * from './schema.js';
// api.ts is the frozen contract and keeps its stubs; the implementations shadow them here (an
// explicit export wins over export *), and a test pins that their types equal the contract's.
export { AccessResource, Owner, ScopeColumn, OrmScope, registerAccessResource, filterFields, ownsBy } from './implementation.js';
