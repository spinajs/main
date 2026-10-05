import { RBAC_ASSIGNMENT_OP, RBAC_THRESHOLD_OP } from '../../contracts.js';
import type { Condition, Permission, PrincipalRef, ResourceRef, RuleDef } from '@spinajs/authz';

import { copySubject, readSubject } from '../native.js';
import type { RbacArgsSubject } from '../native.js';

/*
 * Args v2 of `native:rbac.assignment` and v1 of `native:rbac.threshold` (design §6.1.2, type-level
 * paragraph; §12.4): the contract between the RBAC model and the list compilers, the in-memory
 * NativeFilters of rbacAssignmentExtension with `rules: true` and the SQL of RbacOrmCompiler.
 * The model emits them on a type-level request when the rows' answers depend on rules (or on tags,
 * provenance or implied 'descendants' contributions); otherwise it emits v1 or core ops.
 *
 * Both share a context: what a check of `permission` by this principal knows before it reads a row.
 * - `subjects`: the principal's usable subjects (itself, companions, subject sets whose membership
 *   holds now and passes the ceiling), as the assignment table stores them.
 * - `config`: GLOBAL roles the config gives these subjects (anonymousRoles, serviceRoles); they are
 *   in no table, so a compiler adds them as constant assignments at GLOBAL.
 * - `ceilingRoles`: the principal's `ceiling.roles` (absent: no ceiling); every assignment and every
 *   implied role must name one of them.
 * - `principal`, `companions`, `actor`: who asks, for the selectors of DB rules (D24: principal
 *   types, refs, rank).
 * - `rules`: the config rules that can apply to this request (scope anywhere; resource type and,
 *   for thresholds, permission already matched), with the request already applied: subject
 *   selectors other than `rank` decided (a rule they leave out is not listed), `principal.*`,
 *   `actor.*` and `env.*` parts of conditions and refs replaced by constants. `when` holds
 *   `subjects.when` too; the model refuses at boot a `subjects.when`, or a restrict or cap `when`,
 *   that reads `resource.*`. What remains reads the row: `scope`, `rank`, `scope.<type>.*`, and
 *   `resource.*` in a threshold's `when` or `resource`. A rule whose condition is FALSE for this
 *   request is left out only when no part of it reads `scope.<type>.*`; otherwise it is listed
 *   with that condition, for its scope reads.
 *   A rule with `indeterminate: true` is one a check could not decide (a `{ ref }` without a value,
 *   a condition the compiler refuses): every row on its path is refused, as the check fails there.
 *   The check skips such a rule on rows where its condition is FALSE; the list refuses those rows
 *   too (r6: narrower only, SQL need not be exact there).
 * - `dbRules`: rules of the model's RuleStore on the row's path apply as well (read per row; the
 *   SQL reads `authz_rule`). Their selectors are judged on `principal`, `companions`, `actor`. They
 *   must keep to D24 (selectors on principal types, refs and rank; at most one scope-attribute
 *   comparison in `when`; refs on `scope.*`). A stored rule that can apply and whose conditions or
 *   refs read `principal.*`, `actor.*`, `env.*` or call a function refuses every row on its path,
 *   since the list cannot read the request facts it needs.
 *
 * `native:rbac.assignment` v2 holds a `route`: one grant of `permission`, declared by `route.role`
 * as its `route.grant`-th grant. The row is permitted when a check of `permission` on the row, with
 * this context, has that grant among its candidates and it passes steps 5–7 (design §6.1.2, after
 * restrict and cap): some live assignment on the row's path whose effective role (rank after caps)
 * reaches `route.role`, tags holding `route.requiresTag`, an assignment made at `route.grantedAt`
 * types with enough rank. The other route fields restate that for SQL, and the in-memory evaluator
 * requires them too:
 * - `roles`: the stored roles that can reach `route.role`: every role whose closure (extends, ladder
 *   edges) holds it, or that implies such a role (implies do not chain). A holder's stored role is
 *   one of them.
 * - `ladder`: the ladder of `route.role`, when it has one: the holder's rank after caps reaches the
 *   rank of `route.role`; a holder off that ladder counts with the highest role of it its closure
 *   reaches, and a cap drops it above `maxRole`.
 * - `requiresTag`: some live assignment on the path (after caps) carries the tag.
 * - `grantedAt`: some live assignment of that ladder (any assignment reaching the grant, for a
 *   grant on no ladder) is made at one of these scope types, with enough rank.
 * The grant's own relation and pattern stay core ops ANDed around the term.
 *
 * `native:rbac.threshold` v1 holds `threshold`: `{ rule: <id> }` names one of `rules`, `{ db: true }`
 * the DB threshold rules. The row matches when, after restrict and cap with every rule of the
 * context, the named threshold(s) deny `permission` on the row (step 8). It sits in `denyWhen` and
 * in `Vote.denies` with that rule's reason ({ code: 'threshold', priority: 600 } for DB rules).
 *
 * Conditions in `rules` are core Conditions over `scope.*` and `resource.*` (and functions), plus
 * the leaf `{ const: true | false | null }`, null being UNKNOWN (§5.9, three-valued). Only a subtree
 * that reads no `scope.*` or `resource.*` is folded to a constant; one that does keeps its shape.
 * A leaf whose request side has no literal (a missing or unfit value) is bound as
 * `{ all: [{ const: null }, x OR NOT x] }`, and a swapped leaf (`principal.v <op> { ref: scope.p }`)
 * as `{ all: [{ attr: scope.p, <op'>: v }, x OR NOT x] }`, where `x OR NOT x` is
 * `{ any: [x, { not: x }] }` over the leaf's scope path, read on the side the check reads it.
 *
 * Scope reads fault (B39). For every rule on the row's path, each `scope.<type>.*` it reads, in a
 * condition or a ref, wherever it sits and whatever the rule's condition is: a row without that
 * node, or whose attribute is missing or null (or, read as a `{ ref }` value, not a scalar or a
 * literal list), is refused: the route term is FALSE and the threshold term TRUE. The in-memory
 * evaluator is exact, as the check is: a missing node fails only where the rule could act, a missing
 * attribute on an existing node fails the row. SQL may refuse every such row on the path instead
 * (narrower, safe). It must emit that guard per read, before any folding, and must not fold
 * `x OR NOT x`, `{ const: null }` AND …, or a decided `all`/`any` away, since the reads are what
 * is left.
 *
 * UNKNOWN never turns into access (RFC L3-1). Per position, UNKNOWN (`{ const: null }`, SQL NULL
 * from a comparison) means:
 * - restrict or cap `when`: the rule applies (it drops, clamps or strips);
 * - threshold `when` or `resource`: the threshold denies;
 * - a route term: the row is not permitted.
 * SQL must not let NULL flip `NOT EXISTS (… whenSql …)` or `NOT capped(…)` into access: compile
 * `whenSql` so NULL counts as TRUE inside restrict, cap and threshold sub-queries (COALESCE).
 *
 * Canonical (a decision cache key): object keys sorted; `subjects`, `config` and `companions`
 * sorted by their canonical JSON, `rules` by id, `ceilingRoles` and the route's lists by name
 * (UTF-16 code units, as JavaScript compares strings); no duplicates. A compiler refuses another
 * `v` or an unknown key; the parsers here do. The builders refuse what the parsers would.
 */

