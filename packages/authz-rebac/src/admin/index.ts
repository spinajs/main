/**
 * AuthzAdmin support for ReBAC tuples: the tuple.write / tuple.delete handler, the `tuples` reader and the
 * scope.forget forgetter. Importing the package registers them in root DI. They write to the TupleStore
 * registered in the domain container (`container.register(() => store).as(TupleStore)`), the one the
 * domain's RebacModel reads; none or two writable stores make every tuple command reject with AuthzConfigError.
 */
export { writableStore } from './common.js';
export type { WritableTupleStore } from './common.js';
export * from './handler.js';
export * from './reader.js';
export * from './forgetter.js';
