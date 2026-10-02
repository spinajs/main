import { AssertionError } from 'node:assert';
import * as fc from 'fast-check';

import { CORE_FILTER_OPS, principalKey, resourceKey } from '@spinajs/authz';
import type { DecisionRequest, ResourceFilter } from '@spinajs/authz';

/** One conformance check; `run` rejects with an AssertionError when the implementation breaks the contract. */
export interface ConformanceCheck<Id extends string = string> {
  readonly id: Id;
  readonly title: string;
  run(): Promise<void>;
}

export interface PropertyRunOptions {
  readonly numRuns?: number;
  /** fast-check seed, for replaying a failure. */
  readonly seed?: number;
}

/** `now` of every context the suites build, unless the world sets one: answers must not depend on the wall clock. */
export const CONFORMANCE_NOW: Date = new Date('2026-01-01T00:00:00.000Z');

export function fail(message: string): never {
  throw new AssertionError({ message });
}

export function check(condition: unknown, message: string | (() => string)): asserts condition {
  if (!condition) fail(typeof message === 'string' ? message : message());
}

// fc.check rather than fc.assert: the failure keeps the AssertionError message of the predicate at the top.
export async function property<T>(what: string, arb: fc.Arbitrary<T>, predicate: (value: T) => Promise<void>, opts: PropertyRunOptions): Promise<void> {
  const details = await fc.check(
    fc.asyncProperty(arb, async (v) => {
      await predicate(v);
    }),
    { numRuns: opts.numRuns, ...(opts.seed === undefined ? {} : { seed: opts.seed }) },
  );
  if (!details.failed) return;
  const cause = details.errorInstance;
  const message = cause instanceof Error ? cause.message : String(cause);
  fail(`${what}\n${message}\nreplay with { seed: ${details.seed} }`);
}

/** Fisher-Yates over mulberry32, so a fast-check integer fixes the order. */
export function shuffler(seed: number): <T>(items: readonly T[]) => T[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
}

export const identityOrder = <T>(items: readonly T[]): T[] => [...items];

export const isThenable = (v: unknown): v is PromiseLike<unknown> => v !== null && (typeof v === 'object' || typeof v === 'function') && typeof (v as { then?: unknown }).then === 'function';

export const isFilterOp = (op: unknown): boolean => typeof op === 'string' && ((CORE_FILTER_OPS as readonly string[]).includes(op) || /^native:\S+$/.test(op));

/** The ops of a filter tree; throws an AssertionError on a malformed node. */
export function opsOf(f: ResourceFilter, where: string, out: Set<string> = new Set()): Set<string> {
  const node = f as unknown as Record<string, unknown> | null;
  check(node !== null && typeof node === 'object' && typeof node.op === 'string', () => `${where}: not a filter node: ${show(f)}`);
  out.add(node.op as string);
  switch (node.op) {
    case 'true':
    case 'false':
      break;
    case 'and':
    case 'or':
      check(Array.isArray(node.args), () => `${where}: '${node.op}' without an args array`);
      for (const a of node.args as ResourceFilter[]) opsOf(a, where, out);
      break;
    case 'not':
      opsOf(node.arg as ResourceFilter, where, out);
      break;
    case 'cmp':
      check(typeof node.field === 'string' && typeof node.cmp === 'string', () => `${where}: malformed cmp ${show(f)}`);
      break;
    case 'relation':
      check(typeof node.relation === 'string', () => `${where}: malformed relation ${show(f)}`);
      break;
    case 'under':
      check(Array.isArray(node.scopes), () => `${where}: malformed under ${show(f)}`);
      break;
    default:
      check(/^native:\S+$/.test(node.op as string), () => `${where}: unknown op ${JSON.stringify(node.op)}`);
  }
  return out;
}

export function show(v: unknown, max = 800): string {
  let s: string;
  try {
    s = JSON.stringify(v, (_k, x) => (x instanceof Date ? x.toISOString() : typeof x === 'symbol' ? String(x) : x)) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

export const describeRequest = (req: Pick<DecisionRequest, 'principal' | 'permission' | 'resource' | 'subject'>): string => `${principalKey(req.principal)} ${req.permission} on ${resourceKey(req.resource)}${req.subject === undefined ? '' : ' with subject'}`;

export const pick = <T>(items: readonly T[], n: number): T => items[n % items.length];
