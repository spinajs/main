import { AuthzConfigError } from '@spinajs/authz';
import type { Permission } from '@spinajs/authz';

import { attrOfRef } from './attributes.js';
import type { RbacScopeDefaults } from './attributes.js';
import type { RbacSqlDialect } from './dialect.js';
import type { RbacPathSql } from './path.js';
import { FALSE_SQL, andSql, ident, intSql, joinSql, orSql, outer, rsql } from './sql.js';
import type { RbacSql } from './sql.js';

// Blocks over an `authz_rule` row under an alias (its SQL form: L2's rule-sql-form.ts). The engine's
// semantics they follow: conditions/compiler.ts (`scopeValue`, B39) and engine/evaluate.ts (`coerce`,
// the matchers); L1b's rule steps for permissions.

// The derived tables and sub-queries of the blocks; a rule alias of the same name would be shadowed inside them.
const INTERNAL_ALIASES = ['authz_t', 'authz_y', 'authz_x', 'authz_z', 'authz_w', 'authz_sa'];

const column = (r: string, name: string): RbacSql => {
  if (typeof r !== 'string' || r === '') throw new AuthzConfigError('authz-rbac rule sql: a rule alias must be a non-empty name');
  if (INTERNAL_ALIASES.includes(r.toLowerCase())) throw new AuthzConfigError(`authz-rbac rule sql: the rule alias "${r}" is used inside the blocks; take another one`);
  return rsql`${ident(r, name)}`;
};

const TRUE = rsql`(1 = 1)`;
const FALSE = rsql`(1 = 0)`;

/** The JSON kinds of `when_value` and the attribute: string, boolean or number (null and other shapes are none). */
const isString = (json: RbacSql): RbacSql => rsql`SUBSTR(${json}, 1, 1) = ${'"'}`;
const isBoolean = (json: RbacSql): RbacSql => rsql`${json} IN (${['true', 'false']})`;
const isNumber = (json: RbacSql): RbacSql => rsql`SUBSTR(${json}, 1, 1) IN (${['-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']})`;

/**
 * The core's `eq` after `coerce`, both sides scalar JSON texts written by JSON.stringify. Same kinds compare
 * as texts (JSON.stringify is canonical for each). A boolean against 0/1 coerces. A string against a number:
 * TRUE when the string is the number's own text; otherwise the core compares numbers only for a canonical
 * numeric string, which SQL cannot read, so NULL (the core says FALSE or UNKNOWN there). Anything else is
 * UNKNOWN.
 */
function equals(j: RbacSql, v: RbacSql): RbacSql {
  return rsql`CASE
    WHEN ${isString(v)} THEN (CASE WHEN ${isString(j)} THEN ${j} = ${v} WHEN ${isNumber(j)} THEN (CASE WHEN ${v} = ${'"'} || ${j} || ${'"'} THEN ${TRUE} END) END)
    WHEN ${isBoolean(v)} THEN (CASE WHEN ${isBoolean(j)} THEN ${j} = ${v} WHEN ${j} = ${'1'} THEN ${v} = ${'true'} WHEN ${j} = ${'0'} THEN ${v} = ${'false'} END)
    WHEN ${isNumber(v)} THEN (CASE WHEN ${isNumber(j)} THEN ${j} = ${v} WHEN ${isString(j)} THEN (CASE WHEN ${j} = ${'"'} || ${v} || ${'"'} THEN ${TRUE} END) WHEN ${v} = ${'1'} THEN ${j} = ${'true'} WHEN ${v} = ${'0'} THEN ${j} = ${'false'} END)
  END`;
}

const ORDER = {
  lt: (a: RbacSql, b: RbacSql) => rsql`${a} < ${b}`,
  lte: (a: RbacSql, b: RbacSql) => rsql`${a} <= ${b}`,
  gt: (a: RbacSql, b: RbacSql) => rsql`${a} > ${b}`,
  gte: (a: RbacSql, b: RbacSql) => rsql`${a} >= ${b}`,
};

