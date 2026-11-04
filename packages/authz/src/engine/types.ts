import { compareStrings } from '@spinajs/util';
import type { ResourceFilter } from '../contracts/filter.js';
import type { Decision, DenyReason, TraceStep, Vote } from '../contracts/decision.js';
import type { AccessPlan } from '../contracts/plan.js';
import type { AuthorizationModel, Combinator, NativeFilter } from '../contracts/model.js';
import type { PermissionDef, PermissionRegistry } from '../contracts/permission.js';
import { SYSTEM, UNATTENDED } from '../contracts/principal.js';
import type { Principal, PrincipalRef, ResourceRef, ResourceType } from '../contracts/principal.js';
import { GLOBAL } from '../contracts/resource.js';
import type { RelationResolver, ResourceAdapter, ScopeAttributeSchema, ScopeAttributeStore, ScopeResolver } from '../contracts/adapter.js';
import type { DecisionAudit, DecisionCache } from '../contracts/service.js';
import type { ConditionCompiler } from '../conditions/contracts.js';
import type { AuthzLog } from '../host/log.js';
import { BUILTIN_COMBINATORS } from './combinators.js';
import type { CombineConfig, RouteTable } from './routes.js';
import type { FieldCombiner } from './fields.js';

/**
 * summary() and covers() check at most this many permissions (one check per
 * permission and principal; each check keeps its own budgets and time limits).
 * Past it, a summary lists the first ones by name and covers is false.
 */
export const MAX_SUMMARY_PERMISSIONS = 1000;
/** Permissions checked at once by summary() and covers(). */
export const SUMMARY_BATCH = 8;
/** A whole summary() or covers() call gets this many modelTimeoutMs. */
export const DEADLINE_FACTOR = 4;
/** Principals remembered as preloaded per Authorizer (filterNow gates sync 'after-preload' models on it, B22), least recently used dropped first. */
export const MAX_PRELOADED = 10_000;

/**
 * Generations come from one counter for every Authorizer of this module, so a
 * request scope born under one instance never matches a rebuilt one.
 */
let generations = 0;
export const nextGeneration = (): number => ++generations;

export interface AuthorizerOptions {
  readonly domain: string;
  readonly models: readonly AuthorizationModel[];
  /** Populated and frozen by the host. */
  readonly registry: PermissionRegistry;
  readonly combine?: CombineConfig;
  /** Added to the built-ins; a built-in's name is refused. */
  readonly combinators?: readonly Combinator[];
  readonly adapters?: readonly ResourceAdapter[];
  readonly scopeResolvers?: readonly ScopeResolver[];
  readonly relations?: readonly RelationResolver[];
  readonly nativeFilters?: readonly NativeFilter[];
  readonly scopeAttributes?: { readonly schemas?: readonly ScopeAttributeSchema[]; readonly store?: ScopeAttributeStore };
  /** Absent: compile() rejects, so a model that needs conditions is indeterminate. */
  readonly conditions?: ConditionCompiler;
  /** L2; absent = no L2. Each Authorizer needs its own cache, never shared with another Authorizer of the same domain; a rebuilt Authorizer gets a fresh one. */
  readonly cache?: DecisionCache;
  readonly audit?: DecisionAudit;
  readonly clock?: () => Date;
  readonly log?: Pick<AuthzLog, 'error' | 'warn' | 'debug'>;
  readonly config?: {
    readonly modelTimeoutMs?: number;
    readonly maxDelegation?: number;
    readonly neverRead?: readonly string[];
    /** Trace every check and log it at debug. */
    readonly explain?: boolean;
    readonly cacheTtlSeconds?: number;
    readonly auditDenials?: boolean;
  };
}

/** L1: the request's AuthzCache map. */
export interface RequestScope {
  readonly cache?: Map<string, unknown>;
}

export interface EngineConfig {
  readonly modelTimeoutMs: number;
  readonly maxDelegation: number;
  readonly neverRead: readonly string[];
  readonly explain: boolean;
  readonly cacheTtlSeconds: number;
  readonly auditDenials: boolean;
}

