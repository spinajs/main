import type { ConformanceCase } from '../src/index.js';
import { WHERE_CASES } from './where.case.js';

export const CASES: readonly ConformanceCase[] = [...WHERE_CASES];

const seen = new Set<string>();
for (const c of CASES) {
  if (seen.has(c.name)) {
    throw new Error(`conformance case ${c.name} is defined twice`);
  }
  seen.add(c.name);
}
