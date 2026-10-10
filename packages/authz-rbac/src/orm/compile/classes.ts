import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { ResourceType } from '@spinajs/authz';

import type { RbacScopeLayer } from './attributes.js';
import { SCOPE_ATTRIBUTE_TABLE } from './attributes.js';
import { RULE_TABLE } from './db-rules.js';
import type { RbacSqlDialect } from './dialect.js';
import type { RbacPathSql } from './path.js';
import type { RbacSubjectColumns } from './rules.js';
import { FALSE_SQL, aliasedTable, andSql, collation, ident, inList, joinSql, orSql, outer, outerColumnsOf, rebindOuter, rsql } from './sql.js';
import type { RbacSql } from './sql.js';
import type { RbacResourceField } from './stored-rule.js';
import { storedListHas } from './stored-rule.js';

/*
 * A list term worked out once per class of rows. The term's flag (the per-row `COUNT(*)` over authz_gd, rules.ts)
 * reads the filtered row only through `outer()`; two found rows that agree on every such read get the same flag.
 * The class key κ holds what the reads see:
 * - per column node (`RbacPathSql.nodeRead`): 'n' no node, 'x' an id no block names, 'k' || id where the id is
 *   touched (compared with something: an assignment of the term's subjects, a stored rule visible to the row
 *   type, an attribute row of a type the rules read, a config rule's scope, ''), else 'e' where the node's
 *   `exists` holds (types the rules read attributes of, other than the row's own), else 'u';
 * - per field the flag reads (`resource_field` of a stored rule, path columns included): 'v' || value where a
 *   stored rule with a resource pattern on that field may reach the row (`need`, a function of the node part),
 *   else 'u';
 * - per other column the flag reads, and every column an `exists` reads: 'v' || value, unconditionally.
 * The term is then `κ(row) IN (κ of the representatives whose flag is 1)`, one found row per class taken as
 * its representative by a window over the model's table. A threshold term uses the complement (flag 0) under NOT,
 * so a class without a representative denies. A route term without config roles takes its representatives only
 * from rows with an assignment of its subjects on their path (`prune`): the others are FALSE without the rules,
 * and with no subjects the term is FALSE. Postgres only: κ is compared byte by byte (COLLATE "C" on the keys,
 * the database's deterministic default collation where a key reads an authz table, as `sameText`).
 */

export interface RbacClassInput {
  readonly path: RbacPathSql;
  readonly dialect: RbacSqlDialect;
  readonly rowType: ResourceType;
  /** The model's table: its found rows are the representatives. */
  readonly rowTable: string;
  readonly assignmentTable: string;
  /** The term's subjects, as `assignmentRows` filters by them. */
  readonly subjects: readonly RbacSubjectColumns[];
  /** `args.dbRules`. */
  readonly db: boolean;
  /** The scope ids of the config rules (all of them), by scope type. */
  readonly constants: ReadonlyMap<string, readonly string[]>;
  /** The scope types the term may read attributes of (every read of the args' rules; with `db` every path type). */
  readonly attributeTypes: ReadonlySet<string>;
  readonly layer: (type: ResourceType) => RbacScopeLayer | undefined;
  readonly fields: readonly RbacResourceField[];
  /** `route`: the rows whose flag is 1; `threshold`: the rows whose flag is not 0 (a missing class denies). */
  readonly kind: 'route' | 'threshold';
  /**
   * A route term without config roles: its flag is 0 on a row without an assignment of the subjects on its path,
   * so only rows with one (candidates) are representatives.
   */
  readonly prune: boolean;
  /** Test only: take each class's first row by the model's id as its representative. */
  readonly order?: 'asc' | 'desc';
}

/** The class key and the term built on it. */
export interface RbacClassForm {
  /** κ over `outer()`, each part non-NULL text; empty only for a pruned route term without subjects. */
  readonly keys: readonly RbacSql[];
  readonly term: RbacSql;
}

const KEY = 'authz_kr';
const ROWS = 'authz_kq';
const NUMBERED = 'authz_kw';
const REP = 'authz_kp';

const as = (expr: RbacSql, name: string): RbacSql => rsql`${expr} AS ${ident(name)}`;
const lit = (s: string): RbacSql => rsql`CAST(${s} AS TEXT)`;

/**
 * The class form of the term whose per-row form is `whenFoundFlag(flag)`; undefined where the per-row form stays:
 * κ would have no part (no column node, no column read), or the flag reads a field no `need` gates. A pruned route
 * term without subjects has no key and no set at all: `keys` is empty and the term is `whenFound(FALSE)`.
 * @throws AuthzConfigError on a dialect other than Postgres
 */
