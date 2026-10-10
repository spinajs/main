import type { ConditionOp, ResourceType, ScopeConditionArgs } from '@spinajs/authz';

import { attrLookup } from './attributes.js';
import type { RbacScopeDefaults } from './attributes.js';
import type { RbacSqlDialect } from './dialect.js';
import { UNKNOWN_SQL, all, any, constant, flip, inexact, neg } from './kleene.js';
import type { Bound } from './kleene.js';
import type { RbacPathSql } from './path.js';
import { FALSE_SQL, ident, rsql } from './sql.js';
import type { RbacSql } from './sql.js';

/** A scope attribute as the comparisons read it: the scalar's JSON text and its exact number (`RbacAttrSql`). */
export interface RbacScopeValueSql {
  readonly json: RbacSql;
  readonly num: RbacSql;
}

const DIGITS = ['-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const ORDER: Readonly<Record<string, (a: RbacSql, b: RbacSql) => RbacSql>> = {
  lt: (a, b) => rsql`${a} < ${b}`,
  lte: (a, b) => rsql`${a} <= ${b}`,
  gt: (a, b) => rsql`${a} > ${b}`,
  gte: (a, b) => rsql`${a} >= ${b}`,
};

const numericString = (s: string): number | undefined => {
  const n = Number(s);
  return Number.isFinite(n) && String(n) === s ? n : undefined;
};

const isScalar = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

function literalList(v: unknown): (string | number)[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: (string | number)[] = [];
  for (let i = 0; i < v.length; i++) {
    const x: unknown = v[i];
    if (!(i in v) || !(typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)))) return undefined;
    out.push(x);
  }
  return out;
}

/**
 * A comparison of a present scope attribute with a literal as the engine's `cmp` (engine/evaluate.ts) decides it:
 * exact, or NULL where the engine is UNKNOWN too, or `inexact(bound)` where the engine decides and the JSON text
 * cannot tell how. Not two-valued; it reads no presence (a missing or null attribute faults before any comparison).
 */
export function scopeCmpSql(op: ConditionOp, lit: unknown, value: RbacScopeValueSql, dialect: RbacSqlDialect, bound?: Bound): RbacSql {
  const j = value.json;
  const x = inexact(bound);
  // The engine orders strings by code points and reads a numeric string as a number; the JSON text keeps neither.
  const string = (): RbacSql => (x === UNKNOWN_SQL ? UNKNOWN_SQL : rsql`(CASE WHEN ${isString(j)} THEN ${x} END)`);
  switch (op) {
    case 'null':
      // A present attribute is not null (a null one faults).
      return constant(lit === false);
    case 'in':
    case 'nin': {
      const list = literalList(lit);
      if (list === undefined) return UNKNOWN_SQL;
      if (list.length === 0) return constant(op === 'nin');
      const found = any(...list.map((item) => equals(value, item, dialect, op === 'in' ? bound : flip(bound))));
      return op === 'in' ? found : neg(found);
    }
    case 'eq':
    case 'ne': {
      if (!isScalar(lit)) return UNKNOWN_SQL;
      const eq = equals(value, lit, dialect, op === 'eq' ? bound : flip(bound));
      return op === 'eq' ? eq : neg(eq);
    }
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      if (typeof lit !== 'number' && typeof lit !== 'string') return UNKNOWN_SQL;
      const n = typeof lit === 'number' ? lit : numericString(lit);
      if (n === undefined || !Number.isFinite(n)) return string();
      const literal = dialect.number(rsql`${String(n)}`);
      const exact = rsql`${isNumber(j)} AND ${shortNumber(j, dialect)}`;
      const cmp = ORDER[op](value.num, literal);
      return x === UNKNOWN_SQL ? rsql`(CASE WHEN ${exact} THEN ${cmp} END)` : rsql`(CASE WHEN ${exact} THEN ${cmp} WHEN ${isNumber(j)} OR ${isString(j)} THEN ${x} END)`;
    }
    case 'like':
    case 'glob':
    case 'wildcard':
      return typeof lit === 'string' ? string() : UNKNOWN_SQL;
    default:
      return UNKNOWN_SQL;
  }
}

/**
 * The engine's `eq` after `coerce` of a scalar JSON text and a literal, three-valued. A string attribute against
 * a number is TRUE when it is the number's own text; the engine also says FALSE for another numeric string, which
 * SQL cannot tell from a non-numeric one (UNKNOWN in the engine). Strings compare as `JSON.stringify` writes them
 * (DbScopeAttributeStore, schema defaults): a stored string holding an escape may spell the literal another way,
 * so only its exact text decides it. Numbers compare by value (`numberIs`), whatever their text.
 */
