import { GLOBAL } from '../contracts/resource.js';
import { CONDITION_OPS } from './parse.js';
import type { ConditionOp, ParsedCondition } from './parse.js';

/**
 * The residual leaf of one `scope.<type>.<path>` comparison on a request without id (RFC K1b-1).
 * Its `test` asks whether the comparison is TRUE or FALSE on the row, or whether reading the
 * attribute there faults (the check of that row would throw).
 */
export const SCOPE_CONDITION_OP = 'native:condition.scope' as const;

export type ScopeConditionValue = string | number | boolean | readonly (string | number)[];

export type ScopeConditionArgs = { readonly v: 1; readonly test: 'true' | 'false'; readonly type: string; readonly path: string; readonly op: ConditionOp; readonly value: ScopeConditionValue } | { readonly v: 1; readonly test: 'fault'; readonly type: string; readonly path: string };

const COMPARISON_KEYS = ['v', 'test', 'type', 'path', 'op', 'value'];
const FAULT_KEYS = ['v', 'test', 'type', 'path'];
const OPS: ReadonlySet<string> = new Set(CONDITION_OPS);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The value kinds the compiler hands a comparison of `op` (its `operandFits`, after `bindRefs`' value rule). */
function valueFits(op: ConditionOp, v: unknown): v is ScopeConditionValue {
  switch (op) {
    case 'null':
      return typeof v === 'boolean';
    case 'in':
    case 'nin':
      return Array.isArray(v) && v.every((x) => typeof x === 'string' || isFiniteNumber(x));
    case 'like':
    case 'glob':
    case 'wildcard':
      return typeof v === 'string';
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return typeof v === 'string' || isFiniteNumber(v);
    default:
      return typeof v === 'string' || typeof v === 'boolean' || isFiniteNumber(v);
  }
}

/** A frozen copy of well-formed leaf args, else undefined. The in-memory filter and the SQL compilers share it. */
export function parseScopeConditionArgs(args: unknown): ScopeConditionArgs | undefined {
  try {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
    const a = args as Record<string, unknown>;
    const { v, test, type, path } = a;
    if (v !== 1 || typeof type !== 'string' || type === '' || typeof path !== 'string' || path.split('.').some((s) => s === '')) return undefined;
    const keys = Object.keys(a);
    if (test === 'fault') return keys.length === FAULT_KEYS.length && FAULT_KEYS.every((k) => Object.hasOwn(a, k)) ? Object.freeze({ v, test, type, path }) : undefined;
    if (test !== 'true' && test !== 'false') return undefined;
    if (keys.length !== COMPARISON_KEYS.length || !COMPARISON_KEYS.every((k) => Object.hasOwn(a, k))) return undefined;
    const { op, value } = a;
    if (typeof op !== 'string' || !OPS.has(op) || !valueFits(op as ConditionOp, value)) return undefined;
    return Object.freeze({ v, test, type, path, op: op as ConditionOp, value: Array.isArray(value) ? Object.freeze([...value]) : value });
  } catch {
    return undefined;
  }
}

const OPERAND_ROOTS: ReadonlySet<string> = new Set(['principal', 'actor', 'env']);

/** A comparison the compiler turns into leaves under `scopeLeaves`: a `scope.<type>.*` attr (type not `$global`) against a literal or a principal, actor or env ref. */
export function isScopeLeaf(c: ParsedCondition): boolean {
  return c.kind === 'cmp' && c.attr.root === 'scope' && c.attr.scopeType !== GLOBAL.type && (c.operand.kind === 'literal' || OPERAND_ROOTS.has(c.operand.ref.root));
}