/**
 * `scope.<type>.<path> <op> <literal>` of the rule (`when_path`, `when_op`, `when_value`), per row, THREE-valued:
 * TRUE and FALSE as the core decides, NULL where the core is UNKNOWN or faults. Faults (B39: no node of the
 * type on the row's path, no value and no default, or null) are NULL here; `storedWhenMissing` tells them apart.
 * `when_path` NULL is TRUE (no condition).
 *
 * NULL also where the core decides but SQL cannot: a string attribute against a number literal (see
 * `equals`; for the order ops always), an order op on two strings (toSqlForm refuses string literals there),
 * and a path below a list default (read as missing). Numbers compare exactly: the attribute is read from
 * `value_json`, not `value_num`, which Postgres rounds to 6 decimals.
 *
 * A caller decides what NULL means: in a restrict or cap `when` the rule applies (COALESCE(…, TRUE)), in a
 * threshold `when` it denies; UNKNOWN never turns into access.
 */
export function storedWhen(r: string, path: RbacPathSql, defaults: RbacScopeDefaults, dialect: RbacSqlDialect): RbacSql {
  const whenPath = column(r, 'when_path');
  const op = column(r, 'when_op');
  const v = column(r, 'when_value');
  const w = (c: string): RbacSql => rsql`${ident('authz_w', c)}`;
  const json = w('json');
  const ordered = Object.entries(ORDER).map(([name, order]) => rsql`WHEN ${op} = ${name} THEN (CASE WHEN ${isNumber(v)} AND ${isNumber(json)} THEN ${order(w('num'), dialect.number(v))} END)`);
  const decide = rsql`CASE
    WHEN ${w('present')} = 0 THEN NULL
    WHEN ${op} = ${'null'} THEN (CASE WHEN ${v} = ${'true'} THEN ${FALSE} WHEN ${v} = ${'false'} THEN ${TRUE} END)
    WHEN ${json} IS NULL THEN NULL
    WHEN ${op} = ${'eq'} THEN ${equals(json, v)}
    WHEN ${op} = ${'ne'} THEN NOT (${equals(json, v)})
    ${ordered[0]} ${ordered[1]} ${ordered[2]} ${ordered[3]}
  END`;
  return rsql`(CASE WHEN ${whenPath} IS NULL THEN ${TRUE} ELSE (SELECT ${decide} FROM ${attrOfRef(path, whenPath, defaults, dialect).row} ${ident('authz_w')}) END)`;
}

/**
 * Two-valued: the rule's `when` reads an attribute the core cannot read, so the core faults (B39): the row has
 * no node of the type, the value is missing with no default or is null; also a path below a list default. A
 * faulting rule refuses the row in L1b's evaluation (route term FALSE, threshold term TRUE).
 */
export function storedWhenMissing(r: string, path: RbacPathSql, defaults: RbacScopeDefaults, dialect: RbacSqlDialect): RbacSql {
  const whenPath = column(r, 'when_path');
  return rsql`(${whenPath} IS NOT NULL AND NOT ${attrOfRef(path, whenPath, defaults, dialect).present})`;
}

/**
 * The core's evaluation of a residual leaf takes at most 4e6 pattern × text steps and a budget of 8e6 units, in
 * UTF-16 units. The pattern has at most LENGTH(resource_like) + 1 code points (a trailing `**` is one `%`), so
 * with each side at most twice its code points in UTF-16, `t <= 1e6 / (LENGTH(resource_like) + 1)` keeps both
 * limits; above it the answer is NULL. Integer division keeps the sum in 32 bits.
 */
const withinWork = (text: RbacSql, r: string): RbacSql => rsql`LENGTH(${text}) <= ${intSql(1_000_000)} / (LENGTH(${column(r, 'resource_like')}) + 1)`;

function patternMatch(r: string, text: RbacSql, dialect: RbacSqlDialect): RbacSql {
  if (dialect.name === 'sqlite') {
    const glob = column(r, 'resource_glob');
    const notGlob = column(r, 'resource_not_glob');
    // GLOB reads text up to the first NUL (F3); the core reads all of it. A non-text value is UNKNOWN in the core.
    const readable = andSql(rsql`typeof(${text}) = ${'text'}`, rsql`instr(${text}, char(0)) = 0`, rsql`instr(${glob}, char(0)) = 0`, rsql`(${notGlob} IS NULL OR instr(${notGlob}, char(0)) = 0)`, withinWork(text, r));
    return rsql`(CASE WHEN ${readable} THEN (${text} GLOB ${glob} AND (${notGlob} IS NULL OR NOT (${text} GLOB ${notGlob}))) END)`;
  }
  const like = column(r, 'resource_like');
  const notLike = column(r, 'resource_not_like');
  return rsql`(CASE WHEN ${text} IS NOT NULL AND ${withinWork(text, r)} THEN (${text} LIKE ${like} ESCAPE ${'\\'} AND (${notLike} IS NULL OR NOT (${text} LIKE ${notLike} ESCAPE ${'\\'}))) END)`;
}

