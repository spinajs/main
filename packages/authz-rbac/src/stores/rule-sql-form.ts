import { AuthzAdminFailure, AuthzConfigError, parseCondition } from '@spinajs/authz';
import type { AssignmentSubject, Condition, ConditionLiteral, ConditionOp, ParsedCondition, PrincipalRef, PrincipalType, ResourceRef, ResourceType, RuleDef } from '@spinajs/authz';

import type { LadderDef } from '../contracts.js';
import { scopeFromColumns, scopeToColumns, subjectFromColumns, toDate } from './columns.js';
import type { SubjectColumns } from './columns.js';

export const AUTHZ_RULE_TABLE = 'authz_rule';
export const AUTHZ_RULE_SUBJECT_TABLE = 'authz_rule_subject';

export type RuleSubjectList = 'allow' | 'refs';

/**
 * The `authz_rule` values of one rule, except `created_*` (design §9.1, §12.4). Ranks are indexes
 * in `LadderDef.roles` (weakest 0); lists are `,a,b,` text, `''` for an empty list, null when absent.
 */
export interface RuleColumns {
  readonly id: string;
  readonly kind: RuleDef['kind'];
  readonly scope_type: string;
  readonly scope_id: string;
  /** The rule as JSON without `id`, `scope` and `expiresAt` (their columns hold them). */
  readonly definition: string;
  /** `RuleDef.ladder`, else the one ladder holding a role-valued `maxRole`/`minRole`; `max_rank`/`min_rank` index it. Null on a cap: strip-only. */
  readonly ladder: string | null;
  readonly max_rank: number | null;
  /** `maxRole: { ref }`: a `scope.<type>.<path>` attribute naming a role. */
  readonly max_ref: string | null;
  /** `maxRole: null`. */
  readonly drops: boolean;
  readonly strip_tags: boolean;
  readonly min_rank: number | null;
  readonly min_ref: string | null;
  readonly at_type: string | null;
  readonly permissions: string | null;
  readonly resource_types: string | null;
  /** `assignments.subjectTypes`. */
  readonly subject_types: string | null;
  /** `assignments.scopeTypes`. */
  readonly scope_types: string | null;
  /** `subjects.principalTypes`. */
  readonly principal_types: string | null;
  /** `subjects.rank`: the principal's rank on `rank_ladder` at its nearest `rank_at` ancestor lies in [rank_min, rank_max]; no role is -1; null bounds are open. */
  readonly rank_ladder: string | null;
  readonly rank_at: string | null;
  readonly rank_min: number | null;
  readonly rank_max: number | null;
  /** `resource`: `resource.<resource_field> LIKE resource_like ESCAPE '\'`, and `NOT LIKE resource_not_like` when set. */
  readonly resource_field: string | null;
  readonly resource_like: string | null;
  /** A glob ending in one `*`, which does not cross `/`. */
  readonly resource_not_like: string | null;
  /** `likeToGlob(resource_like)`: what SQLite matches with `GLOB`, since its LIKE ignores case. */
  readonly resource_glob: string | null;
  /** `likeToGlob(resource_not_like)`. */
  readonly resource_not_glob: string | null;
  /** `when`: `<when_path> <when_op> <when_value>`, the attribute text (`scope.org.policies.locked`), the op name, the literal as `JSON.stringify` writes it. */
  readonly when_path: string | null;
  readonly when_op: SqlWhenOp | null;
  readonly when_value: string | null;
  readonly reason_code: string | null;
  readonly priority: number | null;
  readonly sort_key: string | null;
  readonly expires_at: Date | null;
}

export interface RuleSubjectRow extends SubjectColumns {
  readonly rule_id: string;
  readonly list: RuleSubjectList;
}

export interface RuleSqlForm {
  readonly rule: RuleColumns;
  /** `allow` and `subjects.refs`, deduplicated, sorted by (list, type, id, role). */
  readonly subjects: readonly RuleSubjectRow[];
}

/** An `authz_rule` row as a driver returns it: 0/1 booleans on SQLite, datetimes as text, numbers maybe as text. */
export type RuleRow = { readonly [K in keyof RuleColumns]: unknown } & { readonly created_by?: unknown; readonly created_at?: unknown };

