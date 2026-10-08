import { AuthzConfigError, DEFAULT_DENY_PRIORITY, FALSE, GLOBAL, TRUE, and, compareDenyReasons, or, principalKey, resourceKey } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, AuthzContribution, DecisionRequest, DenyReason, EvaluationContext, FieldSet, FilterOp, ModelCapabilities, ModelInitContext, NativeFilter, Permission, PermissionRegistry, Principal, PrincipalRef, ResourceFilter, ResourceRef, ResourceType, Vote } from '@spinajs/authz';

import { RBAC_ASSIGNMENT_OP } from '../contracts.js';
import type { AssignmentStore, LinkStore, RuleStore, SubjectResolver } from '../contracts.js';
import { expiryTime } from './assignments.js';
import { ceilingRoles, withinCeiling } from './ceiling.js';
import { underTerm } from './rows.js';
import { compileFieldSet, intersectFieldGlobs, summaryFieldGlobs, voteFieldGlobs } from './fields.js';
import type { FieldGlobs } from './fields.js';
import type { CompiledGrant, GrantIndex } from './grants.js';
import { ladderExtension } from './ladder/extension.js';
import { checkProvenance, checkTags, grantChecks } from './ladder/checks.js';
import { addImplied, impliesExtension } from './ladder/implies.js';
import type { ImpliesIndex } from './ladder/implies.js';
import type { LadderIndex } from './ladder/ladders.js';
import { rulesExtension } from './rules/extension.js';
import { applyCaps, applyRestrict, applyThresholds } from './rules/steps.js';
import { nativeListVote } from './rules/native.js';
import type { NativeListInput } from './rules/native.js';
import type { ActiveRule } from './rules/steps.js';
import type { CompiledRule } from './rules/compile.js';
import { applyMemberships, setsExtension, usableSubjects } from './sets/extension.js';
import type { SetMemberships } from './sets/resolver.js';
import { aggregateRanks, rankAssignments, reachableGrants, roleTooLow } from './ladder/steps.js';
import type { RbacModelOptions } from './model.js';
import { isTypeLevel, patternsFilter } from './patterns.js';
import type { PatternContext } from './patterns.js';
import { rbacAssignmentArgs, scopeMatcher } from './native.js';
import { assignmentProblem } from './roles.js';
import type { AssignmentProblem, CompileRolesOptions, RoleGraph } from './roles.js';

/*
 * The RBAC evaluation of design §6.1.2. An async gathering phase does all the IO and yields an
 * RbacInput; nine named steps then run synchronously over one RbacState, in RBAC_STEP_NAMES order,
 * and the state becomes the Vote. Hook contract:
 * - RBAC_STEPS maps every step name to `(state) => void`, plus `noGrantReason` (the step 5 reason
 *   when no grant of the permission is reachable, `no_access` by default). Replacing an entry
 *   fills that step. Steps never do IO and write only their own part of the state.
 * - Everything outside the steps goes through an RbacExtension (model init, role edges, compile at
 *   boot, gathering, boot refs, native ops). DEFAULT_RBAC_EXTENSIONS lists their factories; a model
 *   creates its own instances, so an extension may keep per-model state.
 * - A grant that fails a check sets `candidate.failed` and pushes a reason (steps 5–7): a failed
 *   grant permits nothing. `state.reasons` alone feeds Vote.reason ("why it does not permit"), and
 *   only while nothing permits; it never denies, so another model's permit still wins under
 *   permit-overrides. A deny entry (step 8) goes to `state.denies`, which feeds Vote.denies and
 *   denyWhen only: the engine reads each entry's reason where its `when` holds.
 * - On a type-level request `collect` puts live assignments off the path `[type, GLOBAL]` in
 *   `state.scoped`; `residual` turns each grant they reach into a row filter (`under` their
 *   scopes, or `native:rbac.assignment`) ANDed with the grant's own residual. A request on
 *   `$global` is not type-level (isTypeLevel): its path is `[GLOBAL]` and it has no rows. Scoped grants never become
 *   `candidates`, so steps 5–8 do not see them. Steps that drop or clamp assignments (restrict,
 *   cap, implies) must treat `state.scoped` as they treat `state.live`. A scoped grant with
 *   `requiresTag`, `grantedAt` or a threshold rule depends on which holder applies to each row, so
 *   it must carry that part in the term (args v2, or one term per holder with its own check),
 *   never be emitted bare: a bare term would list rows the check refuses.
 * - `state.fields` set by a step before `residual` is a cap: `residual` intersects the grants'
 *   fields with it, and keeps it as it is when no contributing grant carries fields.
 * - With a list extension (`listsRules`, rbacAssignmentExtension with `rules: true`), a type-level
 *   request whose rows depend on rules (or on a part the v1 term cannot carry: NativeNeedsV2) is
 *   answered by `nativeListVote` after `collect`: args v2 and `native:rbac.threshold` terms
 *   (rules/args.ts), which the list evaluator decides per row by running these steps on the row.
 */

