import './once.js';

export * from './api.js';
export * from './scope-attributes/index.js';
export * from './schema.js';
// api.ts is the frozen contract and keeps its stubs; the implementations shadow them here (an
// explicit export wins over export *), and test/api.test.ts pins that their types equal the contract's.
export { AccessResource, Parent, Owner, Self, registerAccessResource } from './decorators.js';
export { entryOf, classesOf, registeredTypes, typesAbove } from './registry.js';
export type { ResourceEntry, ParentEntry } from './registry.js';
export * from './ancestors/index.js';
export { OrmResourceAdapter } from './adapter.js';