export type RuleSubjectRowLike = { readonly [K in keyof RuleSubjectRow]: unknown };

/** What SQL sees of a rule (L4b): `fromSqlForm` rebuilds it from the columns alone. */
export interface SqlFormRule {
  readonly id: string;
  readonly kind: RuleDef['kind'];
  readonly scope: ResourceRef;
  readonly expiresAt: Date | null;
  readonly resourceTypes?: readonly ResourceType[];
  readonly subjects?: {
    readonly principalTypes?: readonly PrincipalType[];
    readonly refs?: readonly PrincipalRef[];
    readonly rank?: { readonly ladder: string; readonly at: ResourceType; readonly min?: number; readonly max?: number };
  };
  readonly when?: Condition;
  readonly allow: readonly AssignmentSubject[];
  readonly ladder?: string;
  readonly maxRank?: number;
  readonly maxRef?: string;
  readonly drops: boolean;
  readonly stripTags: boolean;
  readonly assignments?: { readonly scopeTypes?: readonly ResourceType[]; readonly subjectTypes?: readonly PrincipalType[] };
  readonly permissions?: readonly string[];
  readonly resource?: Condition;
  readonly minRank?: number;
  readonly minRef?: string;
  readonly at?: ResourceType;
  readonly reason?: { readonly code: string; readonly priority?: number; readonly sortKey?: string };
}

/**
 * Comparisons a DB rule's `when` may hold: `eq`/`ne` with a string, boolean or number, the order ops
 * with a number only, and `null`. Lists, patterns and functions stay in config rules.
 */
export const SQL_WHEN_OPS = Object.freeze(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'null'] as const);
export type SqlWhenOp = (typeof SQL_WHEN_OPS)[number];

const KINDS: readonly RuleDef['kind'][] = ['restrict', 'cap', 'threshold'];
const NO_FUNCTIONS = { has: () => false };
const INT_MIN = -(2 ** 31);
const INT_MAX = 2 ** 31 - 1;
/** `authz_scope_attribute.value_num` is decimal(20,6). */
const DECIMAL_MAX = 1e14;
const DECIMAL_TEXT = /^-?\d+(\.\d{1,6})?$/;

/** varchar lengths of design §9.1 (Postgres enforces them; SQLite does not). */
const LEN = {
  id: 160,
  scopeType: 64,
  scopeId: 64,
  ladder: 64,
  ref: 160,
  type: 64,
  permissions: 1024,
  types: 255,
  resourceField: 64,
  like: 512,
  whenPath: 160,
  whenValue: 255,
  reasonCode: 64,
  sortKey: 255,
  subjectType: 32,
  subjectId: 64,
  subjectRole: 128,
} as const;

/**
 * The SQL form of a DB rule (D24): the `authz_rule` columns and the `authz_rule_subject` rows that
 * list compilation (L4b) reads without parsing `definition`. Throws `AuthzAdminFailure` with the
 * field: `rule_not_compilable` for what the columns cannot hold or what SQL would read more loosely
 * than single checks, `unknown_ladder`/`unknown_role` where a rank is computed here (`ladder` with a
 * role-valued `maxRole`/`minRole`, `subjects.rank`).
 */