/** A model property the adapter reads as `resource.<field>`, and the string column that holds it. */
export interface RbacResourceField {
  readonly field: string;
  readonly column: string;
}

/**
 * The rule's `resource` pattern (`resource_field` and the LIKE / GLOB columns) on the filtered row, THREE-valued:
 * TRUE or FALSE as the core's glob / wildcard, NULL where the core is UNKNOWN (the value is not a string, the
 * field is no column the adapter reads, the work cap) and where SQLite's GLOB cannot read the value (NUL).
 * `fields` pairs each field the adapter reads (`resource_field` holds it) with its string column; another field
 * reads nothing (NULL). `resource_field` NULL is TRUE.
 * A threshold `resource` that is NULL denies; a restrict or cap applies.
 */
export function storedResource(r: string, fields: readonly RbacResourceField[], dialect: RbacSqlDialect): RbacSql {
  const field = column(r, 'resource_field');
  const whens = fields.map((f) => {
    if (f === null || typeof f !== 'object' || typeof f.field !== 'string' || f.field === '') throw new AuthzConfigError('authz-rbac rule sql: a resource field needs a name and a column');
    return rsql`WHEN ${field} = ${f.field} THEN ${patternMatch(r, rsql`${outer(f.column)}`, dialect)}`;
  });
  return rsql`(CASE WHEN ${field} IS NULL THEN ${TRUE} ${joinSql(whens, ' ')} END)`;
}

/**
 * Two-valued: the threshold's `permissions` list names `permission` or `*`. No list (NULL) matches nothing:
 * L1b expands `permissions ?? []`. `*` stands for every registered permission, so `permission` must be one.
 */
export function storedPermission(r: string, permission: Permission, dialect: RbacSqlDialect): RbacSql {
  const list = column(r, 'permissions');
  const named = typeof permission === 'string' && !permission.includes(',') ? dialect.contains(list, rsql`${`,${permission},`}`) : FALSE_SQL;
  return andSql(rsql`${list} IS NOT NULL`, orSql(dialect.contains(list, rsql`${',*,'}`), named));
}

/**
 * Two-valued: a `,a,b,` list column holds `value` as a whole entry, case-sensitively; NULL is no filter (TRUE),
 * '' the empty list (FALSE). For `resource_types`, `principal_types`, `subject_types`, `scope_types`.
 */
export function storedListHas(list: RbacSql, value: string, dialect: RbacSqlDialect): RbacSql {
  // Entries never hold ',', so a value with one is in no list.
  if (typeof value !== 'string' || value.includes(',')) return rsql`(${list} IS NULL)`;
  return orSql(rsql`${list} IS NULL`, dialect.contains(list, rsql`${`,${value},`}`));
}

/** As `storedListHas` for a value read from a column (`a.scope_type`); a NULL value is in no list. */
export function storedTypeIn(list: RbacSql, type: RbacSql, dialect: RbacSqlDialect): RbacSql {
  return orSql(rsql`${list} IS NULL`, andSql(rsql`${type} IS NOT NULL`, rsql`NOT (${dialect.contains(type, rsql`${','}`)})`, dialect.contains(list, rsql`${','} || ${type} || ${','}`)));
}

/** Two-valued: the rule has not expired at `now` (an expiry at `now` has). */
export function liveRule(r: string, now: Date): RbacSql {
  const expires = column(r, 'expires_at');
  return orSql(rsql`${expires} IS NULL`, rsql`${expires} > ${now}`);
}

/** Two-valued: the rule sits at a node of the row's path; a rule at a type-only scope is at no node. */
export function ruleOnPath(r: string, path: RbacPathSql): RbacSql {
  return path.onPathNode(r);
}
