import { GLOBAL, NativeFilter, resourceKey } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, DecisionRequest, EvaluationContext, ResourceRef, ResourceType } from '@spinajs/authz';

import { RBAC_ASSIGNMENT_OP, RBAC_THRESHOLD_OP } from '../contracts.js';
import type { AssignmentStore } from '../contracts.js';
import { expiryTime, subjectKey } from './assignments.js';
import type { RbacExtension, RbacSources } from './evaluate.js';
import { RbacListEvaluator, RbacThresholdFilter } from './rules/native.js';
import type { RbacModelOptions } from './model.js';
import { assignmentProblem } from './roles.js';
import type { RoleGraph } from './roles.js';

/*
 * The args of `native:rbac.assignment` (design §6.1.3 "Lists", §12.4): the contract between the RBAC
 * model and the SQL compilers.
 *
 * Meaning: the row is permitted by this term when one of `subjects` holds a live assignment
 * (`expiresAt` absent or after now) of one of `roles`, which the role's definition accepts at
 * that scope (`assignable`, `scopeTypes`: assignmentProblem), and whose scope is on the row's
 * path: the row itself, one of its ancestors, GLOBAL, or the type-only scope `{ type }` of the row's own type (a
 * role over every row of that type; it reaches no other type). Live means at the time the filter runs (`ctx.now`, SQL `:now`), read from the
 * assignment store, so the term holds no copy of the assignments.
 *
 * The model has already applied what it knows when it builds the term: `roles` are the roles that
 * grant the permission through one grant, among those the subjects hold, minus the ones the
 * principal's ceiling.roles leaves out. Conditions of that grant (relation, pattern) are core ops
 * ANDed around the term, never inside it.
 *
 * Canonical: `subjects` sorted by subjectKey and `roles` by code point, both without duplicates, so
 * equal terms are equal JSON (the cross-request decision cache key, SQL statement caches). A
 * compiler must refuse args it does not fully understand (another `v`, an unknown key): implied
 * roles and rule parts (restrict, cap, tags, provenance) will come as new keys or a new version,
 * and ignoring them would widen the list.
 */
export interface RbacAssignmentArgs {
  readonly v: 1;
  /** The principal's subjects: itself, its companions and its subject sets, as the assignment table stores them. */
  readonly subjects: readonly RbacArgsSubject[];
  readonly roles: readonly string[];
}

/** A principal `{ type, id }`, or the holders of `role` at `scope` (`authz_assignment.subject_role`). */
export type RbacArgsSubject = { readonly type: string; readonly id: string } | { readonly set: { readonly role: string; readonly scope: { readonly type: ResourceType; readonly id?: string } } };

export const MAX_ARGS_SUBJECTS = 1000;
export const MAX_ARGS_ROLES = 1000;

const ARG_KEYS = new Set(['v', 'subjects', 'roles']);

/** The canonical args, or a throw past the size bounds (the engine makes it model_error, fail closed). */
export function rbacAssignmentArgs(subjects: readonly AssignmentSubject[], roles: Iterable<string>): RbacAssignmentArgs {
  const bySubject = new Map<string, RbacArgsSubject>();
  for (const s of subjects) bySubject.set(subjectKey(s), copySubject(s));
  const roleList = [...new Set(roles)].sort(compareCodePoints);
  if (bySubject.size > MAX_ARGS_SUBJECTS) throw new Error(`rbac: ${bySubject.size} subjects exceed the ${MAX_ARGS_SUBJECTS} a ${RBAC_ASSIGNMENT_OP} term may hold`);
  if (roleList.length > MAX_ARGS_ROLES) throw new Error(`rbac: ${roleList.length} roles exceed the ${MAX_ARGS_ROLES} a ${RBAC_ASSIGNMENT_OP} term may hold`);
  const sorted = [...bySubject].sort(([a], [b]) => compareCodePoints(a, b)).map(([, s]) => s);
  return Object.freeze({ v: 1, subjects: Object.freeze(sorted), roles: Object.freeze(roleList) });
}

/**
 * Reads args back, for the filter and the compilers. Refuses anything that is not exactly the v1
 * shape, canonical order included.
 * @throws Error naming the problem
 */