export function toSqlForm(rule: Omit<RuleDef, 'source'>, ladders: readonly LadderDef[]): RuleSqlForm {
  const r = rule as Omit<RuleDef, 'source'> & { source?: unknown };
  const where = `rule ${JSON.stringify(typeof r?.id === 'string' ? r.id : String(r?.id))}`;
  const refuse = (field: string, why: string): never => {
    throw new AuthzAdminFailure('rule_not_compilable', `${where}: ${why}`, field);
  };

  if (typeof r.id !== 'string' || r.id === '' || r.id.length > LEN.id) refuse('id', `the id must be a string of 1 to ${LEN.id} characters`);
  if (!KINDS.includes(r.kind)) refuse('kind', `kind must be one of ${KINDS.join(', ')}`);

  const scope = scopeColumns(r.scope, refuse);
  const lists = (field: string, values: readonly string[] | undefined, max: number) => listColumn(values, field, max, refuse);

  const ladder = ruleLadder(r, ladders, refuse);
  const maxRole = roleColumns(r.maxRole, 'maxRole', ladder, ladders, where, refuse);
  const minRole = r.minRole === null ? refuse('minRole', 'minRole is a role name or { ref }') : roleColumns(r.minRole, 'minRole', ladder, ladders, where, refuse);
  checkPermissions(r.permissions, refuse);
  const subjects = subjectColumns(r, ladders, where, refuse);
  const when = r.when === undefined ? undefined : whenColumns(r.when, where, refuse);
  const resource = r.resource === undefined ? undefined : resourceColumns(r.resource, where, refuse);
  const reason = reasonColumns(r.reason, refuse);

  if (r.stripTags !== undefined && typeof r.stripTags !== 'boolean') refuse('stripTags', 'stripTags must be a boolean');
  if (r.expiresAt != null && !(r.expiresAt instanceof Date && !Number.isNaN(r.expiresAt.getTime()))) refuse('expiresAt', 'expiresAt must be a valid Date or null');

  const { id: _id, scope: _scope, expiresAt: _expiresAt, source: _source, ...definition } = r;

  const columns: RuleColumns = {
    id: r.id,
    kind: r.kind,
    ...scope,
    definition: JSON.stringify(definition),
    ladder: ladder ?? null,
    max_rank: maxRole.rank,
    max_ref: maxRole.ref,
    drops: r.maxRole === null,
    strip_tags: r.stripTags === true,
    min_rank: minRole.rank,
    min_ref: minRole.ref,
    at_type: text(r.at, 'at', LEN.type, refuse),
    permissions: lists('permissions', r.permissions, LEN.permissions),
    resource_types: lists('resourceTypes', r.resourceTypes, LEN.types),
    subject_types: lists('assignments.subjectTypes', r.assignments?.subjectTypes, LEN.types),
    scope_types: lists('assignments.scopeTypes', r.assignments?.scopeTypes, LEN.types),
    principal_types: lists('subjects.principalTypes', r.subjects?.principalTypes, LEN.types),
    rank_ladder: subjects.rank?.ladder ?? null,
    rank_at: subjects.rank?.at ?? null,
    rank_min: subjects.rank?.min ?? null,
    rank_max: subjects.rank?.max ?? null,
    resource_field: resource?.field ?? null,
    resource_like: resource?.like ?? null,
    resource_not_like: resource?.notLike ?? null,
    resource_glob: resource?.glob ?? null,
    resource_not_glob: resource?.notGlob ?? null,
    when_path: when?.path ?? null,
    when_op: when?.op ?? null,
    when_value: when?.value ?? null,
    ...reason,
    expires_at: r.expiresAt ?? null,
  };

  const rows = new Map<string, RuleSubjectRow>();
  const add = (list: RuleSubjectList, s: SubjectColumns) => rows.set(JSON.stringify([list, s.subject_type, s.subject_id, s.subject_role]), { rule_id: r.id, list, ...s });
  for (const s of allowColumns(r.allow, refuse)) add('allow', s);
  for (const s of subjects.refs) add('refs', s);

  return { rule: columns, subjects: [...rows.values()].sort(compareRows) };
}

