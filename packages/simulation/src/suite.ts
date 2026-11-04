import type { SimEnv } from './env.js';
import { simulate, type SimReport, type SimSystem, type SimulationOptions } from './simulate.js';

export interface SimSuite {
  readonly name: string;
  readonly steps: number;
  readonly options: Omit<SimulationOptions, 'seed' | 'steps' | 'suite'>;
  build(env: SimEnv): Promise<SimSystem>;
}

/** Suites by name; each entry imports its module only when the suite runs. */
export type SuiteRegistry = Record<string, () => Promise<SimSuite>>;

export function runSuite(suite: SimSuite, seed: number, steps: number = suite.steps): Promise<SimReport> {
  return simulate((env) => suite.build(env), { ...suite.options, seed, steps, suite: suite.name });
}