function equals(value: RbacScopeValueSql, lit: string | number | boolean, dialect: RbacSqlDialect, bound: Bound): RbacSql {
  const j = value.json;
  const x = inexact(bound);
  const same = (text: string): RbacSql => rsql`(${dialect.sameText(j, rsql`${text}`)})`;
  if (typeof lit === 'string') {
    const n = numericString(lit);
    const str = any(same(JSON.stringify(lit)), all(rsql`(${dialect.contains(j, rsql`${'\\'}`)})`, x));
    return rsql`(CASE WHEN ${isString(j)} THEN ${str} WHEN ${isNumber(j)} THEN ${n === undefined ? UNKNOWN_SQL : numberIs(value, n, dialect, bound)} END)`;
  }
  if (typeof lit === 'number') {
    const bool = lit === 0 || lit === 1 ? same(lit === 1 ? 'true' : 'false') : UNKNOWN_SQL;
    return rsql`(CASE WHEN ${isNumber(j)} THEN ${numberIs(value, lit, dialect, bound)} WHEN ${isString(j)} THEN ${any(same(JSON.stringify(String(lit))), x)} WHEN ${isBoolean(j)} THEN ${bool} END)`;
  }
  // A number attribute coerces against a boolean only as 0 or 1: any other short number falls through to NULL.
  const num = value.num;
  const short = shortNumber(j, dialect);
  return rsql`(CASE WHEN ${isBoolean(j)} THEN ${same(String(lit))} WHEN ${isNumber(j)} AND ${short} AND ${num} = 1 THEN ${constant(lit)} WHEN ${isNumber(j)} AND ${short} AND ${num} = 0 THEN ${constant(!lit)} WHEN ${isNumber(j)} AND ${neg(short)} THEN ${x} END)`;
}

/** A number attribute equals `n` as the engine's doubles do; a text `shortNumber` refuses is undecided. */
function numberIs(value: RbacScopeValueSql, n: number, dialect: RbacSqlDialect, bound: Bound): RbacSql {
  const short = shortNumber(value.json, dialect);
  return any(all(short, rsql`(${value.num} = ${dialect.number(rsql`${String(n)}`)})`), all(neg(short), inexact(bound)));
}

/**
 * A JSON number text SQL compares as the engine compares its double: at most 15 characters and no exponent, so at
 * most 15 significant digits in the normal range, where distinct decimals are distinct doubles (DBL_DIG) and
 * Postgres' NUMERIC and SQLite's REAL agree with the engine. A longer text (`3.0000000000000001` is the double 3)
 * is left undecided.
 */
function shortNumber(j: RbacSql, dialect: RbacSqlDialect): RbacSql {
  return rsql`(LENGTH(${j}) <= 15 AND NOT (${dialect.contains(j, rsql`${'e'}`)}) AND NOT (${dialect.contains(j, rsql`${'E'}`)}))`;
}

const isString = (j: RbacSql): RbacSql => rsql`(SUBSTR(${j}, 1, 1) = ${'"'})`;

const isNumber = (j: RbacSql): RbacSql => rsql`(SUBSTR(${j}, 1, 1) IN (${DIGITS}))`;

const isBoolean = (j: RbacSql): RbacSql => rsql`(${j} IN (${['true', 'false']}))`;

/** What the leaf of one `native:condition.scope` term reads, for rows of one model on one connection. */
export interface RbacScopeLeafContext {
  readonly path: RbacPathSql;
  readonly rowType: ResourceType;
  /** As the compiler's `scopeDefaults` gives them: the row type's `exists` is replaced here (`withOwnRow`). */
  readonly defaults: RbacScopeDefaults;
  readonly dialect: RbacSqlDialect;
}

const LEAF = 'authz_v';

/**
 * The `native:condition.scope` leaf (RFC K1b-1) as a 1/0 flag under `whenFoundFlag`: `fault` is 1 where the
 * attribute is not present (also where SQL cannot read its layer: narrower), `true` / `false` where it is present
 * and `scopeCmpSql` without a bound is TRUE / FALSE. Where SQL cannot tell, both are 0, so the residual's
 * `true OR (NOT false AND UNKNOWN)` is the UNKNOWN its polarity binds: never wider.
 */
export function scopeConditionSql(args: ScopeConditionArgs, at: RbacScopeLeafContext): RbacSql {
  // As RbacRulesSql: the row type's node is the filtered row itself.
  const own = at.path.nearestIndex(at.rowType);
  const defaults = at.defaults.withOwnRow(at.rowType, () => (own === undefined ? FALSE_SQL : rsql`(${own} = 0)`));
  const lookup = attrLookup(at.path, args.type, args.path, defaults, at.dialect);
  const present = lookup.present(LEAF);
  let hit: RbacSql;
  if (args.test === 'fault') hit = neg(present);
  else {
    const truth = scopeCmpSql(args.op, args.value, { json: lookup.json(LEAF), num: lookup.num(LEAF) }, at.dialect);
    hit = all(present, args.test === 'true' ? truth : neg(truth));
  }
  return at.path.whenFoundFlag(rsql`(SELECT CASE WHEN ${hit} THEN 1 ELSE 0 END FROM (${lookup.table}) ${ident(LEAF)}${at.dialect.fence})`);
}