/** The rule as SQL sees it, from the columns alone (no `definition`); the inverse of {@link toSqlForm} up to ranks. */
export function fromSqlForm(columns: RuleColumns | RuleRow, subjectRows: readonly (RuleSubjectRow | RuleSubjectRowLike)[]): SqlFormRule {
  const c = columns as RuleRow;
  const where = `authz_rule ${JSON.stringify(c.id)}`;
  const rows = subjectRows.map((s) => ({ list: String(s.list), type: String(s.subject_type), id: String(s.subject_id), role: String(s.subject_role ?? '') }));
  const refs = rows.filter((s) => s.list === 'refs').map((s) => ({ type: s.type, id: s.id }));
  const allow = rows.filter((s) => s.list === 'allow').map((s) => subjectFromColumns(s.type, s.id, s.role));

  const subjects = {
    ...optional('principalTypes', readList(c.principal_types)),
    ...(refs.length > 0 ? { refs } : {}),
    ...(c.rank_ladder != null ? { rank: { ladder: String(c.rank_ladder), at: String(c.rank_at), ...optional('min', readInt(c.rank_min, where)), ...optional('max', readInt(c.rank_max, where)) } } : {}),
  };
  const assignments = { ...optional('scopeTypes', readList(c.scope_types)), ...optional('subjectTypes', readList(c.subject_types)) };

  return {
    id: String(c.id),
    kind: c.kind as RuleDef['kind'],
    scope: scopeFromColumns(String(c.scope_type), c.scope_id as string | null),
    expiresAt: toDate(c.expires_at),
    ...optional('resourceTypes', readList(c.resource_types)),
    ...(Object.keys(subjects).length > 0 ? { subjects } : {}),
    ...(c.when_path != null ? { when: { attr: String(c.when_path), [String(c.when_op)]: JSON.parse(String(c.when_value)) as ConditionLiteral } } : {}),
    allow,
    ...optional('ladder', c.ladder == null ? undefined : String(c.ladder)),
    ...optional('maxRank', readInt(c.max_rank, where)),
    ...optional('maxRef', c.max_ref == null ? undefined : String(c.max_ref)),
    drops: readBool(c.drops),
    stripTags: readBool(c.strip_tags),
    ...(Object.keys(assignments).length > 0 ? { assignments } : {}),
    ...optional('permissions', readList(c.permissions)),
    ...(c.resource_field != null ? { resource: readResource(c, where) } : {}),
    ...optional('minRank', readInt(c.min_rank, where)),
    ...optional('minRef', c.min_ref == null ? undefined : String(c.min_ref)),
    ...optional('at', c.at_type == null ? undefined : String(c.at_type)),
    ...(c.reason_code != null ? { reason: { code: String(c.reason_code), ...optional('priority', readInt(c.priority, where)), ...optional('sortKey', c.sort_key == null ? undefined : String(c.sort_key)) } } : {}),
  };
}

/**
 * An equivalent SQLite GLOB for the LIKE text of `resource_like`/`resource_not_like`: SQLite's LIKE
 * ignores ASCII case, GLOB does not, and the core's matchers compare code points.
 */
export function likeToGlob(like: string): string {
  let out = '';
  for (let i = 0; i < like.length; i++) {
    const ch = like[i];
    if (ch === '\\') {
      if (i + 1 >= like.length) throw new AuthzConfigError(`LIKE pattern ${JSON.stringify(like)} ends in a trailing escape`);
      out += globLiteral(like[++i]);
    } else if (ch === '%') out += '*';
    else if (ch === '_') out += '?';
    else out += globLiteral(ch);
  }
  return out;
}

const globLiteral = (ch: string): string => (ch === '*' || ch === '?' || ch === '[' ? `[${ch}]` : ch);

/** `%`, `_` and `\` escaped with `\` (the escape character L4b passes to `LIKE … ESCAPE`). */
export function escapeLike(literal: string): string {
  return literal.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ---- toSqlForm parts ----

type Refuse = (field: string, why: string) => never;

function scopeColumns(scope: ResourceRef, refuse: Refuse) {
  if (!scope || typeof scope.type !== 'string' || scope.type === '' || (scope.id != null && typeof scope.id !== 'string')) refuse('scope', 'scope must be a resource ref');
  const c = scopeToColumns(scope);
  if (c.scope_type.length > LEN.scopeType || c.scope_id.length > LEN.scopeId) refuse('scope', `the scope type and id hold at most ${LEN.scopeType} characters each`);
  return c;
}

function text(value: string | undefined, field: string, max: number, refuse: Refuse): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value === '' || value.length > max) refuse(field, `${field} must be a string of 1 to ${max} characters`);
  return value;
}

function listColumn(values: readonly string[] | undefined, field: string, max: number, refuse: Refuse): string | null {
  if (values === undefined) return null;
  if (!Array.isArray(values)) refuse(field, `${field} must be a list`);
  if (values.length === 0) return '';
  for (const v of values) {
    if (typeof v !== 'string' || v === '' || v.includes(',')) refuse(field, `${field} holds ${JSON.stringify(v)}; every entry is a non-empty string without ","`);
  }
  const out = `,${values.join(',')},`;
  if (out.length > max) refuse(field, `${field} takes ${out.length} characters as a list, more than its column holds (${max})`);
  return out;
}

