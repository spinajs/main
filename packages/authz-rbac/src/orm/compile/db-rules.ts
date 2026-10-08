import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { Permission, PrincipalRef, ResourceType } from '@spinajs/authz';

import type { CompiledLadder } from '../../model/ladder/ladders.js';
import type { RbacListing } from '../role-graph.js';
import { attrOfRefStages } from './attributes.js';
import type { RbacAttrStages, RbacScopeDefaults } from './attributes.js';
import type { RbacSqlDialect } from './dialect.js';
import type { RbacPathSql } from './path.js';
import { FALSE_SQL, TRUE_SQL, andSql, ident, inList, intSql, joinSql, notSql, orSql, rsql } from './sql.js';
import type { RbacSql } from './sql.js';
import { WHEN_MISSING, WHEN_TRUE, liveRule, storedListHas, storedPermission, storedResource, whenCodeOf } from './stored-rule.js';
import type { RbacResourceField } from './stored-rule.js';

/*
 * The rules of the model's DbRuleStore on a row's path (`authz_rule`, `authz_rule_subject`; L2's SQL form) as
 * per-row derived tables: one row per stored rule a check of the row reads, with what the rule steps take from
 * it (model/rules/extension.ts `activate`, steps.ts). Role names come from `definition` (what the check compiles,
 * `compileRule` with the current roles), not from the rank columns, which hold the ranks of the roles when the
 * rule was written and intersect `subjects.rank` bounds the check reads one at a time.
 *
 * Assumption (the store writes a row's columns from its definition in one statement, `toSqlForm`): everything
 * else is read from the columns, while the check reads it from `definition`: `principal_types`, `permissions`,
 * `resource_types`, `scope_types`, `subject_types`, `strip_tags`, `at_type`, `rank_ladder`, `rank_at`,
 * `when_path`, `when_op`, `when_value`, `max_ref`, `min_ref`, `resource_field`, `resource_like`,
 * `resource_not_like`, `resource_glob`, `resource_not_glob`, and the `allow` and `refs` entries from
 * `authz_rule_subject`. A row written past the store where they disagree with the definition (or e.g. with
 * `subjects.refs: null`, which the check ignores and SQL reads as a selector no subject row meets) may list rows
 * the check refuses: not selecting a restrict, cap or threshold lists more. The definition itself is read as
 * JSON.parse reads it: on Postgres by `->` (the last of repeated keys, escapes decoded; a text JSON.parse refuses
 * fails the list), on SQLite by json_extract where `jsonUnlike` finds no JSON5, repeated key or escape (else `st`).
 *
 * The columns of `authz_dr` (integers 0/1 unless said otherwise):
 * - `id`, `kind`; `ix`: the static path index of the rule's node, NULL for a type-only scope (a node holding '').
 * - `st`: the check fails on the rule wherever it reads it (`compileRule` throws: a ladder or role the current
 *   roles do not hold, a kind/field mix the store refuses), or the definition holds what the SQL form cannot
 *   (`subjects.when`, `subjects.actorTypes`, a condition or ref outside the columns), or the dialect reads it
 *   otherwise than the check's JSON.parse (`jsonUnlike`: SQLite, JSON5, a repeated key or a `\u` escape): refused (narrower).
 * - `ps`: the request-level selectors hold (principal types, refs; a threshold's permissions).
 * - `ab`: a scope type the rule reads has no node on the row's path (indeterminate, B39).
 * - `wc`: `when` as `storedWhenCode` (1, 0, NULL UNKNOWN, 2 inexact, 3 missing).
 * - cap: `cl` its ladder (text), `mk` 0 no maxRole / 1 null / 2 a role / 3 a ref, `mx` the maxRole rank on `cl`
 *   (NULL for an unreadable ref), `mf` a ref without a role of `cl`, `sp` stripTags, `sty`/`sjt` the
 *   assignment selectors' lists.
 * - threshold: `nk` 1 a role / 2 a ref, `mt` the minRole rank on its own ladder, `dl` the deciding ladder (text),
 *   `nf` a ref without a ladder role, `ol` a ref whose role is off the rule's `ladder`, `at`/`nt` the `at` type
 *   and the static index of its nearest node, `rr` `resource` (1, 0, NULL UNKNOWN).
 * - rank selector: `rl` its ladder (text), `ro` 1 lt / 2 eq / 3 gte (the first the check reads), `rb` the bound's
 *   rank, `rn` the static index of the nearest `rank.at` node; `ro` NULL: no selector.
 */

