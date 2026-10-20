import type { Principal, ResourceRef, ResourceType } from './principal.js';
import type { PermissionDef } from './permission.js';
import type { DenyReason } from './decision.js';

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

/** The combined plan the engine returns. `permit: 'all'` means no permit filter. */
export type AccessPlan =
  | { readonly kind: 'none'; readonly reason: DenyReason }
  | {
      readonly kind: 'filter';
      readonly permit: 'all' | readonly PlanTerm[];
      readonly deny: readonly PlanTerm[];
      /** Ceiling resources: the row must be one of them or descend from one. */
      readonly within?: readonly ResourceRef[];
      readonly validUntil?: Date;
    };

/** Why a model cannot plan a permission on a type, or true. */
export type ListSupport = true | { readonly reason: string };

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
