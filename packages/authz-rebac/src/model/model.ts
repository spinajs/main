import { AuthorizationModel, NativeFilter } from '@spinajs/authz';
import type { DecisionRequest, EvaluationContext, ListPlanRequest, ListSupport, ModelCapabilities, ModelInitContext, ModelListPlan, PermissionDef, PrincipalRef, ResourceRef, ResourceType, Vote } from '@spinajs/authz';

import type { NamespaceConfig, PermissionMap, RebacLimits } from '../contracts.js';
import { TupleStore } from '../contracts.js';
import { NamespaceSchema } from '../namespace/compile.js';

export const REBAC_CHECK_OP = 'native:rebac.check' as const;

/** A check's answer; `unknown` when a limit stopped the search for a proof. */
export type Membership = 'member' | 'not' | 'unknown';

export interface RebacModelOptions {
  /** Default 'rebac'; the model reads `authz.<name>.*`. */
  readonly name?: string;
  /** Default: the domain container's TupleStore, else the store `authz.<name>.store` names. */
  readonly store?: TupleStore;
  /** Default `authz.<name>.namespaces`. */
  readonly namespaces?: NamespaceConfig;
  /** Default `authz.<name>.permissions`. */
  readonly permissions?: PermissionMap;
  /** Default `authz.<name>.limit`, then maxDepth 8 and maxCalls 10000. */
  readonly limit?: RebacLimits;
}

/**
 * ReBAC (design ARCH-7): tuples in a TupleStore, namespaces with relations and rewritten permissions.
 * A concrete resource gets a definite vote, or an indeterminate one when a limit stops the check; a
 * type-level request gets the residual `{ op: 'native:rebac.check', args: { relation, principal } }`.
 */
export class RebacModel extends AuthorizationModel {
  readonly name: string;
  readonly nativeFilter: NativeFilter;

  constructor(opts: RebacModelOptions = {}) {
    super();
    this.name = opts.name ?? 'rebac';
    this.nativeFilter = new RebacCheckFilter(this);
  }

  get capabilities(): ModelCapabilities {
    throw new Error('not implemented: RebacModel.capabilities');
  }

  async init(_ctx: ModelInitContext): Promise<void> {
    throw new Error('not implemented: RebacModel.init');
  }

  applies(_permission: PermissionDef, _type: ResourceType): boolean {
    throw new Error('not implemented: RebacModel.applies');
  }

  async evaluate(_req: DecisionRequest, _ctx: EvaluationContext): Promise<Vote> {
    throw new Error('not implemented: RebacModel.evaluate');
  }

  listSupport(_permission: PermissionDef, _type: ResourceType): ListSupport {
    throw new Error('not implemented: RebacModel.listSupport');
  }

  async listPlan(_req: ListPlanRequest, _ctx: EvaluationContext): Promise<ModelListPlan> {
    throw new Error('not implemented: RebacModel.listPlan');
  }

  invalidate(_tags: readonly string[]): void {
    throw new Error('not implemented: RebacModel.invalidate');
  }

  version(): string {
    throw new Error('not implemented: RebacModel.version');
  }

  async dispose(): Promise<void> {
    throw new Error('not implemented: RebacModel.dispose');
  }

  /** The compiled namespaces. @throws AuthzConfigError before init when the constructor got none */
  schema(): NamespaceSchema {
    throw new Error('not implemented: RebacModel.schema');
  }

  /** The store the model reads. @throws AuthzConfigError before init when the constructor got none */
  store(): TupleStore {
    throw new Error('not implemented: RebacModel.store');
  }

  /** Does `principal` hold `name` (a relation or permission) on `object`? @throws Error past maxCalls */
  async check(_object: ResourceRef, _name: string, _principal: PrincipalRef, _ctx?: EvaluationContext): Promise<Membership> {
    throw new Error('not implemented: RebacModel.check');
  }
}

/** Answers the type-level residual per row with the model's check; `unknown` answers false. */
class RebacCheckFilter extends NativeFilter {
  readonly op = REBAC_CHECK_OP;
  // The check reads the principal from args only, and ctx.cache only for tuple reads.
  readonly principalInArgs = true;

  constructor(private readonly model: RebacModel) {
    super();
  }

  async matches(args: unknown, _subject: unknown, ref: ResourceRef, ctx: EvaluationContext): Promise<boolean> {
    const { relation, principal } = args as { relation: string; principal: PrincipalRef };
    return (await this.model.check(ref, relation, principal, ctx)) === 'member';
  }
}