export type BoundCondition = Condition | { readonly const: boolean | null } | { readonly all: readonly BoundCondition[] } | { readonly any: readonly BoundCondition[] } | { readonly not: BoundCondition };

export interface BoundRule {
  readonly id: string;
  readonly kind: RuleDef['kind'];
  readonly scope: ResourceRef;
  readonly rank?: NonNullable<RuleDef['subjects']>['rank'];
  readonly when?: BoundCondition;
  readonly resource?: BoundCondition;
  readonly ladder?: string;
  readonly maxRole?: string | { readonly ref: string } | null;
  readonly stripTags?: boolean;
  readonly assignments?: RuleDef['assignments'];
  readonly allow?: readonly RbacArgsSubject[];
  readonly minRole?: string | { readonly ref: string };
  readonly at?: string;
  /** A check could not decide the rule: every row on its path is refused. */
  readonly indeterminate?: true;
}

export interface RbacListContext {
  readonly permission: Permission;
  readonly subjects: readonly RbacArgsSubject[];
  readonly config: readonly { readonly subject: PrincipalRef; readonly role: string }[];
  readonly ceilingRoles?: readonly string[];
  readonly principal: PrincipalRef;
  readonly companions: readonly PrincipalRef[];
  readonly actor?: PrincipalRef;
  readonly rules: readonly BoundRule[];
  readonly dbRules: boolean;
}

