import { AuthzConfigError, GLOBAL, resourceKey, subtractFieldGlobs } from '@spinajs/authz';
import type { EvaluationContext, Principal, ResourceRef } from '@spinajs/authz';

import { liveAssignments, resourcePath } from './evaluate.js';
import type { CompiledGrant } from './grants.js';
import type { RbacModel } from './model.js';

export interface RbacServiceOptions {
  /** Ancestors of a resource for rolesOf without a context; production wires the host's scope resolution. */
  readonly ancestors?: (ref: ResourceRef) => Promise<readonly ResourceRef[] | null>;
}

/** One role a principal holds at a resource, through one assignment (config roles included). */
export interface RoleHolding {
  readonly role: string;
  readonly scope: ResourceRef;
  readonly assignment: string;
  readonly source: string;
  readonly expiresAt?: Date;
}

/**
 * RBAC introspection for consumers (design §6.1.5): the AdminGuard (covers, rolesOf), the role
 * switch (rolesOf with `ceiling: false`), effective-role helpers. Built over one RbacModel; not a DI
 * singleton (wiring is the host's).
 */
export class RbacService {
  constructor(readonly model: RbacModel, private readonly opts: RbacServiceOptions = {}) {}

  /**
   * Whether `holder` holds every grant the `wanted` roles give, with conditions no wider. For each
   * grant w of each wanted role (its `extends` closure, globs and `implies` expanded), some grant h
   * of the same permission that the holder holds must cover w. h covers w when each condition of h
   * is absent or at most as wide as w's:
   * - relations: w's relations are a subset of h's (h's OR admits every row w's does);
   * - patterns (`on`): w's patterns, as written, are a subset of h's;
   * - fields: w's read and write globs lie inside h's (a grant without fields gives every field);
   * - requiresTag: equal; grantedAt: w's types are a subset of h's.
   * Conditions compare as role definitions, not as resolved rows: `home/{principal.id}` and `owner`
   * cover themselves, although the assignee gets its own home and its own rows, not the actor's. That
   * is "an actor may hand out its own role". So an unconditional grant covers a conditional one and
   * not the reverse, and equal role sets cover each other (not strict). One holder grant must cover
   * each wanted grant; two narrower ones whose union would cover it do not (conservative). An
   * unknown wanted role is refused; unknown holder roles give nothing.
   *
   * `holder` is either:
   * - a list of role names, held everywhere: `at` is not read and no ceiling applies, so a caller
   *   that passes `rolesOf(...)` names must apply the actor's `ceiling.permissions`, `resources`
   *   and `expiresAt` itself (coversAt does);
   * - a principal the models run with (never an agent with `onBehalfOf`), whose assignments are
   *   preloaded. Without IO, covers reads the request snapshot in `ctx` (else the cache across
   *   requests, which a TTL of 0 leaves empty), and only the assignments at GLOBAL and at `at` itself
   *   (and its bare type), after `ceiling.roles`. A wanted grant whose permission lies outside
   *   `ceiling.permissions`, or any wanted grant past `ceiling.expiresAt`, is not covered.
   *   Assignments at ancestors of `at` are not read: coversAt is the AdminGuard's primary path.
   * @throws AuthzConfigError for an agent principal, a `ceiling.resources` that does not hold `at`
   *   (or GLOBAL) by key, assignments not preloaded, or stale roles
   */
  covers(holder: Principal | readonly string[], wanted: readonly string[], at?: ResourceRef, ctx?: EvaluationContext): boolean {
    if (isRoleList(holder)) return this.coversRoles(holder, wanted);
    const where = at ?? GLOBAL;
    const limit = this.ceilingLimit(holder, ctx);
    if (limit.resources && !limit.resources.has(resourceKey(where)) && !limit.resources.has(resourceKey(GLOBAL))) {
      throw new AuthzConfigError(`RbacService.covers: ${holder.type}:${holder.id} has ceiling.resources without ${resourceKey(where)}; ancestors need IO, use coversAt`);
    }
    return this.coversRoles(
      this.model.heldNow(holder, where, ctx).map((l) => l.role),
      wanted,
      limit,
    );
  }

  /**
   * The AdminGuard's primary path: covers for a principal at `at` with the assignments on the whole
   * path of `at` (rolesOf with `ctx`, ancestors included) and the principal's ceiling: `roles`
   * through rolesOf, `permissions` and `expiresAt` per wanted grant, and `resources` (none of them
   * on the path of `at` refuses everything wanted).
   * @throws (rejects) AuthzConfigError for an agent principal (pass the principal the models run
   *   with), or when the stores fail
   */
  async coversAt(principal: Principal, wanted: readonly string[], at: ResourceRef, ctx: EvaluationContext): Promise<boolean> {
    const limit = this.ceilingLimit(principal, ctx);
    if (limit.resources) {
      const path = await resourcePath(at, ctx);
      if (!path.some((ref) => limit.resources!.has(resourceKey(ref)))) return wanted.length === 0;
    }
    const names = (await this.rolesOf(principal, at, { ctx })).map((r) => r.role);
    return this.coversRoles(names, wanted, limit);
  }

  private coversRoles(held: readonly string[], wanted: readonly string[], limit?: CeilingLimit): boolean {
    const graph = this.model.roleGraph();
    const index = this.model.grantIndex();
    if (wanted.some((r) => !graph.has(r))) return false;
    const holding = [...new Set(held)].filter((r) => graph.has(r));
    for (const role of new Set(wanted)) {
      for (const permission of index.permissions(role)) {
        if (limit && !limit.allows(permission)) return false;
        for (const w of index.grants(role, permission)) {
          if (!holding.some((h) => index.grants(h, permission).some((g) => grantCovers(g, w)))) return false;
        }
      }
    }
    return true;
  }