export type RbacDbRuleKind = 'restrict' | 'cap' | 'threshold';

export interface RbacDbRuleContext {
  readonly listing: RbacListing;
  readonly rowType: ResourceType;
  readonly path: RbacPathSql;
  readonly dialect: RbacSqlDialect;
  readonly defaults: RbacScopeDefaults;
  readonly fields: readonly RbacResourceField[];
  readonly now: Date;
  readonly permission: Permission;
  /** The principal and its companions. */
  readonly everyone: readonly PrincipalRef[];
  /** How many resource pattern leaves the check of the row may evaluate (`storedPatternLeaves` plus the config ones). */
  readonly patternLeaves: RbacSql;
}

/**
 * Integer, at least the number of resource patterns of the stored thresholds a check of the row may evaluate: the
 * live ones of the row type and the permission on the row's path (selected or not).
 */
export function storedPatternLeaves(ctx: Pick<RbacDbRuleContext, 'path' | 'rowType' | 'now' | 'permission' | 'dialect'>): RbacSql {
  const b = 'authz_bq';
  const where = andSql(rsql`${ident(b, 'kind')} = ${'threshold'}`, rsql`${ident(b, 'resource_field')} IS NOT NULL`, orSql(ctx.path.onPathNode(b), ctx.path.emptyIdNode(b)), liveRule(b, ctx.now), storedListHas(rsql`${ident(b, 'resource_types')}`, ctx.rowType, ctx.dialect), storedPermission(b, ctx.permission, ctx.dialect));
  return rsql`(SELECT COUNT(*) FROM ${ident(RULE_TABLE)} ${ident(b)} WHERE ${where})`;
}

export const RULE_TABLE = 'authz_rule';
export const RULE_SUBJECT_TABLE = 'authz_rule_subject';

const R = 'authz_r';
const Q = 'authz_q';
const RS = 'authz_rs';

const as = (expr: RbacSql, name: string): RbacSql => rsql`${expr} AS ${ident(name)}`;
const flag = (cond: RbacSql): RbacSql => (cond === TRUE_SQL ? intSql(1) : cond === FALSE_SQL ? intSql(0) : rsql`CASE WHEN ${cond} THEN 1 ELSE 0 END`);
const text = (s: string): RbacSql => rsql`CAST(${s} AS TEXT)`;

// The `{ ref }` columns whose scope attributes the rules read: `when_path`, `max_ref`, `min_ref`.
const REFS = [
  ['w', 'when_path'],
  ['x', 'max_ref'],
  ['n', 'min_ref'],
] as const;

/**
 * The WITH tables, in order, ending in `authz_dr`: the stored rules of `kinds` a check of the row reads (`authz_dj`),
 * the scope attributes their refs name looked up in steps side by side (`authz_dk`, `authz_dl`, `authz_dm`, see
 * `RbacAttrStages`: no nesting, for SQLite's parser stack), and their columns.
 */