export const RBAC_STEP_NAMES = Object.freeze(['collect', 'restrict', 'cap', 'aggregate', 'grant', 'tag', 'provenance', 'threshold', 'residual'] as const);

export type RbacStepName = (typeof RBAC_STEP_NAMES)[number];

export type RbacStep = (state: RbacState) => void;

export type RbacSteps = Readonly<Record<RbacStepName, RbacStep>> & {
  /** The step 5 reason when `grant` leaves no candidate; the runner calls it right after `grant`. */
  readonly noGrantReason: (state: RbacState) => DenyReason;
  /** How a vote's fields combine the grants' (default voteFieldGlobs); the list terms (args v2) follow it too. */
  readonly fieldGlobs?: FieldRule;
};

export type FieldRule = (unconditional: readonly (FieldGlobs | undefined)[], conditional: readonly (FieldGlobs | undefined)[]) => FieldGlobs | undefined;

/** What the gathering phase loaded for one request. */
export interface RbacInput {
  readonly request: DecisionRequest;
  readonly now: Date;
  /** Scopes whose assignments apply to the resource, nearest first: the resource, its ancestors in order, GLOBAL last. */
  readonly path: readonly ResourceRef[];
  /** The principal's subjects the assignments were read for; default: the principal and its companions. */
  readonly subjects?: readonly AssignmentSubject[];
  /**
   * How a type-level vote lists rows that only scoped assignments reach: `under` over their scopes
   * (default, core ops), or `native` (`native:rbac.assignment`, set by rbacAssignmentExtension).
   */
  readonly scopedResidual?: 'under' | 'native';
  /** Assignments of the principal's subjects, config roles included; `collect` keeps the live ones. */
  readonly assignments: readonly Assignment[];
  /** The config roles among `assignments` (anonymousRoles, serviceRoles): in no store. */
  readonly config?: readonly Assignment[];
  readonly roles: RoleGraph;
  readonly grants: GrantIndex;
  /** Rank tables (RbacExtension.tables); absent: no role has a rank and every grant applies on every type. */
  readonly ladders?: LadderIndex;
  /** What each role implies (RbacExtension.tables); absent: no role implies another. */
  readonly implies?: ImpliesIndex;
  /** The sets the principal joined through its own assignments (SetsExtension), by subjectKey. */
  readonly memberships?: SetMemberships;
  /** The rules that hold for this request (RulesExtension), their request-level parts decided. */
  readonly rules?: readonly ActiveRule[];
  /** Ids of rules that would apply differently per row of this type-level request: the rule steps fail closed. */
  readonly rowDependentRules?: readonly string[];
  /** False when a rule condition gave an uncacheable answer. */
  readonly rulesCacheable?: boolean;
  /** Type-level requests with a list extension: the rules part of the list terms (RulesExtension). */
  readonly native?: NativeListInput;
  /** Called by `collect` for an assignment whose role the graph does not hold (B12: ignored). */
  readonly onUnknownRole?: (assignment: Assignment) => void;
  /** Called by `collect` for an assignment its role's definition refuses (`assignable`, `scopeTypes`): ignored. */
  readonly onRefusedAssignment?: (assignment: Assignment, problem: Exclude<AssignmentProblem, 'unknown_role'>) => void;
}