export interface Run {
  readonly sync: boolean;
  readonly scope: Map<string, unknown>;
  /** The engine's own instant for the top-level call; contexts get copies. */
  readonly instant: Date;
  readonly depth: number;
  /** onBehalfOf hops left: maxDelegation at the top, less the hops an intersect delegate's check already used. */
  readonly delegationBudget: number;
  /** The version vector of the top-level call; undefined: nothing is cached. */
  readonly versions: string | undefined;
  /**
   * The invalidation generation when this Authorizer first touched the request
   * scope (`bornOf`): the scope's data (ctx.cache, ancestors, attributes) may
   * date from then, so L1 hits and L2 stores need it still current.
   */
  readonly generation: number;
  /** Shared by the whole call tree (intersect delegates, ctx.check). */
  readonly nested: Nested;
  /** explain(): the whole call tree runs live, without the caches. */
  readonly bypass: boolean;
  /** summary() and covers(): not an access attempt, so nothing is audited. */
  readonly quiet?: boolean;
  /** covers() on the holder: no cache reads, since a cached decision has no `firmFields`; stores as usual. */
  readonly firm?: boolean;
  /** A fresh check: no cache reads anywhere in the call tree; stores as usual. */
  readonly fresh?: boolean;
}

/** What nested decisions add to every decision above them: a vote may rest on a nested check. */
export interface Nested {
  /** No level may keep the decisions above. */
  uncacheable: boolean;
  /** Some nested tags are unknown (an L2 hit): the decisions above stay out of the L2. */
  untagged: boolean;
  /** Some decision or data load of the call tree failed: every decision of the tree may rest on it. */
  faulted: boolean;
  readonly tags: Set<string>;
}

/** Who the models run with. */
export interface Parties {
  readonly principal: Principal;
  /** Ref of `principal`, read once. */
  readonly ref: PrincipalRef;
  /** `principalCacheId` of `principal`. */
  readonly cacheId: string;
  readonly actor?: Principal;
  readonly actorRef?: PrincipalRef;
}

export type Attributes = Readonly<Record<string, unknown>> | null;

/** `degraded`: null because a layer timed out, not because a source answered null. */
export interface LoadedAttributes {
  readonly attributes: Attributes;
  readonly degraded: boolean;
}

/** One scope node's load in a request (L1), shared by the models and the binder. */
export interface NodeLoad {
  readonly ref: ResourceRef;
  readonly result: Promise<LoadedAttributes>;
  /** The layer's own limit and the binder's run out at about the same time; one of them logs. */
  timeoutLogged: boolean;
  /** Set once the load settled degraded or rejected: no decision of the request is cached then. */
  degraded: boolean;
}

/** What a binder load gives: `failed` (a rejection) is an engine fault in the deny reason, `degraded` (a rejection or a timeout) stops caching and marks the decision faulted. */
export interface BoundAttributes {
  readonly attributes: Attributes;
  readonly failed: boolean;
  readonly degraded: boolean;
}

/** What the pipeline returns: the decision and what step 10 must know about it. */
export interface Checked {
  readonly decision: Decision;
  /**
   * Never cache: SYSTEM; a vote that is not cacheable; a binder or fields
   * fault; a ref outside the cache-safe paths (`cacheSafeRef`) in the allow,
   * the field terms or the reason pass; any scope load of the request that
   * timed out or rejected (a load still pending when the decision is built
   * cannot be seen); the same in an intersect delegate's or a nested
   * ctx.check's decision.
   */
  readonly uncacheable: boolean;
  /**
   * Rests on an engine fault whatever the reason says (an indeterminate vote,
   * a combine/bind/fields/subject failure, a failed or timed-out load, a
   * faulted nested decision), or the request saw one a model may have
   * memoised (a degraded scope load, a rejected host call). Never cached, so
   * cache hits are not faulted.
   */
  readonly faulted: boolean;
  /**
   * Firm runs only: the fields the allow gives on every row it covers
   * (`FieldCombiner.combine` with `firm`), within `decision.fields`. covers
   * judges the holder by them: a conditional permit adds to the decision's
   * fields though it may not hold on the target's rows.
   */
  readonly firmFields?: Fields;
}

/** An L1 decision entry; `generation` makes an invalidate drop it too. */
export class CachedDecision {
  constructor(
    readonly decision: Decision,
    /** undefined: unknown (from the L2, or not buildable), so no decision above it goes to the L2. */
    readonly tags: readonly string[] | undefined,
    readonly expiresAt: number,
    readonly generation: number,
    /** A denial no audit has recorded yet (decided nested or by summary/covers): the first audited hit records it. */
    public unaudited: boolean,
  ) {}
}

/** An L1 access plan; `generation` makes an invalidate drop it too. */
export class CachedPlan {
  constructor(readonly plan: AccessPlan, readonly generation: number) {}
}

/** checkAll's second pass: the row, no row (unknown resource), or a failed load. */
export type RowLoad = { readonly kind: 'row'; readonly row: unknown } | { readonly kind: 'missing' } | { readonly kind: 'failed' };

export type Gate = { readonly kind: 'system' } | { readonly kind: 'deny'; readonly principal: PrincipalRef; readonly reason: DenyReason } | { readonly kind: 'run'; readonly principal: Principal; readonly ref: PrincipalRef };

