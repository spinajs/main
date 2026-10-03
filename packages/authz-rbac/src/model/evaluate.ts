import { DEFAULT_DENY_PRIORITY, FALSE, GLOBAL, TRUE, and, compareDenyReasons, or, principalKey, resourceKey } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, AuthzContribution, DecisionRequest, DenyReason, EvaluationContext, FieldSet, FilterOp, ModelCapabilities, ModelInitContext, NativeFilter, Permission, PermissionRegistry, Principal, PrincipalRef, ResourceFilter, ResourceRef, Vote } from '@spinajs/authz';

import type { AssignmentStore, LinkStore, RuleStore, SubjectResolver } from '../contracts.js';
import { expiryTime } from './assignments.js';
import type { CompiledGrant, GrantIndex } from './grants.js';
import type { RbacModelOptions } from './model.js';
import { patternsFilter } from './patterns.js';
import type { PatternContext } from './patterns.js';
import type { CompileRolesOptions, RoleGraph } from './roles.js';

/*
 * The RBAC evaluation of design §6.1.2. An async gathering phase does all the IO and yields an
 * RbacInput; nine named steps then run synchronously over one RbacState, in RBAC_STEP_NAMES order,
 * and the state becomes the Vote. Hook contract:
 * - RBAC_STEPS maps every step name to `(state) => void`, plus `noGrantReason` (the step 5 reason
 *   when no grant of the permission is reachable, `no_access` by default). A lane fills a step by
 *   changing its entry. Steps never do IO and write only their own part of the state.
 * - Everything outside the steps goes through an RbacExtension (model init, role edges, compile at
 *   boot, gathering, boot refs, native ops). DEFAULT_RBAC_EXTENSIONS lists their factories; a model
 *   creates its own instances, so an extension may keep per-model state.
 * - A grant that fails a check sets `candidate.failed` and pushes a reason (steps 5–7): a failed
 *   grant permits nothing. `state.reasons` alone feeds Vote.reason ("why it does not permit"), and
 *   only while nothing permits; it never denies, so another model's permit still wins under
 *   permit-overrides. A deny entry (step 8) goes to `state.denies`, which feeds Vote.denies and
 *   denyWhen only: the engine reads each entry's reason where its `when` holds.
 */

export const RBAC_STEP_NAMES = Object.freeze(['collect', 'restrict', 'cap', 'aggregate', 'grant', 'tag', 'provenance', 'threshold', 'residual'] as const);

export type RbacStepName = (typeof RBAC_STEP_NAMES)[number];

export type RbacStep = (state: RbacState) => void;

export type RbacSteps = Readonly<Record<RbacStepName, RbacStep>> & {
  /** The step 5 reason when `grant` leaves no candidate; the runner calls it right after `grant`. */
  readonly noGrantReason: (state: RbacState) => DenyReason;
};

/** What the gathering phase loaded for one request. */
export interface RbacInput {
  readonly request: DecisionRequest;
  readonly now: Date;
  /** Scopes whose assignments apply to the resource, nearest first: the resource, its ancestors in order, GLOBAL last. */
  readonly path: readonly ResourceRef[];
  /** Assignments of the principal's subjects, config roles included; `collect` keeps the live ones. */
  readonly assignments: readonly Assignment[];
  readonly roles: RoleGraph;
  readonly grants: GrantIndex;
  /** Called by `collect` for an assignment whose role the graph does not hold (B12: ignored). */
  readonly onUnknownRole?: (assignment: Assignment) => void;
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
  /** Rank on the role's ladder; `cap` may lower it. */
  rank?: number;
}

/** A grant of the requested permission and the live assignments whose roles reach it. */
export interface RbacCandidate {
  readonly grant: CompiledGrant;
  readonly holders: readonly LiveAssignment[];
  failed: boolean;
}

export interface RbacDeny {
  readonly when: ResourceFilter;
  readonly reason: DenyReason;
}

export interface RbacState {
  readonly input: RbacInput;
  readonly permission: Permission;
  /** collect, restrict, cap */
  live: LiveAssignment[];
  /** aggregate: the effective role per ladder (Vote.roles). */
  readonly roles: Record<string, string>;
  /** aggregate: the union of live tags. */
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
}

const noop: RbacStep = () => undefined;

const collect: RbacStep = (s) => {
  const { assignments, path, roles, now, onUnknownRole } = s.input;
  const scopes = new Set(path.map(resourceKey));
  for (const a of assignments) {
    if (!scopes.has(resourceKey(a.scope))) continue;
    const expires = expiryTime(a);
    // Dropping the row would read as a clean, cacheable "no"; the engine makes a throw model_error (fail closed).
    if (Number.isNaN(expires)) throw new Error(`rbac: assignment '${a.id}' (source: ${a.source}, role '${a.role}') has an unreadable expiresAt`);
    if (expires !== undefined && expires <= now.getTime()) continue;
    if (!roles.has(a.role)) {
      onUnknownRole?.(a);
      continue;
    }
    s.live.push({ assignment: a, role: a.role, scope: a.scope, tags: a.tags ?? [], ...(expires !== undefined ? { expiresAt: new Date(expires) } : {}), bypass: new Set() });
  }
};