export interface LiveAssignment {
  readonly assignment: Assignment;
  readonly role: string;
  readonly scope: ResourceRef;
  /** `cap` with `stripTags` empties it. */
  tags: readonly string[];
  readonly expiresAt?: Date;
  /** Rules this contribution skips (`implies` with `bypass`). */
  readonly bypass: Set<'restrict' | 'cap'>;
  /** Set on an implied role's assignment: the assignment that implies it. */
  readonly impliedBy?: LiveAssignment;
  /** Set on an implied role with at: 'descendants': it holds below `scope`, not at it. */
  readonly onlyBelow?: boolean;
  /** Rank on the role's ladder; `cap` may lower it. */
  rank?: number;
}

/** A grant of the requested permission and the live assignments whose roles reach it. */
export interface RbacCandidate {
  readonly grant: CompiledGrant;
  readonly holders: readonly LiveAssignment[];
  failed: boolean;
  /** Steps 6–7 on a type-level request: the rows where the grant's checks hold, ANDed into its permit. */
  rows?: ResourceFilter;
}

export interface RbacDeny {
  readonly when: ResourceFilter;
  readonly reason: DenyReason;
}

export interface RbacState {
  readonly input: RbacInput;
  readonly permission: Permission;
  /** The request principal's `ceiling.roles`; undefined: no filter. Read it through `withinCeiling`. */
  readonly ceilingRoles?: ReadonlySet<string>;
  /** collect, restrict, cap */
  live: LiveAssignment[];
  /** collect, type-level requests only (`$global` is not one): live assignments off the path, which permit the rows below their scopes. */
  scoped: LiveAssignment[];
  /** aggregate: the effective role per ladder (Vote.roles). */
  readonly roles: Record<string, string>;
  /** aggregate: the union of live tags, for introspection; step 6 reads the carriers in `live` (and `scoped`) itself. */
  readonly tags: Set<string>;
  /** grant */
  candidates: RbacCandidate[];
  /** grant, tag, provenance: why the model does not permit (Vote.reason). */
  readonly reasons: DenyReason[];
  /** threshold (Vote.denies, denyWhen) */
  readonly denies: RbacDeny[];
  /** residual: OR-ed into permitWhen. */
  readonly permit: ResourceFilter[];
  fields?: FieldSet;
  validUntil?: Date;
  cacheable: boolean;
  /** rankAt[ladder, types] of step 4, filled on first use (ladder/checks.ts rankAt). */
  readonly rankAt: Map<string, number | undefined>;
  /** cap: whether each threshold rule's `subjects.rank` selects the principal (ranks after restrict, before cap). Keyed by the rule: ids may repeat or be missing. */
  readonly ruleSubjects: Map<CompiledRule, boolean>;
}

const collect: RbacStep = (s) => {
  const { assignments, path, roles, now, onUnknownRole, onRefusedAssignment } = s.input;
  const onPath = scopeMatcher(s.input.request.resource.type, path);
  const typeLevel = isTypeLevel(s.input.request.resource);
  for (const a of assignments) {
    const here = onPath(a.scope);
    // Off the path only a scope with an id can reach rows of a type-level request (state.scoped).
    // An assignment the ceiling drops cannot change the vote, so its row is never parsed.
    if ((!here && (!typeLevel || a.scope.id == null)) || !withinCeiling(s, a.role)) continue;
    const expires = expiryTime(a);
    // Dropping the row would read as a clean, cacheable "no"; the engine makes a throw model_error (fail closed).
    if (Number.isNaN(expires)) throw new Error(`rbac: assignment '${a.id}' (source: ${a.source}, role '${a.role}') has an unreadable expiresAt`);
    if (expires !== undefined && expires <= now.getTime()) continue;
    const problem = assignmentProblem(roles, a.role, a.scope);
    if (problem === 'unknown_role') onUnknownRole?.(a);
    // A row stored before its role was narrowed would reach the scopes scopeTypes exists to keep it from.
    else if (problem) onRefusedAssignment?.(a, problem);
    if (problem) continue;
    (here ? s.live : s.scoped).push({ assignment: a, role: a.role, scope: a.scope, tags: a.tags ?? [], ...(expires !== undefined ? { expiresAt: new Date(expires) } : {}), bypass: new Set() });
  }
};