function rankOf(role: string, ladder: string, ladders: readonly LadderDef[], where: string, roleField: string, ladderField: string): number {
  const l = ladders.find((x) => x.name === ladder);
  if (!l) throw new AuthzAdminFailure('unknown_ladder', `${where}: ladder ${JSON.stringify(ladder)} does not exist`, ladderField);
  const rank = l.roles.indexOf(role);
  if (rank < 0) throw new AuthzAdminFailure('unknown_role', `${where}: role ${JSON.stringify(role)} is not on ladder ${JSON.stringify(ladder)}`, roleField);
  return rank;
}

/**
 * The ladder a rank of the rule indexes: `ladder` as written, else the one ladder holding a role-valued
 * maxRole/minRole. SQL keys caps by ladder, so a cap that drops or clamps to `{ ref }` must name it. A
 * threshold with `minRole: { ref }` may go without: its rank is the attribute's role on that role's ladder.
 */
function ruleLadder(r: Omit<RuleDef, 'source'>, ladders: readonly LadderDef[], refuse: Refuse): string | undefined {
  if (r.ladder !== undefined) return text(r.ladder, 'ladder', LEN.ladder, refuse)!;
  if (r.maxRole !== undefined && typeof r.maxRole !== 'string') refuse('ladder', `a rule with maxRole ${r.maxRole === null ? 'null' : '{ ref }'} names the ladder it ${r.maxRole === null ? 'drops' : 'clamps'}`);

  let found: string | undefined;
  for (const role of [r.maxRole, r.minRole]) {
    if (typeof role !== 'string') continue;
    const holders = ladders.filter((l) => l.roles.includes(role));
    if (holders.length !== 1) refuse('ladder', `role ${JSON.stringify(role)} is on ${holders.length === 0 ? 'no ladder' : `${holders.length} ladders`}; name the ladder its rank indexes`);
    if (found !== undefined && found !== holders[0].name) refuse('ladder', 'maxRole and minRole sit on different ladders; name the ladder');
    found = holders[0].name;
  }
  return found;
}

/** SQL matches a permission as a list entry (`LIKE '%,p,%'`), so a glob other than `*` would match nothing. */
function checkPermissions(permissions: readonly string[] | undefined, refuse: Refuse): void {
  if (!Array.isArray(permissions)) return;
  for (const p of permissions) {
    if (typeof p === 'string' && p !== '*' && p.includes('*')) refuse('permissions', `permission ${JSON.stringify(p)} is a glob; a DB rule lists exact permissions or '*'`);
  }
}

function roleColumns(value: RuleDef['maxRole'], field: 'maxRole' | 'minRole', ladder: string | undefined, ladders: readonly LadderDef[], where: string, refuse: Refuse): { rank: number | null; ref: string | null } {
  if (value === undefined || value === null) return { rank: null, ref: null };
  if (typeof value === 'string') return { rank: rankOf(value, ladder!, ladders, where, field, 'ladder'), ref: null };
  if (typeof value === 'object' && typeof value.ref === 'string') return { rank: null, ref: scopeRef(value.ref, field, refuse) };
  return refuse(field, `${field} is a role name, { ref } or null`);
}

/** A ref SQL reads through `authz_scope_attribute`: `scope.<type>.<path>`. */
function scopeRef(ref: string, field: string, refuse: Refuse): string {
  let parsed: ParsedCondition;
  try {
    parsed = parseCondition({ attr: ref, null: true }, { functions: NO_FUNCTIONS, where: field });
  } catch (e) {
    return refuse(field, `${field} ref ${JSON.stringify(ref)} is not a scope attribute: ${(e as Error).message}`);
  }
  if (parsed.kind !== 'cmp' || parsed.attr.root !== 'scope') refuse(field, `${field} ref ${JSON.stringify(ref)} must read scope.<type>.<path>; DB rules read only scope attributes (D24)`);
  if (ref.length > LEN.ref) refuse(field, `${field} ref takes at most ${LEN.ref} characters`);
  return ref;
}

