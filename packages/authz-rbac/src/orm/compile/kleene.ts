import { FALSE_SQL, TRUE_SQL, joinSql, rsql } from './sql.js';
import type { RbacSql } from './sql.js';

// A boolean NULL on both dialects (Postgres types a CASE by its branches).
export const UNKNOWN_SQL: RbacSql = rsql`(CASE WHEN 1 = 0 THEN 1 = 1 END)`;

/**
 * What a leaf the evaluator decides but SQL cannot reads as: UNKNOWN, or, for a restrict's bounds, the value
 * that raises ('hi') or lowers ('lo') the whole condition, flipped under each NOT.
 */
export type Bound = 'hi' | 'lo' | undefined;
export const flip = (b: Bound): Bound => (b === 'hi' ? 'lo' : b === 'lo' ? 'hi' : undefined);
export const inexact = (b: Bound): RbacSql => (b === 'hi' ? TRUE_SQL : b === 'lo' ? FALSE_SQL : UNKNOWN_SQL);

// SQLite's parser has a fixed stack: a junction nested in one of the same kind joins it, and an operand that
// already brackets itself gets no second pair.
const junctions = new WeakMap<RbacSql, { readonly op: 'AND' | 'OR'; readonly items: readonly RbacSql[] }>();

/** The SQL is one bracket pair around everything. */
function bracketed(x: RbacSql): boolean {
  let depth = 0;
  let first = true;
  let closedAtEnd = false;
  for (const p of x.parts) {
    if (typeof p !== 'string') {
      if (depth === 0) return false;
      first = false;
      closedAtEnd = false;
      continue;
    }
    for (const ch of p) {
      if (first && ch !== '(') return false;
      first = false;
      if (depth === 0 && closedAtEnd) return false;
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        closedAtEnd = depth === 0;
        continue;
      }
      closedAtEnd = false;
    }
  }
  return !first && depth === 0 && closedAtEnd;
}

export const wrap = (x: RbacSql): RbacSql => (bracketed(x) ? x : rsql`(${x})`);

function junction(op: 'AND' | 'OR', xs: readonly RbacSql[]): RbacSql {
  const items = xs.flatMap((x) => {
    const j = junctions.get(x);
    return j?.op === op ? j.items : [x];
  });
  if (items.length === 1) return items[0];
  const out = rsql`(${joinSql(items.map(wrap), ` ${op} `)})`;
  junctions.set(out, { op, items });
  return out;
}

export function all(...xs: readonly RbacSql[]): RbacSql {
  if (xs.includes(FALSE_SQL)) return FALSE_SQL;
  const kept = xs.filter((x) => x !== TRUE_SQL);
  return kept.length === 0 ? TRUE_SQL : junction('AND', kept);
}

export function any(...xs: readonly RbacSql[]): RbacSql {
  if (xs.includes(TRUE_SQL)) return TRUE_SQL;
  const kept = xs.filter((x) => x !== FALSE_SQL);
  return kept.length === 0 ? FALSE_SQL : junction('OR', kept);
}

// EXISTS terms (`existsTerm`), so NOT takes them without another bracket pair.
const existsTerms = new WeakMap<RbacSql, RbacSql>();

/** `(EXISTS sub)`, which `neg` turns into `(NOT EXISTS sub)`. */
export function existsTerm(sub: RbacSql): RbacSql {
  const exists = rsql`(EXISTS ${sub})`;
  existsTerms.set(exists, sub);
  return exists;
}

export const neg = (x: RbacSql): RbacSql => {
  if (x === TRUE_SQL) return FALSE_SQL;
  if (x === FALSE_SQL) return TRUE_SQL;
  const sub = existsTerms.get(x);
  return sub ? rsql`(NOT EXISTS ${sub})` : rsql`(NOT ${wrap(x)})`;
};

export const constant = (b: boolean): RbacSql => (b ? TRUE_SQL : FALSE_SQL);