export function parseRbacAssignmentArgs(args: unknown): RbacAssignmentArgs {
  const fail = (problem: string): never => {
    throw new Error(`${RBAC_ASSIGNMENT_OP}: ${problem}`);
  };
  if (!isPlainObject(args)) return fail('args must be an object { v, subjects, roles }');
  const unknown = Object.keys(args).filter((k) => !ARG_KEYS.has(k));
  if (unknown.length > 0) fail(`unknown args key(s) ${unknown.join(', ')}`);
  if (args.v !== 1) fail(`unsupported args version ${JSON.stringify(args.v)}`);
  const { subjects, roles } = args;
  if (!Array.isArray(subjects) || subjects.length > MAX_ARGS_SUBJECTS) fail('subjects must be an array of at most 1000 subjects');
  if (!Array.isArray(roles) || roles.length > MAX_ARGS_ROLES || !roles.every((r) => typeof r === 'string' && r !== '')) fail('roles must be an array of at most 1000 role names');
  const parsed = rbacAssignmentArgs(
    (subjects as unknown[]).map((s) => readSubject(s) ?? fail(`malformed subject ${JSON.stringify(s)}`)),
    roles as string[],
  );
  if (JSON.stringify(parsed) !== JSON.stringify({ v: 1, subjects, roles })) fail('subjects and roles must be sorted and without duplicates');
  return parsed;
}

/**
 * In-memory evaluator of `native:rbac.assignment` (B06): reads the subjects' assignments from the
 * store and checks them against the role graph `roles` gives (the model's current one).
 */
export class RbacAssignmentFilter extends NativeFilter {
  readonly op = RBAC_ASSIGNMENT_OP;
  // v1 and v2 (RbacListEvaluator) read who asks from `subjects`, `principal`, `companions` and `actor` only.
  readonly principalInArgs = true;

  constructor(private readonly assignments: AssignmentStore, private readonly roles: () => RoleGraph | undefined) {
    super();
  }

  /** Set by rbacAssignmentExtension with `rules: true`: evaluates args v2. */
  v2?: (args: unknown, subject: unknown, ref: ResourceRef, ctx: EvaluationContext) => Promise<boolean>;

  async matches(args: unknown, subject: unknown, ref: ResourceRef, ctx: EvaluationContext): Promise<boolean> {
    // Without rbacAssignmentExtension's rules option, v2 is an unsupported version like any other.
    if (this.v2 && (args as { v?: unknown } | null)?.v === 2) return this.v2(args, subject, ref, ctx);
    const { subjects, roles } = parseRbacAssignmentArgs(args);
    if (roles.length === 0 || subjects.length === 0) return false;
    const graph = this.roles();
    if (!graph) throw new Error(`${RBAC_ASSIGNMENT_OP}: the role definitions are not compiled yet`);
    const ancestors = await ctx.ancestors(ref);
    if (ancestors === null) throw new Error(`${RBAC_ASSIGNMENT_OP}: unknown resource ${resourceKey(ref)}`);
    const onPath = scopeMatcher(ref.type, [ref, ...ancestors]);
    const wanted = new Set(roles);
    const now = ctx.now.getTime();
    for (const a of await this.held(subjects, ctx)) {
      if (!wanted.has(a.role) || !onPath(a.scope) || assignmentProblem(graph, a.role, a.scope)) continue;
      const expires = expiryTime(a);
      if (Number.isNaN(expires)) throw new Error(`${RBAC_ASSIGNMENT_OP}: assignment '${a.id}' (source: ${a.source}) has an unreadable expiresAt`);
      if (expires === undefined || expires > now) return true;
    }
    return false;
  }

  private held(subjects: readonly RbacArgsSubject[], ctx: EvaluationContext): Promise<readonly Assignment[]> {
    return heldAssignments(this.assignments, subjects, ctx);
  }
}

/** The subjects' assignments for a list filter: one store read per subject list and time within a request (ctx.cache is per request). */
export function heldAssignments(store: AssignmentStore, subjects: readonly RbacArgsSubject[], ctx: EvaluationContext): Promise<readonly Assignment[]> {
  const key = `${RBAC_ASSIGNMENT_OP}:${ctx.now.getTime()}:${JSON.stringify(subjects)}`;
  let load = ctx.cache.get(key) as Promise<readonly Assignment[]> | undefined;
  if (!load) {
    load = store.forSubjects(subjects as readonly AssignmentSubject[], ctx.now);
    ctx.cache.set(key, load);
  }
  return load;
}

