import './once.js';

export * from './api.js';
export * from './scope-attributes/index.js';
export * from './schema.js';
export { AccessResource, Parent, Owner, Self, Relation, registerAccessResource } from './decorators.js';
export { reparent } from './ancestors/reparent.js';
export { entryOf, classesOf, registeredTypes, typesAbove } from './registry.js';
export type { ResourceEntry, ParentEntry } from './registry.js';
export * from './ancestors/index.js';
export { OrmResourceAdapter } from './adapter.js';
// Registers AncestorMiddleware as a QueryMiddleware.
import './ancestors/middleware.js';
export { AncestorMiddleware } from './ancestors/middleware.js';
// Registers AccessGuardMiddleware as a QueryMiddleware.
import './guard/middleware.js';
export { AccessGuardMiddleware } from './guard/middleware.js';
export { guardMode } from './guard/env.js';
// Registers AuthzOrmContributor: the domain boot checks the resource connection.
export { AuthzOrmContributor, checkResourceConnections, storesConnection } from './contributor.js';
export * from './lists/index.js';