export interface RbacRoute {
  readonly role: string;
  readonly grant: number;
  readonly roles: readonly string[];
  readonly ladder?: string;
  readonly requiresTag?: string;
  readonly grantedAt?: readonly string[];
}

export interface RbacAssignmentArgsV2 extends RbacListContext {
  readonly v: 2;
  readonly route: RbacRoute;
}

export interface RbacThresholdArgs extends RbacListContext {
  readonly v: 1;
  readonly threshold: { readonly rule: string } | { readonly db: true };
}

export const MAX_LIST_RULES = 500;
export const MAX_LIST_SUBJECTS = 1000;

const CONTEXT_KEYS = ['v', 'permission', 'subjects', 'config', 'ceilingRoles', 'principal', 'companions', 'actor', 'rules', 'dbRules'];
const RULE_KEYS = new Set(['id', 'kind', 'scope', 'rank', 'when', 'resource', 'ladder', 'maxRole', 'stripTags', 'assignments', 'allow', 'minRole', 'at', 'indeterminate']);
/** Every other list in the args (config, companions, ceilingRoles, route.roles). */
export const MAX_LIST_ITEMS = 1000;
/** The whole args as JSON: they are a decision cache key. */
export const MAX_LIST_ARGS_LENGTH = 1_000_000;

/** The canonical args v2 of `native:rbac.assignment`. @throws Error past the size bounds */
export function rbacAssignmentArgsV2(context: RbacListContext, route: RbacRoute): RbacAssignmentArgsV2 {
  if (route.roles.length > MAX_LIST_ITEMS) throw new Error(`rbac: ${route.roles.length} route roles exceed the ${MAX_LIST_ITEMS} a list term may hold`);
  return bounded(canonical({ v: 2, ...canonicalContext(context), route: { ...route, roles: sortedUnique(route.roles), ...(route.grantedAt ? { grantedAt: sortedUnique(route.grantedAt) } : {}) } }) as RbacAssignmentArgsV2);
}

/** The canonical args of `native:rbac.threshold`. @throws Error past the size bounds */
export function rbacThresholdArgs(context: RbacListContext, threshold: RbacThresholdArgs['threshold']): RbacThresholdArgs {
  return bounded(canonical({ v: 1, ...canonicalContext(context), threshold }) as RbacThresholdArgs);
}

function bounded<T>(args: T): T {
  const length = JSON.stringify(args).length;
  if (length > MAX_LIST_ARGS_LENGTH) throw new Error(`rbac: list args of ${length} characters exceed the ${MAX_LIST_ARGS_LENGTH} a list term may hold`);
  return args;
}

function canonicalContext(c: RbacListContext): RbacListContext {
  const subjects = new Map<string, RbacArgsSubject>();
  for (const s of c.subjects) {
    const copy = copySubject(s as Parameters<typeof copySubject>[0]);
    subjects.set(JSON.stringify(canonical(copy)), copy);
  }
  if (subjects.size > MAX_LIST_SUBJECTS) throw new Error(`rbac: ${subjects.size} subjects exceed the ${MAX_LIST_SUBJECTS} a list term may hold`);
  if (c.rules.length > MAX_LIST_RULES) throw new Error(`rbac: ${c.rules.length} rules exceed the ${MAX_LIST_RULES} a list term may hold`);
  for (const [what, list] of [
    ['config', c.config],
    ['companions', c.companions],
    ['ceilingRoles', c.ceilingRoles ?? []],
  ] as const) {
    if (list.length > MAX_LIST_ITEMS) throw new Error(`rbac: ${list.length} ${what} exceed the ${MAX_LIST_ITEMS} a list term may hold`);
  }
  const byJson = <T>(list: readonly T[]) => [...new Map(list.map((x) => [JSON.stringify(canonical(x)), x])).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, x]) => x);
  return {
    permission: c.permission,
    subjects: [...subjects.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, s]) => s),
    config: byJson(c.config.map((x) => ({ subject: { type: x.subject.type, id: x.subject.id }, role: x.role }))),
    ...(c.ceilingRoles ? { ceilingRoles: sortedUnique(c.ceilingRoles) } : {}),
    principal: { type: c.principal.type, id: c.principal.id },
    companions: byJson(c.companions.map((p) => ({ type: p.type, id: p.id }))),
    ...(c.actor ? { actor: { type: c.actor.type, id: c.actor.id } } : {}),
    rules: [...c.rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    dbRules: c.dbRules,
  };
}