const grant: RbacStep = (s) => {
  const holders = new Map<CompiledGrant, LiveAssignment[]>();
  for (const live of s.live) {
    for (const g of reachableGrants(s, live)) {
      const list = holders.get(g);
      if (list) list.push(live);
      else holders.set(g, [live]);
    }
  }
  s.candidates = [...holders].map(([g, h]) => ({ grant: g, holders: h, failed: false }));
};

/** The rows a passing grant permits: the AND of its conditions; a grant with none permits every row. */
export function grantResidual(grant: CompiledGrant, at: PatternContext): ResourceFilter {
  return and(relationResidual(grant), grant.patterns ? patternsFilter(grant.patterns, at) : TRUE);
}

/** Several relations of one grant OR (B15). */
function relationResidual(grant: CompiledGrant): ResourceFilter {
  if (!grant.relations) return TRUE;
  return or(...grant.relations.map((relation): ResourceFilter => ({ op: 'relation', relation })));
}

/*
 * validUntil bounds the vote by the earliest expiry among the holders of every candidate, refused
 * ones included: such an expiry can end a permit or change the reason. An assignment whose roles
 * do not reach the permission cannot change this vote, so its expiry is left out. Steps that read
 * other assignments (aggregate for Vote.roles) lower state.validUntil themselves.
 *
 * Fields (voteFieldGlobs): grants whose residual is TRUE for this request decide them; only when
 * none is TRUE do the conditional grants, by intersection. A grant whose residual is FALSE adds none.
 * RBAC_SUMMARY_STEPS passes summaryFieldGlobs instead.
 */
function residualWith(s: RbacState, fieldGlobs: FieldRule): void {
  const ends: number[] = s.validUntil ? [s.validUntil.getTime()] : [];
  const at: PatternContext = { resource: s.input.request.resource, path: s.input.path, principal: s.input.request.principal };
  const unconditional: (FieldGlobs | undefined)[] = [];
  const conditional: (FieldGlobs | undefined)[] = [];
  for (const c of s.candidates) {
    if (!c.failed) {
      if (c.rows) nativeCannotCarry(s);
      const permits = and(grantResidual(c.grant, at), c.rows ?? TRUE);
      s.permit.push(permits);
      if (permits.op === 'true') unconditional.push(c.grant.fieldGlobs);
      else if (permits.op !== 'false') conditional.push(c.grant.fieldGlobs);
    }
    for (const h of c.holders) if (h.expiresAt) ends.push(h.expiresAt.getTime());
  }
  for (const [g, holders] of scopedGrants(s)) {
    const checks = grantChecks(s, g);
    if (checks.some((c) => c.rows.op !== 'true' && c.rows.op !== 'false')) nativeCannotCarry(s);
    const permits = and(scopedRows(s, holders), grantResidual(g, at), ...checks.map((c) => c.rows));
    s.permit.push(permits);
    if (permits.op !== 'false') conditional.push(g.fieldGlobs);
    for (const h of [...holders, ...checks.flatMap((c) => c.read)]) if (h.expiresAt) ends.push(h.expiresAt.getTime());
  }
  if (ends.length > 0) s.validUntil = new Date(Math.min(...ends));
  const fields = fieldGlobs(unconditional, conditional);
  if (fields) s.fields = s.fields ? intersectFieldGlobs(fields, compileFieldSet(s.fields, 'rbac: the fields an earlier step set')) : fields;
}

const residual: RbacStep = (s) => residualWith(s, voteFieldGlobs);

// The v1 native term has no part for tags or provenance; a bare one would list rows the check refuses.
function nativeCannotCarry(s: RbacState): void {
  if (s.input.scopedResidual === 'native') throw new (s.input.native ? NativeNeedsV2 : Error)(`rbac: ${RBAC_ASSIGNMENT_OP} v1 cannot carry the tag or provenance part of '${s.permission}' on a type-level request; use rbacAssignmentExtension with rules: true for this type`);
}