export interface Combined {
  readonly allow: ResourceFilter;
  readonly deciding?: Vote;
  readonly failed: boolean;
}

export interface Fields {
  readonly read: readonly string[];
  readonly write: readonly string[];
}

export interface Outcome {
  readonly principal: PrincipalRef;
  readonly actor?: PrincipalRef;
  readonly residual: ResourceFilter;
  readonly reason?: DenyReason;
  readonly roles: Readonly<Record<string, string>>;
  readonly fields: Fields;
  readonly validUntil?: Date;
  readonly models: readonly string[];
  readonly votes: readonly Vote[];
}

export interface Finish {
  readonly def: PermissionDef;
  readonly ref: ResourceRef;
  readonly algorithm: string;
  /** Audit identity: the principal of the request, before delegation. */
  readonly requester: PrincipalRef;
  readonly system?: boolean;
  readonly run: Run;
  readonly explain: boolean;
  readonly steps: TraceStep[] | undefined;
  readonly started: number;
}

export const GLOBAL_TYPE: ResourceType = '$global';
export const CORE = 'core';
export const ENGINE_FAULT: DenyReason = Object.freeze({ code: 'model_error' });
export const DELEGATE_PRIORITY = 200;
export const NO_LOG: Pick<AuthzLog, 'error' | 'warn' | 'debug'> = Object.freeze({ error() {}, warn() {}, debug() {} });
export const NO_FIELDS: Fields = Object.freeze({ read: Object.freeze([]), write: Object.freeze([]) });
export const NO_ROLES: Readonly<Record<string, string>> = Object.freeze({});
export const GLOBAL_ANCESTORS: readonly ResourceRef[] = Object.freeze([GLOBAL]);
// covers relies on an allow needing some model's permit, which only the built-ins promise.
export const BUILTIN_ALGORITHMS: ReadonlySet<string> = new Set(BUILTIN_COMBINATORS.map((c) => c.name));
export const SYSTEM_REF: PrincipalRef = Object.freeze({ type: SYSTEM.type, id: SYSTEM.id });
export const UNATTENDED_REF: PrincipalRef = Object.freeze({ type: UNATTENDED.type, id: UNATTENDED.id });
export const UNKNOWN_RESOURCE: DenyReason = Object.freeze({ code: 'unknown_resource' });
export const INVALID_REQUEST: DenyReason = Object.freeze({ code: 'invalid_request' });
export const MISSING_ROW: RowLoad = Object.freeze({ kind: 'missing' });
export const FAILED_ROW: RowLoad = Object.freeze({ kind: 'failed' });

export const byName = (a: Vote, b: Vote): number => compareStrings(a.model, b.model);

/** The state of one Authorizer, shared by the engine functions; built once by the constructor. */
export interface Engine {
  readonly domain: string;
  readonly where: string;
  readonly registry: PermissionRegistry;
  readonly modelList: readonly AuthorizationModel[];
  readonly combinators: ReadonlyMap<string, Combinator>;
  readonly combineConfig: CombineConfig;
  table: RouteTable;
  readonly cache: DecisionCache | undefined;
  /** The last version vector seen as a string. */
  versions: string | undefined;
  versionsWarned: boolean;
  /** Moved by invalidate() and by a version change: a request scope born before it does not store into the L2. */
  generation: number;
  /** cache.invalidate threw, so dropped entries may still be there: the L2 is unused until an invalidate(['*']) succeeds (retried at each call). */
  l2Stale: boolean;
  readonly adapterList: readonly ResourceAdapter[];
  readonly adapterByType: ReadonlyMap<ResourceType, ResourceAdapter>;
  readonly resolverByType: ReadonlyMap<ResourceType, ScopeResolver>;
  readonly relationIndex: ReadonlyMap<string, RelationResolver>;
  readonly natives: ReadonlyMap<string, NativeFilter>;
  /** Native ops whose filter declares `principalInArgs`: an intersect delegate's residual keeps them. */
  readonly argBoundNatives: ReadonlySet<string>;
  readonly attributeDefaults: ReadonlyMap<ResourceType, Readonly<Record<string, unknown>>>;
  readonly attributeStore: ScopeAttributeStore | undefined;
  readonly conditions: ConditionCompiler;
  readonly clock: () => Date;
  readonly log: Pick<AuthzLog, 'error' | 'warn' | 'debug'>;
  readonly auditSink: DecisionAudit | undefined;
  readonly config: EngineConfig;
  readonly allFields: Fields;
  readonly fieldCombiner: FieldCombiner;
}