function subjectColumns(r: Omit<RuleDef, 'source'>, ladders: readonly LadderDef[], where: string, refuse: Refuse): { rank?: { ladder: string; at: string; min?: number; max?: number }; refs: SubjectColumns[] } {
  const s = r.subjects;
  if (s === undefined) return { refs: [] };
  if (s.actorTypes !== undefined) refuse('subjects.actorTypes', 'subjects.actorTypes has no SQL form; DB rules select principal types, rank and refs (D24)');
  if (s.when !== undefined) refuse('subjects.when', 'subjects.when has no SQL form; DB rules select principal types, rank and refs (D24)');

  let refs: SubjectColumns[] = [];
  if (s.refs !== undefined) {
    if (!Array.isArray(s.refs) || s.refs.length === 0) refuse('subjects.refs', 'subjects.refs must list at least one principal: authz_rule_subject cannot tell an empty list from none');
    refs = s.refs.map((p) => {
      if (!p || typeof p.type !== 'string' || typeof p.id !== 'string' || 'set' in p) refuse('subjects.refs', 'subjects.refs holds principal refs { type, id }');
      return subjectRow({ subject_type: p.type, subject_id: p.id, subject_role: '' }, 'subjects.refs', refuse);
    });
  }

  if (s.rank === undefined) return { refs };

  const { ladder, at, lt, eq, gte } = s.rank;
  if (typeof ladder !== 'string' || ladder === '' || ladder.length > LEN.ladder) refuse('subjects.rank.ladder', `subjects.rank.ladder must be a string of 1 to ${LEN.ladder} characters`);
  if (typeof at !== 'string' || at === '' || at.length > LEN.type) refuse('subjects.rank.at', `subjects.rank.at must be a string of 1 to ${LEN.type} characters`);

  const rank = (role: string, field: string) => rankOf(role, ladder, ladders, where, `subjects.rank.${field}`, 'subjects.rank.ladder');
  let min: number | undefined;
  let max: number | undefined;
  if (gte !== undefined) min = rank(gte, 'gte');
  if (eq !== undefined) {
    const e = rank(eq, 'eq');
    min = Math.max(min ?? e, e);
    max = e;
  }
  if (lt !== undefined) {
    const l = rank(lt, 'lt') - 1;
    max = Math.min(max ?? l, l);
  }

  return { refs, rank: { ladder, at, ...optional('min', min), ...optional('max', max) } };
}

function allowColumns(allow: readonly AssignmentSubject[] | undefined, refuse: Refuse): SubjectColumns[] {
  if (allow === undefined) return [];
  if (!Array.isArray(allow)) refuse('allow', 'allow must be a list of subjects');
  return allow.map((s) => {
    if (s && typeof s === 'object' && 'set' in s) {
      const set = s.set;
      if (!set || typeof set.role !== 'string' || set.role === '') refuse('allow', 'a subject set in allow needs a role');
      if (!set.scope || typeof set.scope.type !== 'string' || set.scope.type === '') refuse('allow', 'a subject set in allow needs a scope');
      const scope = scopeToColumns(set.scope);
      return subjectRow({ subject_type: scope.scope_type, subject_id: scope.scope_id, subject_role: set.role }, 'allow', refuse);
    }
    const p = s as PrincipalRef;
    if (!p || typeof p.type !== 'string' || p.type === '' || typeof p.id !== 'string') refuse('allow', 'allow holds principal refs and subject sets');
    return subjectRow({ subject_type: p.type, subject_id: p.id, subject_role: '' }, 'allow', refuse);
  });
}

function subjectRow(c: SubjectColumns, field: string, refuse: Refuse): SubjectColumns {
  if (c.subject_type.length > LEN.subjectType || c.subject_id.length > LEN.subjectId || c.subject_role.length > LEN.subjectRole) {
    refuse(field, `${field} holds ${JSON.stringify([c.subject_type, c.subject_id, c.subject_role])}, longer than authz_rule_subject holds (${LEN.subjectType}, ${LEN.subjectId}, ${LEN.subjectRole})`);
  }
  return c;
}