/** The grants of the permission that scoped assignments reach, with those assignments. */
function scopedGrants(s: RbacState): Map<CompiledGrant, LiveAssignment[]> {
  const out = new Map<CompiledGrant, LiveAssignment[]>();
  for (const live of s.scoped) {
    for (const g of reachableGrants(s, live)) {
      const list = out.get(g);
      if (list) list.push(live);
      else out.set(g, [live]);
    }
  }
  return out;
}

/**
 * The rows below the holders' scopes, canonical: sorted by key, without duplicates. An implied role
 * with at: 'descendants' (`onlyBelow`) leaves its scope itself out, which only a row of the scope's
 * own type can be.
 */
function scopedRows(s: RbacState, holders: readonly LiveAssignment[]): ResourceFilter {
  const type = s.input.request.resource.type;
  if (s.input.scopedResidual === 'native') {
    // The term holds on every assignment of the stored role on the row's path, the row itself included.
    const strict = holders.find((h) => h.onlyBelow && mayBeAssignedAt(s.input.roles, h.assignment.role, type));
    if (strict) throw new (s.input.native ? NativeNeedsV2 : Error)(`rbac: role '${strict.role}' is implied by '${strict.assignment.role}' below its scope only, which ${RBAC_ASSIGNMENT_OP} cannot express on type '${type}'`);
    return {
      op: RBAC_ASSIGNMENT_OP,
      args: rbacAssignmentArgs(
        usableSubjects(s) ?? defaultSubjects(s.input.request.principal),
        holders.map((h) => h.assignment.role),
      ),
    };
  }
  return underTerm(holders, type);
}

function mayBeAssignedAt(roles: RoleGraph, role: string, type: ResourceType): boolean {
  const types = roles.get(role)?.scopeTypes;
  return types === undefined || types.includes(type);
}

export const RBAC_STEPS: RbacSteps = Object.freeze({
  collect: (s: RbacState) => {
    collect(s);
    applyMemberships(s);
    addImplied(s);
    rankAssignments(s);
  },
  restrict: applyRestrict,
  cap: applyCaps,
  aggregate: aggregateRanks,
  grant,
  tag: checkTags,
  provenance: checkProvenance,
  threshold: applyThresholds,
  residual,
  noGrantReason: (s: RbacState): DenyReason => roleTooLow(s) ?? { code: 'no_access', priority: DEFAULT_DENY_PRIORITY.no_access },
});

/** `steps` whose votes take their fields by `fieldGlobs`, in the residual step and in the list terms. */
export function withFieldRule(steps: RbacSteps, fieldGlobs: FieldRule): RbacSteps {
  return Object.freeze({ ...steps, fieldGlobs, residual: (s: RbacState) => residualWith(s, fieldGlobs) });
}

/** RBAC_STEPS for `RbacModel.summarize`: each vote lists the fields of every grant that permits some row (`summaryFieldGlobs`). */
export const RBAC_SUMMARY_STEPS: RbacSteps = withFieldRule(RBAC_STEPS, summaryFieldGlobs);

/** Runs the steps over the gathered input, synchronously. */
export function runRbacPipeline(input: RbacInput, steps: RbacSteps = RBAC_STEPS): Vote {
  if (input.native && isTypeLevel(input.request.resource)) {
    // Rules make every row's answer depend on its path: the list terms carry them (args v2).
    if (input.native.rules.length > 0 || input.native.dbRules) return nativeVote(input, steps);
    try {
      return toVote(rbacState(input, 'residual', steps));
    } catch (e) {
      if (e instanceof NativeNeedsV2) return nativeVote(input, steps);
      throw e;
    }
  }
  return toVote(rbacState(input, 'residual', steps));
}

/** The state after the steps up to `through`, in order (the list evaluator stops before `residual`). */
export function rbacState(input: RbacInput, through: RbacStepName = 'residual', steps: RbacSteps = RBAC_STEPS): RbacState {
  const state = newState(input, true);
  for (const name of RBAC_STEP_NAMES) {
    steps[name](state);
    if (name === 'grant' && state.candidates.length === 0) state.reasons.push(steps.noGrantReason(state));
    if (name === through) break;
  }
  return state;
}

