import { AuthzConfigError, GLOBAL, resourceKey, subtractFieldGlobs } from '@spinajs/authz';
import type { EvaluationContext, Principal, ResourceRef } from '@spinajs/authz';

import type { LinkStore } from '../contracts.js';

import { liveAssignments, rbacTables, resourcePath } from './evaluate.js';
import type { RbacTables } from './evaluate.js';
import type { CompiledGrant } from './grants.js';
import { effectiveRole } from './ladder/steps.js';
import { UNRESOLVED_LINK_ID, linkPrincipalOf } from './links/principal.js';
import type { RbacModel } from './model.js';

export interface RbacServiceOptions {
  /** Ancestors of a resource for rolesOf without a context; production wires the host's scope resolution. */
  readonly ancestors?: (ref: ResourceRef) => Promise<readonly ResourceRef[] | null>;
  /** The share links linkPrincipal reads; default: the model's `links` option. */
  readonly links?: LinkStore;
}

/** One role a principal holds at a resource, through one assignment (config roles included). */
export interface RoleHolding {
  readonly role: string;
  readonly scope: ResourceRef;
  readonly assignment: string;
  readonly source: string;
  readonly expiresAt?: Date;
  /** The role whose grants the assignment gives after cap rules: `role`, or a lower role of its ladder. */
  readonly effectiveRole: string;
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
   * - requiresTag: equal; grantedAt: w's types are a subset of h's;
   * - ladder `resourceTypes`: of the types the permission is checked on (its `types` and `$global`),
   *   h applies on every one w applies on.
   * The wanted roles count with the roles they imply (at any `at`). Role names held everywhere
   * count with what they imply at 'self-and-descendants' (held wherever the wanted role is handed
   * out); a principal's names already hold the implied roles live at `at`, after its ceiling.
   * Subject sets are not judged: a subjectSet role without grants of its own is covered by anyone,
   * although its holders receive what is assigned to the set.
   * Conditions compare as role definitions, not as resolved rows: `home/{principal.id}` and `owner`
   * cover themselves, although the assignee gets its own home and its own rows, not the actor's. That
   * is "an actor may hand out its own role". So an unconditional grant covers a conditional one and
   * not the reverse, and equal role sets cover each other (not strict). One holder grant must cover
   * each wanted grant; two narrower ones whose union would cover it do not (conservative). An
   * unknown wanted role is refused; unknown holder roles give nothing.
   *
   * `holder` is either:
   * - a list of role definitions held everywhere: `at` is not read and no ceiling applies. Never
   *   pass `rolesOf(...)` output: those names are held at one scope after the ceiling, and this
   *   overload adds what they imply, which could bring back an implied role the ceiling dropped.
   *   Use coversAt for a principal;
   * - a principal the models run with (never an agent with `onBehalfOf`), whose assignments are
   *   preloaded. Without IO, covers reads the request snapshot in `ctx` (else the cache across
   *   requests, which a TTL of 0 leaves empty), and only the assignments at GLOBAL and at `at` itself
   *   (and its bare type), after `ceiling.roles`. A wanted grant whose permission lies outside
   *   `ceiling.permissions`, or any wanted grant past `ceiling.expiresAt`, is not covered.
   *   Assignments at ancestors of `at` are not read: coversAt is the AdminGuard's primary path.
   * Role definitions only: the holder's tags, thresholds and rule selectors are not judged, so a
   * caller that needs them asks checks (as CheckRbacAdminFacts does).
   * @throws AuthzConfigError for an agent principal, a `ceiling.resources` that does not hold `at`
   *   (or GLOBAL) by key, assignments not preloaded, stale roles, a rule store that is not in memory
   *   (at every `at`), or an `at` other than GLOBAL while an in-memory rule is live: use coversAt
   */
  covers(holder: Principal | readonly string[], wanted: readonly string[], at?: ResourceRef, ctx?: EvaluationContext): boolean {
    if (isRoleList(holder)) return this.coversRoles(this.withImpliedEverywhere(holder), wanted);
    const where = at ?? GLOBAL;
    const limit = this.ceilingLimit(holder, ctx);
    if (limit.resources && !limit.resources.has(resourceKey(where)) && !limit.resources.has(resourceKey(GLOBAL))) {
      throw new AuthzConfigError(`RbacService.covers: ${holder.type}:${holder.id} has ceiling.resources without ${resourceKey(where)}; ancestors need IO, use coversAt`);
    }
    return this.coversRoles(
      this.model.heldNow(holder, where, ctx).map((l) => effectiveRole(modelTables(this.model).ladders, l)),
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
    const names = (await this.rolesOf(principal, at, { ctx })).map((r) => r.effectiveRole);
    return this.coversRoles(names, wanted, limit);
  }

  private withImpliedEverywhere(held: readonly string[]): readonly string[] {
    const { implies } = modelTables(this.model);
    return implies
      ? [
          ...held,
          ...held.flatMap((r) =>
            implies
              .of(r)
              .filter((e) => e.at === 'self-and-descendants')
              .map((e) => e.role),
          ),
        ]
      : held;
  }

  private coversRoles(held: readonly string[], wanted: readonly string[], limit?: CeilingLimit): boolean {
    const graph = this.model.roleGraph();
    const index = this.model.grantIndex();
    if (wanted.some((r) => !graph.has(r))) return false;
    const holding = [...new Set(held)].filter((r) => graph.has(r));
    const { ladders, implies } = modelTables(this.model);
    const registry = this.model.permissions();
    // Assigning a role hands out what it implies too, so those grants must be covered as well.
    const handedOut = new Set(wanted.flatMap((r) => [r, ...(implies?.of(r).map((e) => e.role) ?? [])]));
    for (const role of handedOut) {
      for (const permission of index.permissions(role)) {
        if (limit && !limit.allows(permission)) return false;
        const types = ladders ? [...registry.require(permission).types, GLOBAL.type] : [];
        const typesCover = (h: CompiledGrant, w: CompiledGrant) => types.every((t) => !ladders!.appliesAt(w, t) || ladders!.appliesAt(h, t));
        for (const w of index.grants(role, permission)) {
          if (!holding.some((h) => index.grants(h, permission).some((g) => grantCovers(g, w) && typesCover(g, w)))) return false;
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
    return Object.freeze(live.map((l) => Object.freeze({ role: l.role, scope: l.scope, assignment: l.assignment.id, source: l.assignment.source, ...(l.expiresAt ? { expiresAt: l.expiresAt } : {}), effectiveRole: effectiveRole(input.ladders, l) })));
  }

  /**
   * The principal of share link `id` (design §6.1.6, B38): type `link`, its ceiling the link's scope
   * and expiry (reason `link_invalid`), its attributes the link's, `companion` joined as a subject
   * when nothing it carries would be lost (see linkCompanion). An unknown or revoked id gives
   * `ceiling.resources: []`, so every check denies `link_invalid` (B42).
   * @throws AuthzConfigError when no LinkStore is configured
   */
  async linkPrincipal(id: string, companion?: Principal): Promise<Principal> {
    return linkPrincipalOf(await this.linkStore('linkPrincipal').byId(id), id, companion);
  }

  /**
   * linkPrincipal for a bearer token, through `LinkStore.byToken`. A token no live or expired link
   * holds gives the principal `link:unresolved` (UNRESOLVED_LINK_ID), which denies every check.
   * @throws AuthzConfigError when no LinkStore is configured
   */
  async principalForToken(token: string, companion?: Principal): Promise<Principal> {
    return linkPrincipalOf(await this.linkStore('principalForToken').byToken(token), UNRESOLVED_LINK_ID, companion);
  }

  private linkStore(where: string): LinkStore {
    const store = this.opts.links ?? this.model.linkStore;
    if (!store) throw new AuthzConfigError(`RbacService.${where}: no LinkStore (the model's links option, or RbacServiceOptions.links)`);
    return store;
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

/** The tables `model` evaluates with (rbacTables over its extensions), so covers and the votes agree. */
export function modelTables(model: RbacModel): RbacTables {
  return rbacTables(model.extensions, model.roleGraph(), model.grantIndex());
}
