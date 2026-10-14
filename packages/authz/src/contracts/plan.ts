import type { Principal, ResourceRef, ResourceType } from './principal.js';
import type { PermissionDef } from './permission.js';
import type { DenyReason } from './decision.js';

/** One condition on a row, rendered by the PlanTermSql compiler registered for `op`. */
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
}

/** Row context a compiler renders against. `rowId` is SQL yielding the row id as text. */
export interface SqlRowContext {
  readonly type: ResourceType;
  readonly rowId: string;
  readonly rowColumn: (column: string) => string;
  readonly ancestorTable: string;
  /** Columns of the row's `owner`/`self` relation, when the resource declares one. */
  readonly relation: (name: 'owner' | 'self') => { readonly column: string; readonly typeColumn?: string } | undefined;
  readonly now: Date;
  readonly dialect: 'sqlite' | 'postgres' | 'mysql' | 'mssql';
}

export interface SqlFragment {
  readonly sql: string;
  readonly bindings: readonly unknown[];
}

/** Renders one PlanTerm op to a boolean SQL expression over the current row. */
export abstract class PlanTermSql {
  abstract readonly op: string;
  abstract toSql(args: unknown, row: SqlRowContext): SqlFragment;
}