/** Reads list args back (either op). @throws Error naming the problem, for anything but the exact canonical shape */
export function parseRbacListArgs(op: typeof RBAC_ASSIGNMENT_OP, args: unknown): RbacAssignmentArgsV2;
export function parseRbacListArgs(op: typeof RBAC_THRESHOLD_OP, args: unknown): RbacThresholdArgs;
export function parseRbacListArgs(op: typeof RBAC_ASSIGNMENT_OP | typeof RBAC_THRESHOLD_OP, args: unknown): RbacAssignmentArgsV2 | RbacThresholdArgs {
  const fail = (problem: string): never => {
    throw new Error(`${op}: ${problem}`);
  };
  if (!isObject(args)) return fail('args must be an object');
  const assignment = op === RBAC_ASSIGNMENT_OP;
  if (args.v !== (assignment ? 2 : 1)) fail(`unsupported args version ${JSON.stringify(args.v)}`);
  const allowed = new Set([...CONTEXT_KEYS, assignment ? 'route' : 'threshold']);
  const unknown = Object.keys(args).filter((k) => !allowed.has(k));
  if (unknown.length > 0) fail(`unknown args key(s) ${unknown.join(', ')}`);
  if (typeof args.permission !== 'string' || args.permission === '') fail('permission must be a permission name');
  if (!Array.isArray(args.subjects) || args.subjects.length > MAX_LIST_SUBJECTS || !args.subjects.every((s) => readSubject(s) !== undefined)) fail('subjects must be a list of subjects');
  if (JSON.stringify(args).length > MAX_LIST_ARGS_LENGTH) fail(`args longer than ${MAX_LIST_ARGS_LENGTH} characters`);
  if (!Array.isArray(args.config) || args.config.length > MAX_LIST_ITEMS || !args.config.every((c) => isObject(c) && isRef(c.subject) && typeof c.role === 'string')) fail('config must be a list of { subject, role }');
  if (args.ceilingRoles !== undefined && !(Array.isArray(args.ceilingRoles) && args.ceilingRoles.length <= MAX_LIST_ITEMS && args.ceilingRoles.every((r) => typeof r === 'string'))) fail('ceilingRoles must be a list of role names');
  if (!isRef(args.principal)) fail('principal must be { type, id }');
  if (!Array.isArray(args.companions) || args.companions.length > MAX_LIST_ITEMS || !args.companions.every(isRef)) fail('companions must be a list of { type, id }');
  if (args.actor !== undefined && !isRef(args.actor)) fail('actor must be { type, id }');
  if (!Array.isArray(args.rules) || args.rules.length > MAX_LIST_RULES) fail(`rules must be a list of at most ${MAX_LIST_RULES} rules`);
  for (const r of args.rules as unknown[]) {
    if (!isObject(r) || typeof r.id !== 'string' || !['restrict', 'cap', 'threshold'].includes(r.kind as string) || !isObject(r.scope) || typeof r.scope.type !== 'string') fail('every rule needs id, kind and scope');
    const extra = Object.keys(r as object).filter((k) => !RULE_KEYS.has(k));
    if (extra.length > 0) fail(`unknown rule key(s) ${extra.join(', ')}`);
    if ((r as { indeterminate?: unknown }).indeterminate !== undefined && (r as { indeterminate?: unknown }).indeterminate !== true) fail('indeterminate must be true when present');
  }
  const ids = (args.rules as { id: string }[]).map((x) => x.id);
  if (new Set(ids).size !== ids.length) fail('two rules share an id');
  if (typeof args.dbRules !== 'boolean') fail('dbRules must be true or false');
  if (assignment) {
    const route = args.route;
    if (!isObject(route) || typeof route.role !== 'string' || !Number.isInteger(route.grant) || (route.grant as number) < 0 || !Array.isArray(route.roles) || route.roles.length > MAX_LIST_ITEMS || !route.roles.every((x) => typeof x === 'string')) fail('route must be { role, grant, roles, ladder?, requiresTag?, grantedAt? }');
    const extra = Object.keys(route as object).filter((k) => !['role', 'grant', 'roles', 'ladder', 'requiresTag', 'grantedAt'].includes(k));
    if (extra.length > 0) fail(`unknown route key(s) ${extra.join(', ')}`);
  } else {
    const t = args.threshold;
    if (!isObject(t) || !((Object.keys(t).length === 1 && typeof t.rule === 'string') || (Object.keys(t).length === 1 && t.db === true))) fail('threshold must be { rule } or { db: true }');
  }
  const context = canonicalContext(args as unknown as RbacListContext);
  const rebuilt = assignment ? rbacAssignmentArgsV2(context, args.route as unknown as RbacRoute) : rbacThresholdArgs(context, args.threshold as RbacThresholdArgs['threshold']);
  if (JSON.stringify(rebuilt) !== JSON.stringify(args)) fail('args are not in canonical form (sorted, without duplicates)');
  return args as unknown as RbacAssignmentArgsV2 | RbacThresholdArgs;
}