function nativeVote(input: RbacInput, steps: RbacSteps): Vote {
  const state = newState(input, true);
  steps.collect(state);
  const fields = steps.fieldGlobs ?? voteFieldGlobs;
  nativeListVote(state, (g) => grantResidual(g, { resource: input.request.resource, path: input.path, principal: input.request.principal }), input.subjects ?? defaultSubjects(input.request.principal), fields);
  return toVote(state);
}

/** A type-level vote the v1 term cannot carry; with a list extension the runner builds args v2 instead. */
export class NativeNeedsV2 extends Error {}

/**
 * Steps 1–3 (collect, restrict, cap) over the input: the assignments that hold at the request's
 * resource (`live`) and, on a type-level request, those below it (`scoped`). `ceiling: false` skips
 * the principal's `ceiling.roles`, for callers that need the assigned roles (a role switch).
 */
export function liveAssignments(input: RbacInput, opts: { readonly ceiling?: boolean } = {}, steps: RbacSteps = RBAC_STEPS): { readonly live: readonly LiveAssignment[]; readonly scoped: readonly LiveAssignment[] } {
  const state = newState(input, opts.ceiling !== false);
  for (const name of ['collect', 'restrict', 'cap'] as const) steps[name](state);
  return { live: state.live, scoped: state.scoped };
}

function newState(input: RbacInput, ceiling: boolean): RbacState {
  const roles = ceiling ? ceilingRoles(input.request.principal) : undefined;
  return { input, permission: input.request.permission, ...(roles ? { ceilingRoles: roles } : {}), live: [], scoped: [], roles: {}, tags: new Set(), candidates: [], reasons: [], denies: [], permit: [], cacheable: input.native?.cacheable !== false, rankAt: new Map(), ruleSubjects: new Map() };
}

// OR is order-free, but the residual enters the cross-request decision cache key and SQL statement
// caches: equal states must give equal JSON.
function canonicalOrder(terms: readonly ResourceFilter[]): ResourceFilter[] {
  return terms
    .map((t) => [JSON.stringify(t), t] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, t]) => t);
}

function toVote(s: RbacState): Vote {
  const permitWhen = s.permit.length > 0 ? or(...canonicalOrder(s.permit)) : FALSE;
  const denies = s.denies.filter((d) => or(d.when).op !== 'false');
  const denyWhen = denies.length > 0 ? or(...denies.map((d) => d.when)) : FALSE;
  const reason = permitWhen.op === 'true' ? undefined : [...s.reasons].sort(compareDenyReasons)[0];
  return {
    model: 'rbac',
    permitWhen,
    denyWhen,
    ...(denies.length > 0 ? { denies } : {}),
    ...(reason ? { reason } : {}),
    roles: { ...s.roles },
    ...(s.fields ? { fields: s.fields } : {}),
    ...(s.validUntil ? { validUntil: s.validUntil } : {}),
    cacheable: s.cacheable,
  };
}

/** Where the gathering phase reads from. */
export interface RbacSources {
  readonly roles: RoleGraph;
  readonly grants: GrantIndex;
  readonly assignments: AssignmentStore;
  readonly subjects?: SubjectResolver;
  readonly rules?: RuleStore | readonly RuleStore[];
  readonly links?: LinkStore;
  readonly extensions?: readonly RbacExtension[];
  /** Assignments the config gives these subjects at GLOBAL (anonymousRoles, serviceRoles). */
  readonly configAssignments?: (subjects: readonly AssignmentSubject[]) => readonly Assignment[];
  /** Reads the subjects' assignments in place of `assignments.forSubjects(subjects, ctx.now)` (the model's cache). */
  readonly load?: (subjects: readonly AssignmentSubject[], ctx: EvaluationContext) => readonly Assignment[] | Promise<readonly Assignment[]>;
  readonly onUnknownRole?: (assignment: Assignment) => void;
  readonly onRefusedAssignment?: RbacInput['onRefusedAssignment'];
}

type Maybe<T> = T | PromiseLike<T>;