  /**
   * The ceiling parts covers applies besides `roles`. An agent principal is refused: the models run
   * with its delegate, whose narrowed state this service cannot rebuild.
   */
  private ceilingLimit(principal: Principal, ctx?: EvaluationContext): CeilingLimit {
    if (principal.onBehalfOf != null) throw new AuthzConfigError(`RbacService.covers: ${principal.type}:${principal.id} acts on behalf of another principal; pass the principal the models run with`);
    const ceiling: unknown = principal.ceiling;
    if (ceiling == null) return { allows: () => true };
    const bad = (part: string) => new AuthzConfigError(`RbacService.covers: the ceiling.${part} of ${principal.type}:${principal.id} is malformed`);
    const c = ceiling as { permissions?: unknown; resources?: unknown; expiresAt?: unknown };
    let permissions: Set<string> | undefined;
    if (c.permissions != null) {
      if (!Array.isArray(c.permissions) || !c.permissions.every((g) => typeof g === 'string')) throw bad('permissions');
      const registry = this.model.permissions();
      permissions = new Set(c.permissions.flatMap((glob: string) => registry.match(glob).map((d) => d.name)));
    }
    let resources: Set<string> | undefined;
    if (c.resources != null) {
      if (!Array.isArray(c.resources) || !c.resources.every((r) => typeof r === 'object' && r !== null && typeof (r as ResourceRef).type === 'string')) throw bad('resources');
      resources = new Set((c.resources as ResourceRef[]).map(resourceKey));
    }
    let expired = false;
    if (c.expiresAt != null) {
      const until = expiryOf(c.expiresAt);
      if (Number.isNaN(until)) throw bad('expiresAt');
      expired = until <= (ctx?.now ?? this.model.currentTime()).getTime();
    }
    return { ...(resources ? { resources } : {}), allows: (permission) => !expired && (permissions === undefined || permissions.has(permission)) };
  }

  /**
   * The roles `principal` holds at `at` (default GLOBAL): the live assignments on the path of `at`,
   * steps 1–3 applied and unknown roles dropped. By default after the principal's `ceiling.roles`,
   * as decisions and Vote.roles see them; `ceiling: false` gives the assigned roles, which a role
   * switch (A26, RoleSource) must offer. At a type-level `at` only GLOBAL and bare-type assignments
   * hold. A concrete `at` reads its ancestors from `ctx`, else from the `ancestors` option.
   * @throws (rejects) AuthzConfigError for a concrete `at` with neither; rejects when a store fails
   */
  async rolesOf(principal: Principal, at: ResourceRef = GLOBAL, opts: { readonly ceiling?: boolean; readonly ctx?: EvaluationContext } = {}): Promise<readonly RoleHolding[]> {
    const ctx = opts.ctx ?? this.context();
    const input = await this.model.inputAt(principal, at, ctx);
    const { live } = liveAssignments(input, { ceiling: opts.ceiling !== false });
    return Object.freeze(live.map((l) => Object.freeze({ role: l.role, scope: l.scope, assignment: l.assignment.id, source: l.assignment.source, ...(l.expiresAt ? { expiresAt: l.expiresAt } : {}) })));
  }

  /** The compiled grants of the role's `extends` closure, permissions expanded, by permission; none for an unknown role. */
  grantsOf(role: string): readonly CompiledGrant[] {
    const index = this.model.grantIndex();
    return Object.freeze(index.permissions(role).flatMap((p) => index.grants(role, p)));
  }

  /** The context of rolesOf without one: the model clock, a fresh request cache, the `ancestors` option. */
  private context(): EvaluationContext {
    const ancestors = this.opts.ancestors;
    const own: Partial<EvaluationContext> = {
      now: this.model.currentTime(),
      cache: new Map(),
      permissions: this.model.permissions(),
      ancestors: (ref) => (ancestors ? ancestors(ref) : Promise.reject(new AuthzConfigError('RbacService.rolesOf at a resource needs a ctx or the ancestors option'))),
    };
    return new Proxy(own as EvaluationContext, {
      get(target, key) {
        if (key in target) return target[key as keyof EvaluationContext];
        if (key === 'then') return undefined;
        throw new AuthzConfigError(`RbacService.rolesOf: its context has no '${String(key)}'; pass ctx`);
      },
    });
  }
}

const isRoleList = (v: Principal | readonly string[]): v is readonly string[] => Array.isArray(v);

interface CeilingLimit {
  /** Keys of `ceiling.resources`; each covers itself and its descendants. */
  readonly resources?: ReadonlySet<string>;
  allows(permission: string): boolean;
}

function expiryOf(value: unknown): number {
  try {
    return Date.prototype.getTime.call(value);
  } catch {
    return NaN;
  }
}

function grantCovers(h: CompiledGrant, w: CompiledGrant): boolean {
  if (h.relations && !(w.relations && w.relations.every((r) => h.relations!.includes(r)))) return false;
  if (h.patterns) {
    const key = (p: { readonly pattern: { readonly type: string; readonly id?: string } }) => JSON.stringify([p.pattern.type, p.pattern.id ?? null]);
    const mine = new Set(h.patterns.map(key));
    if (!(w.patterns && w.patterns.every((p) => mine.has(key(p))))) return false;
  }
  if (h.fieldGlobs) {
    if (!w.fieldGlobs) return false;
    if (subtractFieldGlobs(w.fieldGlobs.read, h.fieldGlobs.read).length > 0 || subtractFieldGlobs(w.fieldGlobs.write, h.fieldGlobs.write).length > 0) return false;
  }
  if (h.requiresTag !== undefined && h.requiresTag !== w.requiresTag) return false;
  if (h.grantedAt && !(w.grantedAt && w.grantedAt.every((t) => h.grantedAt!.includes(t)))) return false;
  return true;
}