export function rbacClassForm(flag: RbacSql, input: RbacClassInput): RbacClassForm | undefined {
  const { path, dialect, rowType } = input;
  if (dialect.name !== 'postgres') throw new AuthzConfigError(`authz-rbac class form: ${dialect.name} keeps the per-row form`);
  if (input.prune && input.subjects.length === 0) return { keys: [], term: path.whenFound(FALSE_SQL) };
  // Keys sort and compare as bytes; an id compared with an authz table's column in the default collation, which is
  // deterministic (so byte equality) and that of the tables' indexes.
  const keyText = (x: RbacSql): RbacSql => rsql`(${x}) COLLATE ${collation('C')}`;
  const binary = (x: RbacSql): RbacSql => rsql`${x} COLLATE ${collation('default')}`;
  const valueKey = (column: string, need?: RbacSql): RbacSql => {
    const c = rsql`${outer(column)}`;
    const value = rsql`WHEN ${c} IS NULL THEN ${lit('n')} ELSE ${lit('v')} || CAST(${c} AS TEXT)`;
    return keyText(need === undefined ? rsql`CASE ${value} END` : rsql`CASE WHEN NOT (${need}) THEN ${lit('u')} ${value} END`);
  };
  const subjectsOf = (alias: string): RbacSql => {
    const a = (c: string) => rsql`${ident(alias, c)}`;
    return orSql(...input.subjects.map((s) => rsql`${a('subject_type')} = ${s.type} AND ${a('subject_id')} = ${s.id} AND ${a('subject_role')} = ${s.role}`));
  };
  const visibleToRow = (alias: string): RbacSql => storedListHas(rsql`${ident(alias, 'resource_types')}`, rowType, dialect);
  const scopeIds = (alias: string, table: string, type: string, where: RbacSql) => rsql`SELECT ${ident(alias, 'scope_id')} FROM ${ident(table)} ${ident(alias)} WHERE ${ident(alias, 'scope_type')} = ${type} AND ${where}`;
  // A superset of the ids the term compares column node text with, filtered no tighter than the term filters them.
  const touched = (type: string, text: RbacSql): RbacSql => {
    const arms: RbacSql[] = [];
    if (input.subjects.length > 0) arms.push(scopeIds('authz_ka', input.assignmentTable, type, subjectsOf('authz_ka')));
    if (input.db) arms.push(scopeIds('authz_kb', RULE_TABLE, type, visibleToRow('authz_kb')));
    if (input.attributeTypes.has(type)) arms.push(rsql`SELECT ${ident('authz_kc', 'scope_id')} FROM ${ident(SCOPE_ATTRIBUTE_TABLE)} ${ident('authz_kc')} WHERE ${ident('authz_kc', 'scope_type')} = ${type}`);
    const constants = input.constants.get(type) ?? [];
    return orSql(rsql`${binary(text)} = ${lit('')}`, ...(arms.length > 0 ? [rsql`${binary(text)} IN (${joinSql(arms, ' UNION ALL ')})`] : []), ...(constants.length > 0 ? [rsql`${binary(text)} IN (${constants})`] : []));
  };
  // Stored rules with a resource pattern on one of `fields` at scope type `type` (live or not, any kind).
  const patterned = (alias: string, type: string, fields: readonly string[], column: RbacSql): RbacSql => rsql`SELECT ${column} FROM ${ident(RULE_TABLE)} ${ident(alias)} WHERE ${ident(alias, 'scope_type')} = ${type} AND ${inList(rsql`${ident(alias, 'resource_field')}`, fields)} AND ${visibleToRow(alias)}`;

  const keys: RbacSql[] = [];
  const nodeReads: { readonly type: string; readonly exact: RbacSql; readonly text: RbacSql }[] = [];
  // Some assignment of the subjects is on the row's path (liveness dropped: a superset): as `assignmentRows`
  // finds them, at GLOBAL, at the row type's type-only scope, or at a column node.
  const assigned = (where: RbacSql) => rsql`EXISTS (SELECT 1 FROM ${ident(input.assignmentTable)} ${ident('authz_kg')} WHERE ${where} AND ${subjectsOf('authz_kg')})`;
  const candidate: RbacSql[] = input.prune ? [assigned(rsql`${ident('authz_kg', 'scope_type')} = ${GLOBAL.type}`), assigned(rsql`${ident('authz_kg', 'scope_type')} = ${rowType} AND ${ident('authz_kg', 'scope_id')} = ${lit('')}`)] : [];
  const nodeColumns = new Set<string>();
  path.nodes.forEach((node, i) => {
    const read = path.nodeRead(i);
    if (read === undefined) return;
    nodeColumns.add(node.column!);
    // Ids in this arm are touched (the assignments arm of `touched`), so candidates are whole classes.
    if (input.prune) candidate.push(andSql(read.exact, rsql`NOT (${binary(read.text)} = ${lit('')})`, rsql`${binary(read.text)} IN (${scopeIds('authz_kf', input.assignmentTable, node.type, subjectsOf('authz_kf'))})`));
    const layer = node.type !== rowType && input.attributeTypes.has(node.type) ? input.layer(node.type) : undefined;
    const exists = layer?.kind === 'adapter' && layer.exists ? rsql` WHEN ${layer.exists(read.text)} THEN ${lit('e')}` : rsql``;
    keys.push(keyText(rsql`CASE WHEN NOT ${read.holds} THEN ${lit('n')} WHEN NOT ${read.exact} THEN ${lit('x')} WHEN ${touched(node.type, read.text)} THEN ${lit('k')} || ${read.text}${exists} ELSE ${lit('u')} END`));
    nodeReads.push({ type: node.type, exact: read.exact, text: read.text });
  });

  // An `exists` may read the row beyond its node id; whatever it reads is keyed by value (r3 N2).
  const probe = lit('authz_probe');
  const readByExists = new Set<string>();
  for (const type of input.attributeTypes) {
    const layer = type === rowType ? undefined : input.layer(type);
    if (layer?.kind === 'adapter' && layer.exists) for (const c of outerColumnsOf(layer.exists(probe))) readByExists.add(c);
  }
  const read = outerColumnsOf(flag);
  const fieldColumns = new Set(input.fields.map((f) => f.column));
  const unconditional = [...new Set([...read.filter((c) => !nodeColumns.has(c) && !fieldColumns.has(c)), ...readByExists])];
  const gated = read.filter((c) => fieldColumns.has(c) && !unconditional.includes(c));
  // Without stored rules only a config threshold's resource.* leaf reads a field, and no `need` gates that read
  // (rules.ts keeps such a term per row anyway): keep the per-row form rather than drop the key. A path column read
  // here is read as a node, unless such a leaf reads it too, which only rules.ts's check catches.
  if (!input.db && gated.some((c) => !nodeColumns.has(c))) return undefined;
  // Column c matters only where a stored rule naming one of its fields reaches the row: `storedResource` reads a
  // field for the rules that name it alone, and the pattern leaf count that bounds those reads (`storedPatternLeaves`)
  // reads the path, not the fields. So each column has its own `need`, and a rule on `name` keys no other column.
  if (input.db)
    for (const c of gated) {
      const fields = input.fields.filter((f) => f.column === c).map((f) => f.field);
      const at = (n: (typeof nodeReads)[number]) => andSql(n.exact, rsql`${binary(n.text)} IN (${patterned('authz_kd', n.type, fields, rsql`${ident('authz_kd', 'scope_id')}`)})`);
      keys.push(valueKey(c, orSql(rsql`EXISTS (${patterned('authz_ke', GLOBAL.type, fields, rsql`1`)})`, ...nodeReads.map(at))));
    }
  for (const c of unconditional) keys.push(valueKey(c));
  if (keys.length === 0) return undefined;

  // The flag is about another row source now, so the columns it reads are renamed apart from the key columns.
  const columns = [...new Set([...read, path.path.idColumn])];
  const columnName = new Map(columns.map((c, i) => [c, `authz_c${i}`]));
  const renamed = (c: string): string => columnName.get(c)!;
  const keyNames = keys.map((_, j) => `authz_k${j}`);
  const fence = dialect.fence;
  const representable = input.prune ? andSql(path.foundSql(), orSql(...candidate)) : path.foundSql();
  const inner = rsql`SELECT ${joinSql([...columns.map((c) => as(rsql`${ident(KEY, c)}`, renamed(c))), ...keys.map((k, j) => as(rebindOuter(k, KEY), keyNames[j]))], ', ')} FROM ${aliasedTable(input.rowTable, KEY)} WHERE ${rebindOuter(representable, KEY)}${fence}`;
  const order = input.order === undefined ? rsql`` : rsql` ORDER BY ${ident(ROWS, renamed(path.path.idColumn))} ${input.order === 'asc' ? rsql`ASC` : rsql`DESC`}`;
  const partition = joinSql(
    keyNames.map((n) => rsql`${ident(ROWS, n)}`),
    ', ',
  );
  const numbered = rsql`SELECT ${ident(ROWS)}.*, ROW_NUMBER() OVER (PARTITION BY ${partition}${order}) AS ${ident('authz_rn')} FROM (${inner}) ${ident(ROWS)}${fence}`;
  const reps = rsql`SELECT ${ident(NUMBERED)}.* FROM (${numbered}) ${ident(NUMBERED)} WHERE ${ident(NUMBERED, 'authz_rn')} = 1${fence}`;
  const set = rsql`SELECT ${joinSql(
    keyNames.map((n) => rsql`${ident(REP, n)}`),
    ', ',
  )} FROM (${reps}) ${ident(REP)} WHERE ${rebindOuter(flag, REP, renamed)} = ${input.kind === 'route' ? rsql`1` : rsql`0`}`;
  const inSet = rsql`(${joinSql(keys, ', ')}) IN (${set})`;
  // NULL in κ would make the IN NULL; under NOT that must deny, not list.
  const term = input.kind === 'route' ? path.whenFound(inSet) : path.whenFound(rsql`NOT COALESCE(${inSet}, ${FALSE_SQL})`);
  return { keys, term };
}