export function rbacDbRuleTables(ctx: RbacDbRuleContext, kinds: readonly RbacDbRuleKind[]): [string, RbacSql][] {
  if (kinds.length === 0) throw new AuthzConfigError('authz-rbac db rules sql: no rule kinds to read');
  const stages = Object.fromEntries(REFS.map(([p, c]) => [p, attrOfRefStages(ctx.path, rsql`${ident(R, c)}`, ctx.defaults, ctx.dialect)])) as Record<(typeof REFS)[number][0], RbacAttrStages>;
  const fence = ctx.dialect.fence;
  const step = (from: string, cols: (p: (typeof REFS)[number][0], col: (c: string) => RbacSql) => Readonly<Record<string, RbacSql>>): RbacSql => {
    const out = REFS.flatMap(([p]) => Object.entries(cols(p, (c) => rsql`${ident(from, `${p}_${c}`)}`)).map(([name, expr]) => as(expr, `${p}_${name}`)));
    return rsql`SELECT ${ident(from)}.*, ${joinSql(out, ', ')} FROM ${ident(from)}${fence}`;
  };
  const m = (c: string): RbacSql => rsql`${ident('authz_dl', c)}`;
  const valued = (p: 'w' | 'x' | 'n') => stages[p].value((c) => m(`${p}_${c}`));
  const when = valued('w');
  // The `{ ref }` value's JSON text where the check reads a scalar; NULL where it faults (or, for a null maxRole, drops: narrower).
  const refJson = (p: 'x' | 'n', column: string) => rsql`CASE WHEN ${m(column)} IS NOT NULL AND ${valued(p).present} = 1 THEN ${valued(p).json} END`;
  const dm = rsql`SELECT ${ident('authz_dl')}.*, ${joinSql([as(rsql`CASE WHEN ${m('when_path')} IS NULL THEN ${intSql(WHEN_TRUE)} ELSE ${whenCodeOf('authz_dl', { json: when.json, num: when.num, present: when.present }, ctx.dialect)} END`, 'wc'), as(refJson('x', 'max_ref'), 'mj'), as(refJson('n', 'min_ref'), 'nj')], ', ')} FROM ${ident('authz_dl')}${fence}`;
  return [
    ['authz_dj', visibleRules(ctx, kinds, stages)],
    ['authz_dk', step('authz_dj', (p, col) => stages[p].lookup(col))],
    ['authz_dl', step('authz_dk', (p, col) => stages[p].layer(col))],
    ['authz_dm', dm],
    ['authz_dr', ruleColumns(ctx)],
  ];
}