function parse(c: Condition, field: string, where: string, refuse: Refuse): ParsedCondition {
  try {
    return parseCondition(c, { functions: NO_FUNCTIONS, where: `${where} ${field}` });
  } catch (e) {
    if (e instanceof AuthzConfigError) return refuse(field, `${field} has no SQL form: ${e.message}`);
    throw e;
  }
}

function whenColumns(c: Condition, where: string, refuse: Refuse): { path: string; op: SqlWhenOp; value: string } {
  const p = parse(c, 'when', where, refuse);
  if (p.kind !== 'cmp') {
    const attrs = p.facts.refs.filter((x) => x.startsWith('scope.')).length;
    refuse('when', attrs > 1 ? `when compares ${attrs} scope attributes; a DB rule holds at most one comparison (D24)` : `when must be one comparison of a scope attribute, not ${p.kind} (D24)`);
  }
  const cmp = p as Extract<ParsedCondition, { kind: 'cmp' }>;
  if (cmp.attr.root !== 'scope') refuse('when', `when reads ${cmp.attr.text}; a DB rule's when reads only scope.<type>.* (D24)`);
  if (cmp.operand.kind !== 'literal') refuse('when', 'when compares with a ref; a DB rule compares a scope attribute with a literal (D24)');
  if (!(SQL_WHEN_OPS as readonly ConditionOp[]).includes(cmp.op)) refuse('when', `when uses '${cmp.op}'; a DB rule's when takes ${SQL_WHEN_OPS.join(', ')}`);

  const literal = (cmp.operand as { value: ConditionLiteral }).value;
  const ordered = cmp.op === 'lt' || cmp.op === 'lte' || cmp.op === 'gt' || cmp.op === 'gte';
  if (cmp.op !== 'null') {
    if (ordered && typeof literal !== 'number') refuse('when', `when orders a ${typeof literal}; a DB rule orders only numbers (SQL has no portable code-point order)`);
    if (ordered && !(Math.abs(literal as number) < DECIMAL_MAX && DECIMAL_TEXT.test(JSON.stringify(literal)))) refuse('when', `when orders by ${JSON.stringify(literal)}; value_num (decimal(20,6)) holds below 1e14 with at most 6 decimals`);
    // The core compares a numeric string with numbers too ('3' eq 3); the SQL recipe compares JSON texts.
    if (typeof literal === 'string' && numericText(literal)) refuse('when', `when compares with the numeric string ${JSON.stringify(literal)}, which the core also matches against numbers; compare with a number`);
    if (typeof literal !== 'string' && typeof literal !== 'number' && typeof literal !== 'boolean') refuse('when', 'when compares with a string, a number or a boolean');
  }

  const value = JSON.stringify(literal);
  if (cmp.attr.text.length > LEN.whenPath) refuse('when', `when reads an attribute longer than ${LEN.whenPath} characters`);
  if (value.length > LEN.whenValue) refuse('when', `when compares with a value of ${value.length} characters as JSON, more than ${LEN.whenValue}`);
  return { path: cmp.attr.text, op: cmp.op as SqlWhenOp, value };
}

/** `wildcard` (any `*`) or a `glob` that is a fixed prefix and at most one trailing `*` or `**` (§6.5 rule 11), on one column. */
function resourceColumns(c: Condition, where: string, refuse: Refuse): { field: string; like: string; notLike: string | null; glob: string; notGlob: string | null } {
  const p = parse(c, 'resource', where, refuse);
  if (p.kind !== 'cmp') return refuse('resource', `resource must be one wildcard or glob on a resource column, not ${p.kind}`);
  if (p.attr.root !== 'resource' || p.attr.path.length !== 1) refuse('resource', `resource reads ${p.attr.text}; it must name one column, resource.<field>`);
  if (p.op !== 'wildcard' && p.op !== 'glob') refuse('resource', `resource uses '${p.op}'; a DB rule matches a resource with wildcard or glob`);
  if (p.operand.kind !== 'literal' || typeof p.operand.value !== 'string') return refuse('resource', 'resource matches a literal pattern, not a ref');

  const field = p.attr.path[0];
  const pattern = p.operand.value;
  let like: string;
  let notLike: string | null = null;

  if (p.op === 'wildcard') {
    like = escapeLike(pattern).replace(/\*/g, '%');
  } else {
    const star = pattern.indexOf('*');
    const prefix = escapeLike(star < 0 ? pattern : pattern.slice(0, star));
    const tail = star < 0 ? '' : pattern.slice(star);
    if (tail !== '' && tail !== '*' && tail !== '**') refuse('resource', `glob ${JSON.stringify(pattern)} is more than a fixed prefix and one trailing * or ** (§6.5 rule 11)`);
    like = tail === '' ? prefix : `${prefix}%`;
    if (tail === '*') notLike = `${prefix}%/%`;
  }

  if (field.length > LEN.resourceField) refuse('resource', `resource field takes at most ${LEN.resourceField} characters`);
  const glob = likeToGlob(like);
  const notGlob = notLike === null ? null : likeToGlob(notLike);
  if ((notLike ?? like).length > LEN.like || (notGlob ?? glob).length > LEN.like) refuse('resource', `the pattern takes more than ${LEN.like} characters as LIKE or GLOB`);
  return { field, like, notLike, glob, notGlob };
}