/** A bound condition as a core Condition: UNKNOWN reads a principal attribute the list principal never has. */
export function coreCondition(c: BoundCondition): Condition {
  const n = c as Record<string, unknown>;
  if ('const' in n) return n.const === true ? { all: [] } : n.const === false ? { any: [] } : UNKNOWN_CONDITION;
  if (Array.isArray(n.all)) return { all: (n.all as BoundCondition[]).map(coreCondition) };
  if (Array.isArray(n.any)) return { any: (n.any as BoundCondition[]).map(coreCondition) };
  if (n.not !== undefined) return { not: coreCondition(n.not as BoundCondition) };
  return c as Condition;
}

const UNKNOWN_CONDITION: Condition = Object.freeze({ attr: 'principal.attributes.$unbound', eq: true });

/** A bound rule as the RuleDef the steps take. */
export function ruleDefOf(r: BoundRule, permission: Permission): RuleDef {
  return {
    id: r.id,
    kind: r.kind,
    scope: r.scope,
    source: 'list',
    ...(r.rank ? { subjects: { rank: r.rank } } : {}),
    ...(r.when ? { when: coreCondition(r.when) } : {}),
    ...(r.resource ? { resource: coreCondition(r.resource) } : {}),
    ...(r.ladder !== undefined ? { ladder: r.ladder } : {}),
    ...(r.maxRole !== undefined ? { maxRole: r.maxRole } : {}),
    ...(r.stripTags !== undefined ? { stripTags: r.stripTags } : {}),
    ...(r.assignments ? { assignments: r.assignments } : {}),
    ...(r.allow ? { allow: r.allow as RuleDef['allow'] } : {}),
    ...(r.minRole !== undefined ? { minRole: r.minRole } : {}),
    ...(r.at !== undefined ? { at: r.at } : {}),
    ...(r.kind === 'threshold' ? { permissions: [permission] } : {}),
  } as RuleDef;
}

/** Objects with their keys sorted, recursively; arrays keep their order. */
export function canonical<T>(value: T): T {
  if (Array.isArray(value)) return value.map(canonical) as T;
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const o = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => [k, canonical(o[k])]),
    ) as T;
  }
  return value;
}

const sortedUnique = (list: readonly string[]): string[] => [...new Set(list)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRef = (v: unknown): boolean => isObject(v) && typeof v.type === 'string' && typeof v.id === 'string' && Object.keys(v).length === 2;
