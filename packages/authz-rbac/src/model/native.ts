import { GLOBAL, NativeFilter, resourceKey } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, DecisionRequest, EvaluationContext, ResourceRef, ResourceType } from '@spinajs/authz';

import { RBAC_ASSIGNMENT_OP } from '../contracts.js';
import type { AssignmentStore } from '../contracts.js';
import { expiryTime, subjectKey } from './assignments.js';
import type { RbacExtension } from './evaluate.js';
import type { RbacModelOptions } from './model.js';

/*
 * The args of `native:rbac.assignment` (design §6.1.3 "Lists", §12.4): the contract between the RBAC
 * model and the compilers of lanes L2/L4b.
 *
 * Meaning: the row is permitted by this term when one of `subjects` holds a live assignment
 * (`expiresAt` absent or after now) of one of `roles` whose scope is on the row's path: the row
 * itself, one of its ancestors, GLOBAL, or the type-only scope `{ type }` of the row's own type (a
 * role over every row of that type; it reaches no other type). Live means at the time the filter runs (`ctx.now`, SQL `:now`), read from the
 * assignment store, so the term holds no copy of the assignments.
 *
 * The model has already applied what it knows when it builds the term: `roles` are the roles that
 * grant the permission through one grant, among those the subjects hold, minus the ones the
 * principal's ceiling.roles leaves out. Conditions of that grant (relation, pattern) are core ops
 * ANDed around the term, never inside it.
 *
 * Canonical: `subjects` sorted by subjectKey and `roles` by code point, both without duplicates, so
 * equal terms are equal JSON (the L2 cache key, SQL statement caches). A compiler must refuse args
 * it does not fully understand (another `v`, an unknown key): L1b adds rule parts (restrict, cap,
 * tags, provenance) as new keys or a new version, and ignoring them would widen the list.
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

/** In-memory evaluator of `native:rbac.assignment` (B06): reads the subjects' assignments from the store. */
export class RbacAssignmentFilter extends NativeFilter {
  readonly op = RBAC_ASSIGNMENT_OP;

  constructor(private readonly assignments: AssignmentStore) {
    super();
  }

  async matches(args: unknown, _subject: unknown, ref: ResourceRef, ctx: EvaluationContext): Promise<boolean> {
    const { subjects, roles } = parseRbacAssignmentArgs(args);
    if (roles.length === 0 || subjects.length === 0) return false;
    const ancestors = await ctx.ancestors(ref);
    if (ancestors === null) throw new Error(`${RBAC_ASSIGNMENT_OP}: unknown resource ${resourceKey(ref)}`);
    const onPath = scopeMatcher(ref.type, [ref, ...ancestors]);
    const wanted = new Set(roles);
    const now = ctx.now.getTime();
    for (const a of await this.held(subjects, ctx)) {
      if (!wanted.has(a.role) || !onPath(a.scope)) continue;
      const expires = expiryTime(a);
      if (Number.isNaN(expires)) throw new Error(`${RBAC_ASSIGNMENT_OP}: assignment '${a.id}' (source: ${a.source}) has an unreadable expiresAt`);
      if (expires === undefined || expires > now) return true;
    }
    return false;
  }

  // One store read per subject list and time within a request (ctx.cache is per request).
  private held(subjects: readonly RbacArgsSubject[], ctx: EvaluationContext): Promise<readonly Assignment[]> {
    const key = `${RBAC_ASSIGNMENT_OP}:${ctx.now.getTime()}:${JSON.stringify(subjects)}`;
    let load = ctx.cache.get(key) as Promise<readonly Assignment[]> | undefined;
    if (!load) {
      load = this.assignments.forSubjects(subjects as readonly AssignmentSubject[], ctx.now);
      ctx.cache.set(key, load);
    }
    return load;
  }
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
 * adapters compile the op (authz-orm's RbacOrmCompiler). `types` limits the native term to those
 * resource types; the others keep `under`. The op is still declared model-wide, so boot rule 4 refuses
 * it on any list-scoped type routed to this model whose adapter does not compile it.
 */
export const rbacAssignmentExtension = (opts: RbacModelOptions, config: { readonly types?: readonly ResourceType[] } = {}): RbacExtension => {
  const filter = new RbacAssignmentFilter(opts.assignments);
  const types = config.types ? new Set(config.types) : undefined;
  return Object.freeze({
    residuals: Object.freeze([RBAC_ASSIGNMENT_OP]),
    nativeFilters: () => [filter],
    gather: (request: DecisionRequest) => (types && !types.has(request.resource.type) ? {} : { scopedResidual: 'native' as const }),
  });
};

function copySubject(s: AssignmentSubject): RbacArgsSubject {
  if ('set' in s) {
    const scope = s.set.scope;
    return { set: { role: s.set.role, scope: scope.id == null ? { type: scope.type } : { type: scope.type, id: scope.id } } };
  }
  return { type: s.type, id: s.id };
}

function readSubject(v: unknown): AssignmentSubject | undefined {
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
