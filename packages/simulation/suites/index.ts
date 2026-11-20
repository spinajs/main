import type { SuiteRegistry } from '../src/index.js';

export const SUITES: SuiteRegistry = {
  scheduler: async () => (await import('./scheduler.sim.js')).SCHEDULER_SUITE,
  workflow: async () => (await import('./workflow.sim.js')).WORKFLOW_SUITE,
};