function visibleRules(ctx: RbacDbRuleContext, kinds: readonly RbacDbRuleKind[], stages: Record<string, RbacAttrStages>): RbacSql {
  const { path, dialect } = ctx;
  const r = (c: string): RbacSql => rsql`${ident(R, c)}`;
  const doc = dialect.jsonDoc(r('definition'));
  const has = (...keys: string[]) => flag(dialect.jsonHas(doc, keys));
  const isNull = (...keys: string[]) => flag(dialect.jsonNull(doc, keys));
  const str = (...keys: string[]) => dialect.jsonString(doc, keys);
  // A value of these keys that is neither a string nor null: an object (a { ref }) or a value no store writes.
  const other = (key: string) => andSql(dialect.jsonHas(doc, [key]), notSql(dialect.jsonNull(doc, [key])), rsql`${str(key)} IS NULL`);
  // The definition holds what the SQL form has no column for, or reads otherwise than the check's JSON.parse.
  const beyond = orSql(dialect.jsonUnlike(r('definition')), dialect.jsonHas(doc, ['subjects', 'when']), dialect.jsonHas(doc, ['subjects', 'actorTypes']), andSql(dialect.jsonHas(doc, ['when']), rsql`${r('when_path')} IS NULL`), andSql(dialect.jsonHas(doc, ['resource']), rsql`${r('resource_field')} IS NULL`), andSql(other('maxRole'), rsql`${r('max_ref')} IS NULL`), andSql(other('minRole'), rsql`${r('min_ref')} IS NULL`));

  const subject = (list: string, extra: RbacSql) => rsql`EXISTS (SELECT 1 FROM ${ident(RULE_SUBJECT_TABLE)} ${ident(RS)} WHERE ${ident(RS, 'rule_id')} = ${r('id')} AND ${ident(RS, 'list')} = ${list} AND ${extra})`;
  const roles = ctx.listing.roles.names;
  // compileRule: a subject set of `allow` names a role the graph holds.
  const unknownSetRole = subject('allow', andSql(rsql`${ident(RS, 'subject_role')} <> ${''}`, roles.length === 0 ? TRUE_SQL : notSql(inList(rsql`${ident(RS, 'subject_role')}`, [...roles]))));
  const everyone = [...new Map(ctx.everyone.map((p) => [JSON.stringify([p.type, p.id]), p])).values()];
  const types = [...new Set(everyone.map((p) => p.type))];
  const byType = orSql(...types.map((t) => storedListHas(r('principal_types'), t, dialect)));
  // A refs selector is in the definition; its entries are the subject rows (rowToRule keeps those).
  const byRef = orSql(notSql(dialect.jsonHas(doc, ['subjects', 'refs'])), subject('refs', andSql(rsql`${ident(RS, 'subject_role')} = ${''}`, orSql(...everyone.map((p) => rsql`${ident(RS, 'subject_type')} = ${p.type} AND ${ident(RS, 'subject_id')} = ${p.id}`)))));
  const selects = andSql(byType, byRef, orSql(rsql`${r('kind')} <> ${'threshold'}`, storedPermission(R, ctx.permission, dialect)));

  const cols = [as(r('id'), 'id'), as(r('kind'), 'kind'), as(path.pathIndex(R), 'ix'), ...['when_path', 'when_op', 'when_value', 'max_ref', 'min_ref', 'at_type', 'rank_ladder', 'rank_at', 'scope_types', 'subject_types'].map((c) => as(r(c), c)), as(rsql`CASE WHEN ${r('strip_tags')} THEN 1 ELSE 0 END`, 'sp'), as(flag(selects), 'ps'), ...REFS.flatMap(([p]) => Object.entries(stages[p].resolve()).map(([name, expr]) => as(expr, `${p}_${name}`))), as(rsql`CASE WHEN ${storedResource(R, ctx.fields, dialect, ctx.patternLeaves)} THEN 1 WHEN NOT ${storedResource(R, ctx.fields, dialect, ctx.patternLeaves)} THEN 0 END`, 'rr'), as(has('ladder'), 'jlp'), as(str('ladder'), 'jl'), as(has('maxRole'), 'jxp'), as(isNull('maxRole'), 'jxn'), as(str('maxRole'), 'jx'), as(has('minRole'), 'jnp'), as(isNull('minRole'), 'jnn'), as(str('minRole'), 'jn'), as(has('resource'), 'jrs'), as(has('subjects', 'rank'), 'jrp'), as(has('subjects', 'rank', 'lt'), 'jrlp'), as(str('subjects', 'rank', 'lt'), 'jrl'), as(has('subjects', 'rank', 'eq'), 'jrep'), as(str('subjects', 'rank', 'eq'), 'jre'), as(has('subjects', 'rank', 'gte'), 'jrgp'), as(str('subjects', 'rank', 'gte'), 'jrg'), as(flag(orSql(beyond, unknownSetRole)), 'jb')];
  const visible = andSql(orSql(path.onPathNode(R), path.emptyIdNode(R)), liveRule(R, ctx.now), storedListHas(r('resource_types'), ctx.rowType, dialect), inList(r('kind'), [...kinds]));
  return rsql`SELECT ${joinSql(cols, ', ')} FROM ${ident(RULE_TABLE)} ${ident(R)} WHERE ${visible}${dialect.fence}`;
}

