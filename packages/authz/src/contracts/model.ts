import type { Principal, PrincipalType, ResourceRef, ResourceType } from './principal.js';
import type { Permission, PermissionDef, PermissionRegistry } from './permission.js';
import type { FilterOp, ResourceFilter } from './filter.js';
import type { DecisionRequest, Decision, FieldSet, TraceStep, Vote } from './decision.js';
import type { RelationResolver } from './adapter.js';
import type { ListPlanRequest, ListSupport, ModelListPlan } from './plan.js';
import type { ConditionCompiler } from '../conditions/contracts.js';

export abstract class NativeFilter {
  abstract readonly op: `native:${string}`;
  abstract matches(args: unknown, subject: unknown, ref: ResourceRef, ctx: EvaluationContext): boolean | Promise<boolean>;
}

// Merged into the class so it emits no field: a subclass may declare it with a field initialiser or a getter.
export interface NativeFilter {
  /** True when `args` name every principal the op reads, so the op never reads `Decision.principal`: an intersect delegate's residual keeps it instead of stripping it (RFC E2-2). Such a filter must also key every `ctx.cache` memo by what its args name, because a kept leaf runs with the agent's evaluation context and cache. A compiler of the op (SQL) must not read the request principal either. */
  readonly principalInArgs?: boolean;
}

export interface ModelCapabilities {
  readonly effects: readonly ('permit' | 'deny')[];
  readonly residuals: readonly FilterOp[]; // ops its votes may contain
  readonly sync: 'always' | 'after-preload' | 'never';
  readonly fields: boolean;
  readonly needsSubject: boolean; // some answers need the row and cannot be residualised
  readonly principalTypes?: readonly PrincipalType[];
  readonly resourceTypes?: readonly ResourceType[] | '*';
}

export interface ModelInitContext {
  readonly domain: string;
  readonly config: <T>(path: string, dflt?: T) => T; // reads authz.<model.name>.*
  readonly permissions: PermissionRegistry;
  registerPermissions(defs: readonly Omit<PermissionDef, 'source'>[]): void;
  registerNativeFilter(f: NativeFilter): void;
  registerRelation(r: RelationResolver): void;
}

export interface EvaluationContext {
  readonly domain: string;
  readonly now: Date;
  readonly permissions: PermissionRegistry;
  ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null>; // memoised per request
  attributes(ref: ResourceRef): Promise<Readonly<Record<string, unknown>> | null>; // scope attributes, memoised per request
  readonly conditions: ConditionCompiler;
  relation(type: ResourceType, name: string): RelationResolver | undefined;
  check(req: Omit<DecisionRequest, 'explain'>): Promise<Decision>; // for models that delegate (fs-inherit)
  readonly cache: Map<string, unknown>; // per-request scratch, per model namespace
  trace(step: Omit<TraceStep, 'by'>): void;
}

export abstract class AuthorizationModel {
  abstract readonly name: string; // unique per domain: 'rbac' | 'abac' | 'fs-inherit' | 'fs-abac'
  abstract readonly capabilities: ModelCapabilities;
  abstract init(ctx: ModelInitContext): Promise<void> | void;
  /** Static routing: may this model have an opinion on (permission, type)? Called at boot and on version change. */
  abstract applies(permission: PermissionDef, type: ResourceType): boolean;
  abstract evaluate(req: DecisionRequest, ctx: EvaluationContext): Vote | Promise<Vote>;
  preload?(principal: Principal, ctx: EvaluationContext): Promise<void>;
  summarize?(principal: Principal, at: ResourceRef, ctx: EvaluationContext): Promise<ModelSummary>;
  /** List support for `permission` on `type`; absent means the model cannot plan lists. */
  listSupport?(permission: PermissionDef, type: ResourceType): ListSupport;
  /** The list plan; called only when listSupport answered true. */
  listPlan?(req: ListPlanRequest, ctx: EvaluationContext): Promise<ModelListPlan>;
  invalidate?(tags: readonly string[]): void;
  version?(): string; // changes => host recompiles routes, drops L2
  dispose?(): Promise<void>;
}

export interface ModelSummary {
  readonly model: string;
  readonly roles?: ReadonlyArray<{ role: string; scope: ResourceRef; expiresAt?: string }>;
  readonly permissions: ReadonlyArray<{ name: Permission; conditional: boolean; fields?: FieldSet }>;
}

export abstract class Combinator {
  abstract readonly name: string;
  abstract combine(votes: readonly Vote[]): { allow: ResourceFilter; deciding?: Vote };
}

export interface RoutePlan {
  readonly algorithm: string;
  readonly models: readonly AuthorizationModel[];
}
