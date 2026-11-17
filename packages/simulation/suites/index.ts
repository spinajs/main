import type { SuiteRegistry } from '../src/index.js';

export const SUITES: SuiteRegistry = {
  scheduler: async () => (await import('./scheduler.sim.js')).SCHEDULER_SUITE,
  idempotency: async () => (await import('./idempotency.sim.js')).IDEMPOTENCY_SUITE,
};