function ruleColumns(ctx: RbacDbRuleContext): RbacSql {
  const { path, dialect, listing } = ctx;
  const q = (c: string): RbacSql => rsql`${ident(Q, c)}`;
  const ladders: readonly CompiledLadder[] = listing.ladders?.ladders ?? [];
  const same = (a: RbacSql, b: string): RbacSql => rsql`(${dialect.sameText(a, text(b))})`;
  const isLadder = (e: RbacSql): RbacSql => (ladders.length === 0 ? FALSE_SQL : andSql(rsql`${e} IS NOT NULL`, orSql(...ladders.map((l) => same(e, l.name)))));
  const roleCase = (e: RbacSql, value: (l: CompiledLadder, rank: number) => RbacSql, json = false): RbacSql => {
    const whens = ladders.flatMap((l) => l.roles.map((role, i) => rsql`WHEN ${same(e, json ? JSON.stringify(role) : role)} THEN ${value(l, i)}`));
    return whens.length === 0 ? rsql`NULL` : rsql`CASE ${joinSql(whens, ' ')} END`;
  };
  const ladderOf = (e: RbacSql, json = false): RbacSql => roleCase(e, (l) => text(l.name), json);
  const rankOf = (e: RbacSql, json = false): RbacSql => roleCase(e, (_, i) => intSql(i), json);
  // compileRule's roleOn: a role of some ladder, of `ladder` when one is named.
  const roleOn = (name: RbacSql, ladder: RbacSql): RbacSql => andSql(rsql`${name} IS NOT NULL`, rsql`(${dialect.sameText(ladderOf(name), ladder)})`);
  const ladderNamed = rsql`${q('jlp')} = 1`;
  const roleOk = (name: RbacSql) => andSql(rsql`${ladderOf(name)} IS NOT NULL`, orSql(rsql`${q('jlp')} = 0`, rsql`(${dialect.sameText(ladderOf(name), q('jl'))})`));
  const rankNames = ['jrl', 'jre', 'jrg'] as const;
  const stale = orSql(rsql`${q('jb')} = 1`, andSql(ladderNamed, notSql(isLadder(q('jl')))), andSql(rsql`${q('jx')} IS NOT NULL`, notSql(roleOk(q('jx')))), andSql(rsql`${q('jn')} IS NOT NULL`, notSql(roleOk(q('jn')))), andSql(rsql`${q('jrp')} = 1`, orSql(notSql(isLadder(q('rank_ladder'))), ...rankNames.map((k) => andSql(rsql`${q(`${k}p`)} = 1`, notSql(roleOn(q(k), q('rank_ladder'))))))), andSql(rsql`${q('kind')} <> ${'threshold'}`, rsql`${q('jrs')} = 1`), andSql(rsql`${q('kind')} = ${'threshold'}`, orSql(rsql`${q('jnp')} = 0`, rsql`${q('jnn')} = 1`)), andSql(rsql`${q('kind')} = ${'cap'}`, rsql`${q('jxp')} = 1`, rsql`${q('jlp')} = 0`));

  const capLadder = rsql`CASE WHEN ${ladderNamed} AND ${isLadder(q('jl'))} THEN ${q('jl')} END`;
  const refRank =
    ladders.length === 0
      ? rsql`CAST(NULL AS INTEGER)`
      : rsql`CASE ${joinSql(
          ladders.flatMap((l) => l.roles.map((role, i) => rsql`WHEN ${same(q('jl'), l.name)} AND ${same(q('mj'), JSON.stringify(role))} THEN ${intSql(i)}`)),
          ' ',
        )} END`;
  const mk = rsql`CASE WHEN ${q('jxn')} = 1 THEN 1 WHEN ${q('jx')} IS NOT NULL THEN 2 WHEN ${q('max_ref')} IS NOT NULL THEN 3 ELSE 0 END`;
  const valueRank = rankOf(q('nj'), true);
  const valueLadder = ladderOf(q('nj'), true);
  const absent = (c: RbacSql): RbacSql => andSql(rsql`${c} IS NOT NULL`, notSql(nodeOfRef(path, c)));

  const cols = [
    as(q('id'), 'id'),
    as(q('kind'), 'kind'),
    as(q('ix'), 'ix'),
    as(flag(stale), 'st'),
    as(q('ps'), 'ps'),
    as(flag(orSql(absent(q('when_path')), absent(q('max_ref')), absent(q('min_ref')))), 'ab'),
    as(q('wc'), 'wc'),
    as(capLadder, 'cl'),
    as(mk, 'mk'),
    as(rsql`CASE WHEN ${q('jx')} IS NOT NULL THEN ${rankOf(q('jx'))} WHEN ${q('jxn')} = 0 AND ${q('max_ref')} IS NOT NULL THEN ${refRank} END`, 'mx'),
    as(flag(andSql(rsql`${q('kind')} = ${'cap'}`, rsql`${q('max_ref')} IS NOT NULL`, rsql`${refRank} IS NULL`)), 'mf'),
    as(q('sp'), 'sp'),
    as(q('scope_types'), 'sty'),
    as(q('subject_types'), 'sjt'),
    as(rsql`CASE WHEN ${q('jn')} IS NOT NULL THEN 1 WHEN ${q('min_ref')} IS NOT NULL THEN 2 END`, 'nk'),
    as(rsql`CASE WHEN ${q('jn')} IS NOT NULL THEN ${rankOf(q('jn'))} ELSE ${valueRank} END`, 'mt'),
    as(rsql`CASE WHEN ${ladderNamed} THEN ${capLadder} WHEN ${q('jn')} IS NOT NULL THEN ${ladderOf(q('jn'))} ELSE ${valueLadder} END`, 'dl'),
    as(flag(andSql(rsql`${q('kind')} = ${'threshold'}`, rsql`${q('jn')} IS NULL`, rsql`${q('min_ref')} IS NOT NULL`, rsql`${valueRank} IS NULL`)), 'nf'),
    as(flag(andSql(rsql`${q('kind')} = ${'threshold'}`, rsql`${q('jn')} IS NULL`, rsql`${q('min_ref')} IS NOT NULL`, rsql`${valueRank} IS NOT NULL`, ladderNamed, notSql(rsql`(${dialect.sameText(valueLadder, q('jl'))})`))), 'ol'),
    as(q('at_type'), 'at'),
    as(nearestOf(path, q('at_type'), dialect), 'nt'),
    as(rsql`CASE WHEN ${q('jrp')} = 1 THEN ${q('rank_ladder')} END`, 'rl'),
    as(rsql`CASE WHEN ${q('jrp')} = 1 THEN (CASE WHEN ${q('jrlp')} = 1 THEN 1 WHEN ${q('jrep')} = 1 THEN 2 ELSE 3 END) END`, 'ro'),
    as(rsql`CASE WHEN ${q('jrlp')} = 1 THEN ${rankOf(q('jrl'))} WHEN ${q('jrep')} = 1 THEN ${rankOf(q('jre'))} WHEN ${q('jrgp')} = 1 THEN ${rankOf(q('jrg'))} END`, 'rb'),
    as(nearestOf(path, q('rank_at'), dialect), 'rn'),
    as(q('rr'), 'rr'),
  ];
  return rsql`SELECT ${joinSql(cols, ', ')} FROM ${ident('authz_dm')} ${ident(Q)}${dialect.fence}`;
}

