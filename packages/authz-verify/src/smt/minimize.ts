import type { PolicyIR, Truth } from '@spinajs/authz-ir';
import type { Permission } from '@spinajs/authz';

import { outcome } from '../witness.js';
import type { Scenario } from '../witness.js';

/** The answer each permission must keep. */
export type Expectation = Readonly<Record<Permission, Truth>>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function keeps(ir: PolicyIR, s: Scenario, expected: Expectation): Promise<boolean> {
  const got = await outcome(ir, s, Object.keys(expected));
  return Object.entries(expected).every(([p, truth]) => got[p] === truth);
}

/** Every leaf of the context, as a path. */
function leaves(v: Record<string, unknown>, prefix: string[] = []): string[][] {
  return Object.entries(v).flatMap(([k, x]) => (isRecord(x) ? leaves(x, [...prefix, k]) : [[...prefix, k]]));
}

function without(v: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
  const [head, ...rest] = path;
  const out = { ...v };
  if (rest.length === 0) delete out[head];
  else if (isRecord(out[head])) out[head] = without(out[head], rest);
  if (isRecord(out[head]) && Object.keys(out[head]).length === 0) delete out[head];
  return out;
}

/**
 * Delta debugging against the reference evaluator: drops one tuple, then one context value, at a time while the
 * scenario still gives exactly the expected answers, until nothing more can go (1-minimal).
 */
export async function minimize(ir: PolicyIR, s: Scenario, expected: Expectation): Promise<Scenario> {
  let current = s;
  for (let i = 0; i < current.tuples.length; ) {
    const next: Scenario = { ...current, tuples: current.tuples.filter((_, j) => j !== i) };
    if (await keeps(ir, next, expected)) current = next;
    else i++;
  }
  if (current.context === undefined) return current;
  let context = current.context as Record<string, unknown>;
  for (const path of leaves(context)) {
    const next = without(context, path);
    if (await keeps(ir, { ...current, context: next }, expected)) context = next;
  }
  if (Object.keys(context).length === 0) return { principal: current.principal, resource: current.resource, tuples: current.tuples };
  return { ...current, context };
}