function reasonColumns(reason: RuleDef['reason'], refuse: Refuse): Pick<RuleColumns, 'reason_code' | 'priority' | 'sort_key'> {
  if (reason === undefined) return { reason_code: null, priority: null, sort_key: null };
  if (!reason || typeof reason !== 'object') return refuse('reason', 'reason must be a deny reason object');
  if (typeof reason.code !== 'string' || reason.code === '' || reason.code.length > LEN.reasonCode) refuse('reason.code', `reason.code must be a string of 1 to ${LEN.reasonCode} characters`);
  if (reason.priority !== undefined && !(Number.isInteger(reason.priority) && reason.priority >= INT_MIN && reason.priority <= INT_MAX)) refuse('reason.priority', 'reason.priority must be a 32-bit integer');
  if (reason.sortKey !== undefined && (typeof reason.sortKey !== 'string' || reason.sortKey.length > LEN.sortKey)) refuse('reason.sortKey', `reason.sortKey must be a string of at most ${LEN.sortKey} characters`);
  return { reason_code: reason.code, priority: reason.priority ?? null, sort_key: reason.sortKey ?? null };
}

/** The core's numeric reading of a string: canonical and finite only ('3', '-2.5', not '03' or '1e3'). */
function numericText(s: string): boolean {
  const n = Number(s);
  return Number.isFinite(n) && String(n) === s;
}

function compareRows(a: RuleSubjectRow, b: RuleSubjectRow): number {
  for (const k of ['list', 'subject_type', 'subject_id', 'subject_role'] as const) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  return 0;
}

// ---- fromSqlForm parts ----

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function readList(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  return String(value)
    .split(',')
    .filter((x) => x !== '');
}

function readInt(value: unknown, where: string): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new AuthzConfigError(`${where}: unreadable integer ${JSON.stringify(value)}`);
  return n;
}

function readBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
}

/** The LIKE patterns back as the wildcard (or one-segment glob) they came from; the GLOB columns must say the same. */
function readResource(c: RuleRow, where: string): Condition {
  const field = String(c.resource_field);
  const like = String(c.resource_like);
  const notLike = c.resource_not_like == null ? null : String(c.resource_not_like);
  const notGlob = c.resource_not_glob == null ? null : String(c.resource_not_glob);
  if (String(c.resource_glob) !== likeToGlob(like) || notGlob !== (notLike === null ? null : likeToGlob(notLike))) {
    throw new AuthzConfigError(`${where}: resource_glob/resource_not_glob do not match resource_like/resource_not_like`);
  }

  let pattern = '';
  for (let i = 0; i < like.length; i++) {
    const ch = like[i];
    if (ch === '\\' && i + 1 < like.length) pattern += like[++i];
    else if (ch === '%') pattern += '*';
    else if (ch === '_' || ch === '\\') throw new AuthzConfigError(`${where}: resource_like ${JSON.stringify(like)} is not a pattern toSqlForm writes`);
    else pattern += ch;
  }
  return notLike == null ? { attr: `resource.${field}`, wildcard: pattern } : { attr: `resource.${field}`, glob: pattern };
}
