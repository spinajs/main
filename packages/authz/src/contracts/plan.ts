import type { Principal, ResourceRef, ResourceType } from './principal.js';
import type { PermissionDef } from './permission.js';
import type { DenyReason } from './decision.js';
import type { RelationResolver } from './adapter.js';

/** One condition on a row; an adapter that filters lists compiles it by `op` (authz-orm: a PlanTermCompiler). */
export interface PlanTerm {
  readonly op: string;
  readonly args: unknown;
}

/** What one model says about a list of `type` for a permission. */
export type ModelListPlan =
  | { readonly kind: 'abstain' }
  | { readonly kind: 'all'; readonly deny?: readonly PlanTerm[]; readonly validUntil?: Date }
  | { readonly kind: 'deny-all'; readonly reason: DenyReason }
  | { readonly kind: 'terms'; readonly permit: readonly PlanTerm[]; readonly deny: readonly PlanTerm[]; readonly validUntil?: Date };

/**
 * How an access plan may be kept beyond the request that asked for it: rows it filtered stay right for the principal it
 * was planned for until a change bumps one of `tags`, and for at most `ttlMs`.
 */
export interface AccessPlanCache {
  /** The domain, the principal's whole state, the permission and the type: two plans with one key are one plan. */
  readonly key: string;
  /** Decision tags (`*`, `model:`, `subject:`, `link:`, `scope:`) of a type-level decision of the principal. */
  readonly tags: readonly string[];
  /** The domain's decision TTL, capped by `validUntil`; above 0. */
  readonly ttlMs: number;
}

/**
 * The combined plan the engine returns. `permit: 'all'` means no permit filter. `cache` is set only when a model planned
 * it, every model that did says its plans rest on announced state (`listPlanCacheable`), the call had no env, the
 * permission is not `fresh`, no model failed and every nested check it rested on could be cached.
 */
export type AccessPlan =
  | { readonly kind: 'none'; readonly reason: DenyReason; readonly cache?: AccessPlanCache }
  | {
      readonly kind: 'filter';
      readonly permit: 'all' | readonly PlanTerm[];
      readonly deny: readonly PlanTerm[];
      /** Ceiling resources: the row must be one of them or descend from one. */
      readonly within?: readonly ResourceRef[];
      readonly validUntil?: Date;
      readonly cache?: AccessPlanCache;
    };

/** Why a model cannot plan a permission on a type, or true. */
export type ListSupport = true | { readonly reason: string };

/** What listSupport may consult besides the permission and type. */
export interface ListSupportContext {
  relation(type: ResourceType, name: string): RelationResolver | undefined;
}

export interface ListPlanRequest {
  readonly principal: Principal;
  /** The acting principal under `inherit` delegation, as `DecisionRequest.actor`. */
  readonly actor?: Principal;
  readonly permission: PermissionDef;
  readonly type: ResourceType;
  /** Request env, built like check() builds it (`now` always present). */
  readonly env?: Readonly<Record<string, unknown>>;
  /** Set for a consistency `fresh` permission, as `DecisionRequest.fresh`. */
  readonly fresh?: boolean;
}