const isThenable = <T>(v: Maybe<T> | undefined): v is PromiseLike<T> => typeof (v as { then?: unknown } | null | undefined)?.then === 'function';

/** Runs `next` on the value now, or once the promise resolves. */
function after<T, U>(value: Maybe<T>, next: (value: T) => Maybe<U>): Maybe<U> {
  return isThenable(value) ? Promise.resolve(value).then(next) : next(value);
}

/**
 * The IO phase: subjects, their assignments, the path, then what the extensions gather. Answered
 * synchronously when no source needs IO: the subjects and assignments come back as values (a
 * type-level request after preload, B22), and so do the extensions' gathers.
 */
export function readRbacInput(request: DecisionRequest, ctx: EvaluationContext, sources: RbacSources): RbacInput | Promise<RbacInput> {
  const subjects = sources.subjects ? sources.subjects.subjects(request.principal) : defaultSubjects(request.principal);
  const input = after(subjects, (subjects) =>
    after(sources.load ? sources.load(subjects, ctx) : sources.assignments.forSubjects(subjects, ctx.now), (stored) =>
      after(resourcePath(request.resource, ctx), (path) =>
        extendInput(request, ctx, sources, 0, {
          request,
          now: ctx.now,
          path,
          subjects,
          ...withConfig(stored, sources.configAssignments?.(subjects) ?? []),
          roles: sources.roles,
          grants: sources.grants,
          ...(sources.onUnknownRole ? { onUnknownRole: sources.onUnknownRole } : {}),
          ...(sources.onRefusedAssignment ? { onRefusedAssignment: sources.onRefusedAssignment } : {}),
        }),
      ),
    ),
  );
  return isThenable(input) ? Promise.resolve(input) : input;
}

const withConfig = (stored: readonly Assignment[], config: readonly Assignment[]) => ({ assignments: [...stored, ...config], ...(config.length > 0 ? { config } : {}) });

/** Merges the extensions' `gather` results into `input`, in list order; synchronous while each gather is. */
export function extendRbacInput(request: DecisionRequest, ctx: EvaluationContext, sources: RbacSources, input: RbacInput): RbacInput | Promise<RbacInput> {
  const out = extendInput(request, ctx, sources, 0, input);
  return isThenable(out) ? Promise.resolve(out) : out;
}

function extendInput(request: DecisionRequest, ctx: EvaluationContext, sources: RbacSources, from: number, input: RbacInput): Maybe<RbacInput> {
  const extensions = sources.extensions ?? [];
  if (from === 0) input = { ...input, ...rbacTables(extensions, input.roles, input.grants) };
  for (let i = from; i < extensions.length; i++) {
    const part = extensions[i].gather?.(request, ctx, input, sources);
    if (isThenable(part)) return Promise.resolve(part).then((p) => extendInput(request, ctx, sources, i + 1, { ...input, ...tableFree(p) }));
    if (part) input = { ...input, ...tableFree(part) };
  }
  return input;
}

/** Tables compiled from the role graph, which RbacService reads too; one source each. */
export interface RbacTables {
  readonly ladders?: LadderIndex;
  readonly implies?: ImpliesIndex;
}

const TABLE_KEYS: readonly (keyof RbacTables)[] = ['ladders', 'implies'];

/**
 * The extensions' tables for `graph`, merged; the gathering phase puts them in every input.
 * @throws AuthzConfigError when two extensions give one table
 */
export function rbacTables(extensions: readonly RbacExtension[], graph: RoleGraph, grants: GrantIndex): RbacTables {
  const out: Record<string, unknown> = {};
  for (const ext of extensions) {
    for (const [key, table] of Object.entries(ext.tables?.(graph, grants) ?? {})) {
      if (table === undefined) continue;
      if (key in out) throw new AuthzConfigError(`rbac: two extensions give the '${key}' table`);
      out[key] = table;
    }
  }
  return out as RbacTables;
}

// A table set by a gather would reach the votes but not RbacService.covers, which reads rbacTables.
function tableFree(part: Partial<RbacInput> | undefined): Partial<RbacInput> | undefined {
  const key = part ? TABLE_KEYS.find((k) => k in part) : undefined;
  if (key) throw new Error(`rbac: an extension's gather set '${key}'; give it through RbacExtension.tables`);
  return part;
}