/**
 * Whether an assignment scope applies to a resource of `type` with this path: GLOBAL, a node of the
 * path by key, or the type-only scope of `type` itself. A type-only scope of another type reaches
 * nothing: the engine and the kit read a type-only `under` scope differently, so no row filter may
 * depend on one.
 */
export function scopeMatcher(type: ResourceType, path: readonly ResourceRef[]): (scope: ResourceRef) => boolean {
  const keys = new Set([...path, GLOBAL, { type }].map(resourceKey));
  return (scope) => keys.has(resourceKey(scope));
}

/**
 * Makes type-level votes list scoped assignments with `native:rbac.assignment` instead of the default
 * `under` over the assignment scopes, and registers its in-memory filter. Use it for types whose
 * adapters compile the op. `types` limits the native term to those
 * resource types; the others keep `under`. The op is still declared model-wide, so boot rule 4 refuses
 * it on any list-scoped type routed to this model whose adapter does not compile it.
 *
 * `rules: true` also lists rows under RBAC rules (args v2 and `native:rbac.threshold`, see
 * rules/args.ts) and declares `native:rbac.threshold`, so the adapters of those types must compile
 * both ops. Without it a type-level vote whose rows depend on rules fails closed.
 */
export const rbacAssignmentExtension = (opts: RbacModelOptions, config: { readonly types?: readonly ResourceType[]; readonly rules?: boolean } = {}): RbacExtension => {
  let graph: RoleGraph | undefined;
  const filter = new RbacAssignmentFilter(opts.assignments, () => graph);
  const types = config.types ? new Set(config.types) : undefined;
  const covers = (type: ResourceType) => !types || types.has(type);
  const lists = config.rules ? new RbacListEvaluator(opts.assignments) : undefined;
  if (lists) filter.v2 = (args, subject, ref, ctx) => lists.assignment(args, subject, ref, ctx);
  const threshold = lists ? new RbacThresholdFilter(lists) : undefined;
  return Object.freeze({
    compile: (compiled: RoleGraph) => {
      graph = compiled;
    },
    residuals: Object.freeze(lists ? [RBAC_ASSIGNMENT_OP, RBAC_THRESHOLD_OP] : [RBAC_ASSIGNMENT_OP]),
    nativeFilters: () => (threshold ? [filter, threshold] : [filter]),
    ...(lists ? { listsRules: covers } : {}),
    gather: (request: DecisionRequest, _ctx: EvaluationContext, _input: unknown, sources: RbacSources) => {
      lists?.attach(sources);
      return covers(request.resource.type) ? { scopedResidual: 'native' as const } : {};
    },
  });
};

/** A subject in its canonical args form. */
export function copySubject(s: AssignmentSubject): RbacArgsSubject {
  if ('set' in s) {
    const scope = s.set.scope;
    return { set: { role: s.set.role, scope: scope.id == null ? { type: scope.type } : { type: scope.type, id: scope.id } } };
  }
  return { type: s.type, id: s.id };
}

/** A subject read back from args; undefined for any other shape. */
export function readSubject(v: unknown): AssignmentSubject | undefined {
  if (!isPlainObject(v)) return undefined;
  if ('set' in v) {
    const set = v.set;
    if (Object.keys(v).length !== 1 || !isPlainObject(set) || Object.keys(set).length !== 2 || typeof set.role !== 'string' || !isPlainObject(set.scope)) return undefined;
    const { type, id } = set.scope;
    const keys = Object.keys(set.scope);
    if (typeof type !== 'string') return undefined;
    if (id === undefined) return keys.length === 1 ? { set: { role: set.role, scope: { type } } } : undefined;
    return typeof id === 'string' && keys.length === 2 ? { set: { role: set.role, scope: { type, id } } } : undefined;
  }
  const keys = Object.keys(v);
  if (keys.length !== 2 || typeof v.type !== 'string' || typeof v.id !== 'string') return undefined;
  return { type: v.type, id: v.id };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const compareCodePoints = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
