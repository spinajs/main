export { hostHarness } from './harness.js';
export * from './configuration.js';
export type { HostHarnessOptions, HostSetup } from './harness.js';
// Under a namespace, so short names such as `config`, `domains` and `instance` stay out of the package root.
export * as testHost from './support.js';
