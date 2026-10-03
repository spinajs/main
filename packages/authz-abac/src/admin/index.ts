/**
 * AuthzAdmin support for ABAC policies: the `policy.put` / `policy.delete` handler, the `policies` reader and
 * the scope.forget forgetter. Importing the package registers all three in root DI.
 *
 * They write to the domain's one writable policy store: the MemoryPolicyStore or DbPolicyStore instance an
 * app passes to `new AbacModel({ stores })`, which it must also register under `PolicyStore` in the domain
 * container (`container.register(() => store).as(PolicyStore)`). Config stores may be registered beside it
 * and are skipped; none or two writable stores make every policy command reject with AuthzConfigError. A put
 * is validated against every AbacModel of the domain (`AbacModel.validate`), so the domain needs one.
 */
export { writableStore } from './common.js';
export type { WritablePolicyStore } from './common.js';
export * from './handler.js';
export * from './reader.js';
export * from './forgetter.js';
