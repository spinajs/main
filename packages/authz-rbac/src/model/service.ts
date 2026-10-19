import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { EvaluationContext, Principal, ResourceRef } from '@spinajs/authz';
import { unique } from '@spinajs/util';

import type { LinkStore, SubjectKey } from '../contracts.js';
import { subjectKeyOf } from '../stores/columns.js';

import { liveAssignments, rbacTables } from './evaluate.js';
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
 * RBAC introspection for consumers: the role switch (rolesOf with `ceiling: false`),
 * effective-role helpers, share-link principals. Built over one RbacModel; not a DI
 * singleton (wiring is the host's).
 */
export class RbacService {
  constructor(readonly model: RbacModel, private readonly opts: RbacServiceOptions = {}) {}

  /**
   * The roles `principal` holds at `at` (default GLOBAL): the live assignments on the path of `at`,
   * steps 1–3 applied and unknown roles dropped. By default after the principal's `ceiling.roles`,
   * as decisions and Vote.roles see them; `ceiling: false` gives the assigned roles, which a role
   * switch (RoleSource) must offer. At a type-level `at` only GLOBAL and bare-type assignments
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
   * The subject keys (subjectKeyOf) `principal` acts as at `at` (default: the model clock's now), for
   * stores that match rows by subject key (fs_acl): itself, its companions, their type wildcards, a
   * group principal's member set, and the subject sets its live assignments make it a member of,
   * directly and, with a MembershipStore, through other sets. Each key once.
   * @throws (rejects) when a store fails
   */
  async subjectKeysOf(principal: Principal, at?: Date): Promise<readonly SubjectKey[]> {
    const input = await this.model.subjectsInput(principal, this.context(at));
    return Object.freeze(unique((input.subjects ?? []).map(subjectKeyOf)));
  }

  /**
   * The principal of share link `id`: type `link`, its ceiling the link's scope
   * and expiry (reason `link_invalid`), its attributes the link's, `companion` joined as a subject
   * when nothing it carries would be lost (see linkCompanion). An unknown or revoked id gives
   * `ceiling.resources: []`, so every check denies `link_invalid`.
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

  /** The context of rolesOf without one: `now` (default the model clock), a fresh request cache, the `ancestors` option. */
  private context(now: Date = this.model.currentTime()): EvaluationContext {
    const ancestors = this.opts.ancestors;
    const own: Partial<EvaluationContext> = {
      now,
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

/** The tables `model` evaluates with (rbacTables over its extensions). */
export function modelTables(model: RbacModel): RbacTables {
  return rbacTables(model.extensions, model.roleGraph(), model.grantIndex());
}
