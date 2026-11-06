import type { ConformanceCase } from '../src/index.js';
import { AGGREGATE_CASES } from './aggregate.case.js';
import { EXPRESSION_CASES } from './expressions.case.js';
import { INTROSPECTION_CASES } from './introspection.case.js';
import { JOIN_CASES } from './join.case.js';
import { NULL_CASES } from './null.case.js';
import { ORDER_CASES } from './order.case.js';
import { POPULATE_CASES } from './populate.case.js';
import { TYPE_CASES } from './types.case.js';
import { WHERE_CASES } from './where.case.js';
import { WRITE_CASES } from './write.case.js';

export const CASES: readonly ConformanceCase[] = [...WHERE_CASES, ...NULL_CASES, ...ORDER_CASES, ...JOIN_CASES, ...POPULATE_CASES, ...AGGREGATE_CASES, ...TYPE_CASES, ...WRITE_CASES, ...INTROSPECTION_CASES, ...EXPRESSION_CASES];

const seen = new Set<string>();
for (const c of CASES) {
  if (seen.has(c.name)) {
    throw new Error(`conformance case ${c.name} is defined twice`);
  }
  seen.add(c.name);
}
