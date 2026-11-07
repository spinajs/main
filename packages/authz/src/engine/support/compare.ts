import type { Decision } from '../../contracts/decision.js';
import { subtractFieldGlobs } from '../../contracts/fields.js';
import { isObject } from '../internal/util.js';
import { NO_FIELDS } from '../types.js';
import type { Checked, Fields } from '../types.js';

// Residuals are engine copies within the vote budgets; past this a walk fails closed (no cover).
export const COMPARE_NODES = 100_000;
export const COMPARE_DEPTH = 256;

/**
 * `big` covers `small`: nothing to cover, or `big` is unconditional or the
 * same tree without a relation or native node (those mean the current
 * principal, so equal trees still differ), and `small`'s fields are inside
 * `bigFields` (by default `big`'s). Throws AuthzConfigError when the field
 * budget runs out.
 */
export function entryCovers(big: Decision, small: Decision, bigFields: Fields = big.fields): boolean {
  if (!small.allowed) return true;
  if (!big.allowed) return false;
  if (big.residual.op !== 'true' && (readsPrincipal(big.residual, 0, { left: COMPARE_NODES }) || !sameTree(big.residual, small.residual, 0, { left: COMPARE_NODES }))) return false;
  return subtractFieldGlobs(small.fields.read, bigFields.read).length === 0 && subtractFieldGlobs(small.fields.write, bigFields.write).length === 0;
}

/** A holder check of covers; none recorded (not a firm run) counts as no field. */
export function firmFieldsOf(holder: Checked): Fields {
  return holder.firmFields ?? NO_FIELDS;
}

export function readsPrincipal(f: unknown, depth: number, nodes: { left: number }): boolean {
  if (--nodes.left < 0 || depth > COMPARE_DEPTH || !isObject(f)) return true;
  const op = f.op;
  if (op === 'relation' || (typeof op === 'string' && op.startsWith('native:'))) return true;
  if (op === 'and' || op === 'or') return !Array.isArray(f.args) || f.args.some((x) => readsPrincipal(x, depth + 1, nodes));
  if (op === 'not') return readsPrincipal(f.arg, depth + 1, nodes);
  return false;
}

export function sameTree(a: unknown, b: unknown, depth: number, nodes: { left: number }): boolean {
  if (--nodes.left < 0 || depth > COMPARE_DEPTH) return false;
  if (a === b) return true;
  if (!isObject(a) || !isObject(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.hasOwn(b, k) && sameTree(a[k], b[k], depth + 1, nodes));
}