/** Integer: the static index of the row's nearest node of the type a text column names; NULL for none. */
function nearestOf(path: RbacPathSql, type: RbacSql, dialect: RbacSqlDialect): RbacSql {
  const whens = [...new Set(path.nodes.map((n) => n.type))].flatMap((t) => {
    const index = path.nearestIndex(t);
    return index === undefined ? [] : [rsql`WHEN ${type} IS NOT NULL AND (${dialect.sameText(type, text(t))}) THEN ${index}`];
  });
  return whens.length === 0 ? rsql`CAST(NULL AS INTEGER)` : rsql`CASE ${joinSql(whens, ' ')} END`;
}

/**
 * Two-valued for a non-NULL `scope.<type>.<path>` column: the row's path has a node of the type, as `nodeOfType`
 * finds one (GLOBAL always). The engine reads the second segment as the type, so a node type holding '.' is never
 * named.
 */
function nodeOfRef(path: RbacPathSql, ref: RbacSql): RbacSql {
  const prefixed = (t: string): RbacSql => {
    const prefix = `scope.${t}.`;
    return rsql`SUBSTR(${ref}, 1, ${intSql([...prefix].length)}) = ${prefix}`;
  };
  const types = [...new Set(path.nodes.map((n) => n.type))].filter((t) => t !== GLOBAL.type && !t.includes('.'));
  return orSql(
    prefixed(GLOBAL.type),
    ...types.flatMap((t) => {
      const index = path.nearestIndex(t);
      return index === undefined ? [] : [andSql(prefixed(t), rsql`${index} IS NOT NULL`)];
    }),
  );
}

/** `wc` neither FALSE nor missing: the rule applies (restrict, cap) or may deny (threshold); inexact counts as applying. */
export const whenApplies = (wc: RbacSql): RbacSql => rsql`(${wc} IS NULL OR ${wc} IN (1, 2))`;

/** `wc` says the check faults on the rule's `when`. */
export const whenMissing = (wc: RbacSql): RbacSql => rsql`(${wc} = ${intSql(WHEN_MISSING)})`;