const grant: RbacStep = (s) => {
  const holders = new Map<CompiledGrant, LiveAssignment[]>();
  for (const live of s.live) {
    for (const g of s.input.grants.grants(live.role, s.permission)) {
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
 */
const residual: RbacStep = (s) => {
  const ends: number[] = s.validUntil ? [s.validUntil.getTime()] : [];
  const at: PatternContext = { resource: s.input.request.resource, path: s.input.path, principal: s.input.request.principal };
  for (const c of s.candidates) {
    if (!c.failed) s.permit.push(grantResidual(c.grant, at));
    for (const h of c.holders) if (h.expiresAt) ends.push(h.expiresAt.getTime());
  }
  if (ends.length > 0) s.validUntil = new Date(Math.min(...ends));
};

export const RBAC_STEPS: RbacSteps = Object.freeze({
  collect,
  restrict: noop,
  cap: noop,
  aggregate: noop,
  grant,
  tag: noop,
  provenance: noop,
  threshold: noop,
  residual,
  noGrantReason: (): DenyReason => ({ code: 'no_access', priority: DEFAULT_DENY_PRIORITY.no_access }),
});

/** Runs the steps over the gathered input, synchronously. */
export function runRbacPipeline(input: RbacInput, steps: RbacSteps = RBAC_STEPS): Vote {
  const state: RbacState = { input, permission: input.request.permission, live: [], roles: {}, tags: new Set(), candidates: [], reasons: [], denies: [], permit: [], cacheable: true };
  for (const name of RBAC_STEP_NAMES) {
    steps[name](state);
    if (name === 'grant' && state.candidates.length === 0) state.reasons.push(steps.noGrantReason(state));
  }
  return toVote(state);
}

function toVote(s: RbacState): Vote {
  const permitWhen = s.permit.length > 0 ? or(...s.permit) : FALSE;
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
  readonly rules?: RuleStore;
  readonly links?: LinkStore;
  readonly extensions?: readonly RbacExtension[];
  /** Assignments the config gives these subjects at GLOBAL (anonymousRoles, serviceRoles). */
  readonly configAssignments?: (subjects: readonly AssignmentSubject[]) => readonly Assignment[];
  readonly onUnknownRole?: (assignment: Assignment) => void;
}

/** The IO phase: subjects, their assignments, the path, then what the extensions gather. */
export async function gatherRbacInput(request: DecisionRequest, ctx: EvaluationContext, sources: RbacSources): Promise<RbacInput> {
  const subjects = sources.subjects ? await sources.subjects.subjects(request.principal) : defaultSubjects(request.principal);
  const stored = await sources.assignments.forSubjects(subjects, ctx.now);
  let input: RbacInput = {
    request,
    now: ctx.now,
    path: await resourcePath(request.resource, ctx),
    assignments: [...stored, ...(sources.configAssignments?.(subjects) ?? [])],
    roles: sources.roles,
    grants: sources.grants,
    ...(sources.onUnknownRole ? { onUnknownRole: sources.onUnknownRole } : {}),
  };
  for (const ext of sources.extensions ?? []) {
    if (ext.gather) input = { ...input, ...(await ext.gather(request, ctx, input, sources)) };
  }
  return input;
}

/**
 * The scopes whose assignments apply to `resource` (B13), nearest first: the resource, its
 * ancestors in order, GLOBAL last, each once. A type-level request gets GLOBAL only: a scoped
 * assignment must never permit every row, it needs a row filter (`native:rbac.assignment`).
 */
export async function resourcePath(resource: ResourceRef, ctx: EvaluationContext): Promise<readonly ResourceRef[]> {
  if (resource.id == null) return [GLOBAL];
  const ancestors = await ctx.ancestors(resource);
  // The engine denies unknown_resource before the models run; a "no" here would look like a clean answer.
  if (ancestors === null) throw new Error(`rbac: unknown resource ${resourceKey(resource)}: ancestors answered null`);
  const global = resourceKey(GLOBAL);
  const path = new Map<string, ResourceRef>();
  for (const ref of [resource, ...ancestors]) if (resourceKey(ref) !== global && !path.has(resourceKey(ref))) path.set(resourceKey(ref), ref);
  return [...path.values(), GLOBAL];
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
  /** At the end of the gathering phase; the result is merged into the input. */
  gather?(request: DecisionRequest, ctx: EvaluationContext, input: RbacInput, sources: RbacSources): Partial<RbacInput> | Promise<Partial<RbacInput>>;
  /** Boot refs, merged into the contributor's. */
  contribute?(graph: RoleGraph, grants: GrantIndex): AuthzContribution;
  /** Residual ops this extension's steps emit; each `native:*` one needs its filter in `nativeFilters`. */
  readonly residuals?: readonly FilterOp[];
  nativeFilters?(): readonly NativeFilter[];
  /** OR-ed into the model's capabilities. */
  readonly capabilities?: Partial<Pick<ModelCapabilities, 'needsSubject'>>;
}

export type RbacExtensionFactory = (opts: RbacModelOptions) => RbacExtension;

/** One factory per extension, so every model gets its own instances; a lane adds its factory here. */
export const DEFAULT_RBAC_EXTENSIONS: readonly RbacExtensionFactory[] = Object.freeze([]);

/** The model's extensions when its options name none: one instance per factory, built with the model options. */
export function createRbacExtensions(opts: RbacModelOptions, factories: readonly RbacExtensionFactory[] = DEFAULT_RBAC_EXTENSIONS): readonly RbacExtension[] {
  return Object.freeze(factories.map((create) => create(opts)));
}
