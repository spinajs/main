import type { ListSupport, ModelListPlan, Permission, PrincipalRef, ResourceType } from '@spinajs/authz';

import type { TupleStore } from '../contracts.js';
import type { NamespaceSchema } from '../namespace/compile.js';

/** The list-plan term of a ReBAC permission. */
export const REBAC_TUPLES_PLAN_OP = 'rebac.tuples';

/**
 * The row-level condition of a list plan: `tuples` holds when the row has a tuple `#relation@s` with
 * `subjectKey(s)` among `subjects`; `any` and `all` combine.
 */
export type RebacPlanExpr = { readonly tuples: { readonly relation: string; readonly subjects: readonly string[] } } | { readonly any: readonly RebacPlanExpr[] } | { readonly all: readonly RebacPlanExpr[] };

export interface RebacListPlanInput {
  readonly schema: NamespaceSchema;
  readonly store: TupleStore;
  readonly principal: PrincipalRef;
  readonly permission: Permission;
  readonly type: ResourceType;
  readonly maxDepth: number;
}

/** Whether lists of `permission` on `type` can be planned: every rewrite but exclusion. */
export function rebacListSupport(_schema: NamespaceSchema, _permission: Permission, _type: ResourceType): ListSupport {
  throw new Error('not implemented: rebacListSupport');
}

/** The list plan of design §6.2: one `rebac.tuples` term, or abstain when nothing can match. */
export async function rebacListPlan(_input: RebacListPlanInput): Promise<ModelListPlan> {
  throw new Error('not implemented: rebacListPlan');
}

/** @throws Error naming the problem, for anything but a RebacPlanExpr */
export function parseRebacPlanArgs(_args: unknown): RebacPlanExpr {
  throw new Error('not implemented: parseRebacPlanArgs');
}