/**
 * The scopes whose assignments apply to `resource` (B13), nearest first: the resource, its
 * ancestors in order, GLOBAL last, each once. A type-level request gets `[type, GLOBAL]` (§6.1.2),
 * without IO: an assignment at the bare type ref permits every row of the type; any other scoped
 * assignment needs a row filter, which `residual` builds from `state.scoped`. A request on `$global`
 * gets `[GLOBAL]`.
 */
export function resourcePath(resource: ResourceRef, ctx: EvaluationContext): readonly ResourceRef[] | Promise<readonly ResourceRef[]> {
  if (resource.id == null) return resource.type === GLOBAL.type ? [GLOBAL] : [{ type: resource.type }, GLOBAL];
  return ctx.ancestors(resource).then((ancestors) => {
    // The engine denies unknown_resource before the models run; a "no" here would look like a clean answer.
    if (ancestors === null) throw new Error(`rbac: unknown resource ${resourceKey(resource)}: ancestors answered null`);
    const global = resourceKey(GLOBAL);
    const path = new Map<string, ResourceRef>();
    for (const ref of [resource, ...ancestors]) if (resourceKey(ref) !== global && !path.has(resourceKey(ref))) path.set(resourceKey(ref), ref);
    return [...path.values(), GLOBAL];
  });
}

/** The principal and its companions, each once. */
export function defaultSubjects(principal: Principal): readonly AssignmentSubject[] {
  const out = new Map<string, PrincipalRef>();
  for (const p of [principal, ...(principal.companions ?? [])]) {
    const ref = { type: p.type, id: p.id };
    out.set(principalKey(ref), ref);
  }
  return [...out.values()];
}

/** Model-level hooks for the parts of RBAC outside the steps; the model calls them in list order. */
export interface RbacExtension {
  /** In the model's `init`, before the roles compile (config through `ctx.config`). */
  init?(ctx: ModelInitContext): void | Promise<void>;
  /** Role edges beside `extends` (ladder edges). */
  readonly extraEdges?: CompileRolesOptions['extraEdges'];
  /** Right after the grant index is built, at boot through the contributor; throw AuthzConfigError to fail the boot. */
  compile?(graph: RoleGraph, grants: GrantIndex, registry: PermissionRegistry): void;
  /** Tables of the role graph (rank tables); memoise them per graph, the gathering phase asks on every request. */
  tables?(graph: RoleGraph, grants: GrantIndex): RbacTables;
  /** At the end of the gathering phase; the result is merged into the input. */
  gather?(request: DecisionRequest, ctx: EvaluationContext, input: RbacInput, sources: RbacSources): Partial<RbacInput> | Promise<Partial<RbacInput>>;
  /** Boot refs, merged into the contributor's. */
  contribute?(graph: RoleGraph, grants: GrantIndex): AuthzContribution;
  /** Residual ops this extension's steps emit; each `native:*` one needs its filter in `nativeFilters`. */
  readonly residuals?: readonly FilterOp[];
  nativeFilters?(): readonly NativeFilter[];
  /** OR-ed into the model's capabilities. */
  readonly capabilities?: Partial<Pick<ModelCapabilities, 'needsSubject'>>;
  /** Type-level votes carry the rules in native list terms (rbacAssignmentExtension with rules: true). */
  readonly listsRules?: (type: ResourceType) => boolean;
}

export type RbacExtensionFactory = (opts: RbacModelOptions) => RbacExtension;

/** One factory per extension, so every model gets its own instances. */
export const DEFAULT_RBAC_EXTENSIONS: readonly RbacExtensionFactory[] = Object.freeze([ladderExtension, impliesExtension, setsExtension, rulesExtension]);

/** The model's extensions when its options name none: one instance per factory, built with the model options. */
export function createRbacExtensions(opts: RbacModelOptions, factories: readonly RbacExtensionFactory[] = DEFAULT_RBAC_EXTENSIONS): readonly RbacExtension[] {
  return Object.freeze(factories.map((create) => create(opts)));
}
