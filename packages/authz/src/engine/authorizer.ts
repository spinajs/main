import { AuthzConfigError, UnknownPermission } from '../contracts/errors.js';
import { FALSE, TRUE, and, bindRefs, not, or, simplify } from '../contracts/filter.js';
import type { ResourceFilter } from '../contracts/filter.js';
import type { CombiningAlgorithm, Decision, DecisionRequest, DenyReason, FieldSet, Trace, TraceStep, Vote } from '../contracts/decision.js';
import type { AuthorizationModel, Combinator, ModelSummary, NativeFilter } from '../contracts/model.js';
import type { Permission, PermissionDef, PermissionRegistry } from '../contracts/permission.js';
import { SYSTEM, UNATTENDED, principalKey } from '../contracts/principal.js';
import type { Ceiling, Principal, PrincipalRef, ResourceRef, ResourceType } from '../contracts/principal.js';
import { GLOBAL, resourceKey } from '../contracts/resource.js';
import type { RelationResolver, ResourceAdapter, ScopeAttributeSchema, ScopeAttributeStore, ScopeResolver } from '../contracts/adapter.js';
import type { AccessSummary, CheckInput, DecisionAudit, DecisionCache } from '../contracts/service.js';
import { subtractFieldGlobs, unionFieldGlobs } from '../contracts/fields.js';
import type { ConditionCompiler } from '../conditions/contracts.js';
import { BUILTIN_COMBINATORS, normalizeVote } from './combinators.js';
import { DEFAULT_COMBINE, compileRoutes } from './routes.js';
import type { CombineConfig, RouteTable } from './routes.js';
import { defaultAttribute, evaluateResidual } from './evaluate.js';
import type { SubjectEnv, Truth } from './evaluate.js';
import { selectDenyReason, staticTruths } from './reasons.js';
import { ceilingOutcome, mergeCeilings, readCeiling, scopeCovers } from './ceiling.js';
import type { CeilingOutcome } from './ceiling.js';
import { resolveDelegation, stripPrincipalOps } from './delegation.js';
import type { Delegation } from './delegation.js';
import type { VoteTruths } from './reasons.js';
import { cacheSafeRef, decisionKey, entryTags, invalidationTags, principalState, versionVector } from './cache-key.js';
import { mergeAttributes, schemaIndex } from './attributes.js';
import { FieldCombiner } from './fields.js';
import { bindEngineRefs, collectRefs, refValues, scopeNodes } from './refs.js';
import { ModelContext, NoConditionCompiler, l1Key, memo } from './context.js';
import type { ContextHost, MaybePromise } from './context.js';
import { NEEDS_ASYNC, isThenable, runAsync, runSync, settleWithin, swallow } from './run.js';
import type { Pipeline, Settled } from './run.js';
import { MAX_DATA_VALUES, MAX_FILTER_NODES, budget, copyData, copyRef, deepFreeze, describeError, faultVote, sanitizeFilter, sanitizeVote, validDate } from './vote.js';

/**
 * summary() and covers() check at most this many permissions (one check per
 * permission and principal; each check keeps its own budgets and time limits).
 * Past it, a summary lists the first ones by name and covers is false.
 */
export const MAX_SUMMARY_PERMISSIONS = 1000;
/** Permissions checked at once by summary() and covers(). */
const SUMMARY_BATCH = 8;
/** A whole summary() or covers() call gets this many modelTimeoutMs. */
const DEADLINE_FACTOR = 4;
/** Principals remembered as preloaded per Authorizer (filterNow gates sync 'after-preload' models on it, B22), least recently used dropped first. */
const MAX_PRELOADED = 10_000;

/**
 * Generations come from one counter for every Authorizer of this module, so a
 * request scope born under one instance never matches a rebuilt one.
 */
let generations = 0;
const nextGeneration = (): number => ++generations;

export interface EngineLog {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

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
  readonly log?: EngineLog;
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

interface EngineConfig {
  readonly modelTimeoutMs: number;
  readonly maxDelegation: number;
  readonly neverRead: readonly string[];
  readonly explain: boolean;
  readonly cacheTtlSeconds: number;
  readonly auditDenials: boolean;
}

interface Run {
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
}

/** What nested decisions add to every decision above them: a vote may rest on a nested check. */
interface Nested {
  /** No level may keep the decisions above. */
  uncacheable: boolean;
  /** Some nested tags are unknown (an L2 hit): the decisions above stay out of the L2. */
  untagged: boolean;
  /** Some decision or data load of the call tree failed: every decision of the tree may rest on it. */
  faulted: boolean;
  readonly tags: Set<string>;
}

/** Who the models run with. */
interface Parties {
  readonly principal: Principal;
  /** Ref of `principal`, read once. */
  readonly ref: PrincipalRef;
  /** `principalCacheId` of `principal`. */
  readonly cacheId: string;
  readonly actor?: Principal;
  readonly actorRef?: PrincipalRef;
}

type Attributes = Readonly<Record<string, unknown>> | null;

/** `degraded`: null because a layer timed out, not because a source answered null. */
interface LoadedAttributes {
  readonly attributes: Attributes;
  readonly degraded: boolean;
}

/** One scope node's load in a request (L1), shared by the models and the binder. */
interface NodeLoad {
  readonly ref: ResourceRef;
  readonly result: Promise<LoadedAttributes>;
  /** The layer's own limit and the binder's run out at about the same time; one of them logs. */
  timeoutLogged: boolean;
  /** Set once the load settled degraded or rejected: no decision of the request is cached then. */
  degraded: boolean;
}

/** What a binder load gives: `failed` (a rejection) is an engine fault in the deny reason, `degraded` (a rejection or a timeout) stops caching and marks the decision faulted. */
interface BoundAttributes {
  readonly attributes: Attributes;
  readonly failed: boolean;
  readonly degraded: boolean;
}

/** What the pipeline returns: the decision and what step 10 must know about it. */
interface Checked {
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
   * fields though it may not hold on the target's rows (E1 final review I1).
   */
  readonly firmFields?: Fields;
}

/** An L1 decision entry; `generation` makes an invalidate drop it too. */
class CachedDecision {
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

type Gate = { readonly kind: 'system' } | { readonly kind: 'deny'; readonly principal: PrincipalRef; readonly reason: DenyReason } | { readonly kind: 'run'; readonly principal: Principal; readonly ref: PrincipalRef };

interface Combined {
  readonly allow: ResourceFilter;
  readonly deciding?: Vote;
  readonly failed: boolean;
}

interface Fields {
  readonly read: readonly string[];
  readonly write: readonly string[];
}

interface Outcome {
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

interface Finish {
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

const GLOBAL_TYPE: ResourceType = '$global';
const CORE = 'core';
const ENGINE_FAULT: DenyReason = Object.freeze({ code: 'model_error' });
const DELEGATE_PRIORITY = 200;
const NO_LOG: EngineLog = Object.freeze({ error() {}, warn() {}, debug() {} });
const NO_FIELDS: Fields = Object.freeze({ read: Object.freeze([]), write: Object.freeze([]) });
const NO_ROLES: Readonly<Record<string, string>> = Object.freeze({});
const GLOBAL_ANCESTORS: readonly ResourceRef[] = Object.freeze([GLOBAL]);
// covers relies on an allow needing some model's permit, which only the built-ins promise (E1 final review I2).
const BUILTIN_ALGORITHMS: ReadonlySet<string> = new Set(BUILTIN_COMBINATORS.map((c) => c.name));
const SYSTEM_REF: PrincipalRef = Object.freeze({ type: SYSTEM.type, id: SYSTEM.id });
const UNATTENDED_REF: PrincipalRef = Object.freeze({ type: UNATTENDED.type, id: UNATTENDED.id });

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const quote = (v: unknown): string => {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : String(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
};
const byName = (a: Vote, b: Vote): number => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0);

export class Authorizer {
  readonly domain: string;
  private readonly where: string;
  private readonly registry: PermissionRegistry;
  private readonly modelList: readonly AuthorizationModel[];
  private readonly combinators = new Map<string, Combinator>();
  private readonly combineConfig: CombineConfig;
  private table: RouteTable;
  private readonly cache: DecisionCache | undefined;
  /** The last version vector seen as a string. */
  private versions: string | undefined;
  private versionsWarned = false;
  /** Moved by invalidate() and by a version change: a request scope born before it does not store into the L2. */
  private generation = nextGeneration();
  /** cache.invalidate threw, so dropped entries may still be there: the L2 is unused until an invalidate(['*']) succeeds (retried at each call). */
  private l2Stale = false;
  private readonly adapterList: readonly ResourceAdapter[];
  private readonly adapterByType = new Map<ResourceType, ResourceAdapter>();
  private readonly resolverByType = new Map<ResourceType, ScopeResolver>();
  private readonly relationIndex = new Map<string, RelationResolver>();
  private readonly natives = new Map<string, NativeFilter>();
  private readonly attributeDefaults: ReadonlyMap<ResourceType, Readonly<Record<string, unknown>>>;
  private readonly attributeStore: ScopeAttributeStore | undefined;
  private readonly conditions: ConditionCompiler;
  private readonly clock: () => Date;
  private readonly log: EngineLog;
  private readonly auditSink: DecisionAudit | undefined;
  private readonly config: EngineConfig;
  private readonly allFields: Fields;
  private readonly fieldCombiner: FieldCombiner;
  private readonly host: ContextHost;
  /** Principal cache id ⇒ the generation its preload finished in; a stale generation counts as not preloaded. */
  private readonly preloaded = new Map<string, number>();

  constructor(options: AuthorizerOptions) {
    if (!isObject(options)) throw new AuthzConfigError('Authorizer options must be an object');
    if (typeof options.domain !== 'string' || options.domain === '') throw new AuthzConfigError(`Authorizer domain must be a non-empty string, got ${quote(options.domain)}`);
    this.domain = options.domain;
    this.where = `Authz domain ${quote(this.domain)}`;
    if (!isObject(options.registry)) throw new AuthzConfigError(`${this.where}: a permission registry is required`);
    this.registry = options.registry;
    if (!Array.isArray(options.models)) throw new AuthzConfigError(`${this.where}: models must be an array`);
    this.modelList = Object.freeze([...options.models]);
    this.config = this.readConfig(options.config ?? {});
    this.log = options.log ?? NO_LOG;
    this.auditSink = options.audit;
    this.clock = options.clock ?? (() => new Date());
    this.conditions = options.conditions ?? new NoConditionCompiler();

    for (const c of BUILTIN_COMBINATORS) this.combinators.set(c.name, c);
    for (const c of options.combinators ?? []) {
      // Duck-typed: a combinator from a second copy of this package (ESM and CJS both loaded) fails instanceof.
      if (!isObject(c) || typeof c.combine !== 'function' || typeof c.name !== 'string' || c.name === '') throw new AuthzConfigError(`${this.where}: a custom combinator needs a non-empty name and a combine() method`);
      if (this.combinators.has(c.name)) throw new AuthzConfigError(`${this.where}: combinator ${quote(c.name)} is ${BUILTIN_COMBINATORS.some((b) => b.name === c.name) ? 'a built-in' : 'registered twice'}`);
      this.combinators.set(c.name, c);
    }

    this.combineConfig = options.combine ?? DEFAULT_COMBINE;
    this.table = this.compileTable();
    this.versions = versionVector(this.modelList);
    const cache: unknown = options.cache;
    // Duck-typed like combinators: a cache from a second copy of this package fails instanceof.
    if (cache !== undefined && (!isObject(cache) || typeof cache.get !== 'function' || typeof cache.set !== 'function' || typeof cache.invalidate !== 'function')) throw new AuthzConfigError(`${this.where}: cache must be a DecisionCache with get(), set() and invalidate()`);
    this.cache = cache as DecisionCache | undefined;

    this.adapterList = Object.freeze([...(options.adapters ?? [])]);
    for (const adapter of this.adapterList) {
      for (const type of adapter.types) {
        if (this.adapterByType.has(type)) throw new AuthzConfigError(`${this.where}: two resource adapters (${quote(this.adapterByType.get(type)!.kind)}, ${quote(adapter.kind)}) handle type ${quote(type)}`);
        this.adapterByType.set(type, adapter);
      }
    }
    for (const resolver of options.scopeResolvers ?? []) {
      for (const type of resolver.types) {
        if (this.resolverByType.has(type)) throw new AuthzConfigError(`${this.where}: two scope resolvers handle type ${quote(type)}`);
        this.resolverByType.set(type, resolver);
      }
    }
    for (const relation of [...(options.relations ?? []), ...this.adapterList.flatMap((a) => (typeof a.relations === 'function' ? a.relations() : []))]) {
      const key = `${relation.type}\u0000${relation.relation}`;
      if (this.relationIndex.has(key)) throw new AuthzConfigError(`${this.where}: two relation resolvers for ${quote(relation.relation)} on type ${quote(relation.type)}`);
      this.relationIndex.set(key, relation);
    }
    for (const filter of options.nativeFilters ?? []) {
      if (this.natives.has(filter.op)) throw new AuthzConfigError(`${this.where}: two native filters for op ${quote(filter.op)}`);
      this.natives.set(filter.op, filter);
    }
    const scopeAttributes: unknown = options.scopeAttributes === undefined ? {} : options.scopeAttributes;
    if (!isObject(scopeAttributes)) throw new AuthzConfigError(`${this.where}: scopeAttributes must be an object`);
    try {
      this.attributeDefaults = schemaIndex(scopeAttributes.schemas as readonly ScopeAttributeSchema[] | undefined);
    } catch (e) {
      throw e instanceof AuthzConfigError ? new AuthzConfigError(`${this.where}: ${e.message}`, { cause: e }) : e;
    }
    const store = scopeAttributes.store;
    // Duck-typed like combinators: a store from a second copy of this package fails instanceof.
    if (store !== undefined && (!isObject(store) || typeof store.get !== 'function')) throw new AuthzConfigError(`${this.where}: scopeAttributes.store must be a ScopeAttributeStore with a get() method`);
    this.attributeStore = store as ScopeAttributeStore | undefined;

    try {
      this.fieldCombiner = new FieldCombiner({ neverRead: this.config.neverRead });
    } catch (e) {
      throw e instanceof AuthzConfigError ? new AuthzConfigError(`${this.where}: config.neverRead: ${e.message}`, { cause: e }) : e;
    }
    const allowed = Object.freeze(subtractFieldGlobs(['*'], this.config.neverRead));
    this.allFields = Object.freeze({ read: allowed, write: allowed });

    this.host = Object.freeze({
      domain: this.domain,
      permissions: this.registry,
      conditions: this.conditions,
      ancestors: (ref: ResourceRef, scope: Map<string, unknown>) => this.marking(scope, () => this.ancestorsOf(this.requireRef(ref), scope)),
      attributes: (ref: ResourceRef, scope: Map<string, unknown>) => this.attributesOf(this.requireRef(ref), scope),
      relation: (type: ResourceType, name: string) => this.relation(type, name),
      // Contexts outside a check (preload); a check's own contexts use hostFor(run).
      nestedCheck: (req: Omit<DecisionRequest, 'explain'>, scope: Map<string, unknown>, instant: Date, depth: number): Promise<Decision> =>
        Promise.resolve(
          this.marking(scope, () =>
            runAsync(this.pipeline(req, this.topRun(false, scope, instant, depth))).then((r) => {
              if (r.faulted) this.markFault(scope);
              return r.decision;
            }),
          ),
        ),
    });
  }

  async check(input: CheckInput, scope?: RequestScope): Promise<Decision> {
    return (await runAsync(this.pipeline(input, this.newRun(false, scope)))).decision;
  }

  /** Every model evaluated, trace attached, caches bypassed. */
  async explain(input: CheckInput, scope?: RequestScope): Promise<Decision> {
    if (!isObject(input)) throw new AuthzConfigError(`${this.where}: check input must be an object`);
    return this.check({ ...input, explain: true }, scope);
  }

  async checkMany(principal: Principal, permissions: readonly Permission[], resource?: ResourceRef | object, scope?: RequestScope): Promise<ReadonlyMap<Permission, Decision>> {
    if (!Array.isArray(permissions)) throw new AuthzConfigError(`${this.where}: checkMany permissions must be an array`);
    const shared: RequestScope = { cache: scopeMap(scope) };
    const resolved = resource === undefined ? undefined : await runAsync(this.resolveObject(resource));
    const out = new Map<Permission, Decision>();
    for (const permission of permissions) {
      if (out.has(permission)) continue;
      out.set(permission, (await runAsync(this.pipeline({ principal, permission }, this.newRun(false, shared), resolved))).decision);
    }
    return out;
  }

  async filter(principal: Principal, permission: Permission, type: ResourceType, scope?: RequestScope): Promise<ResourceFilter> {
    return (await this.check({ principal, permission, resource: { type } }, scope)).residual;
  }

  /** `undefined` when some step needs IO. */
  filterNow(principal: Principal, permission: Permission, type: ResourceType, scope?: RequestScope): ResourceFilter | undefined {
    return runSync(this.pipeline({ principal, permission, resource: { type } }, this.newRun(true, scope)))?.value.decision.residual;
  }

  /**
   * B25: a quiet check per candidate permission at `at`, sharing one scope.
   * Candidates: the registered names the routed models' summaries list, or
   * every permission checkable at `at` when some routed model gives no
   * summary (none, a failure or a timeout). An allowed check gives the entry.
   * A check that denies gives a conditional entry when a summary entry left
   * by the principal's ceilings lists the name (RFC L1-3: a check at
   * `$global` is concrete and misses grants below it), with the union of
   * those entries' fields less neverRead. A check that throws or rests on an
   * engine fault leaves its permission out, and so does every check left
   * when the call's deadline (DEADLINE_FACTOR × modelTimeoutMs) passes.
   */
  async summary(principal: Principal, at: ResourceRef = GLOBAL, scope?: RequestScope): Promise<AccessSummary> {
    const ref = this.requireRef(at);
    this.refuseLateType(ref.type);
    const gate = this.principalGate(principal);
    if (gate.kind === 'deny') return deepFreeze({ principal: gate.principal, models: [], permissions: [] });
    const { defs } = this.checkable(ref, 'summary');
    if (gate.kind === 'system') return deepFreeze({ principal: SYSTEM_REF, models: [], permissions: defs.map((def) => summaryEntry(def, false, this.allFields)) });

    const run = this.quietRun(scope);
    const limit = new Deadline(DEADLINE_FACTOR * this.config.modelTimeoutMs);
    try {
      const out: { -readonly [K in keyof AccessSummary]: AccessSummary[K] } = { principal: gate.ref, models: [], permissions: [] };
      const ceiling = summaryCeiling(gate.principal);
      if (ceiling) out.ceiling = ceiling;
      const summaries = await this.modelSummaries(gate.principal, ref, defs, { ...run, nested: newNested() });
      out.models = summaries.list;
      const candidates = summaries.names === undefined ? defs : defs.filter((d) => summaries.names!.has(d.name));
      const listed = this.summaryEntries(gate.principal, summaries.list, defs, run.instant) ?? new Map<Permission, SummaryItem[]>();
      const checked = await this.checkEach(gate.principal, candidates, ref, run, limit);
      const faulted = candidates
        .filter((_, i) => {
          const c = checked[i];
          return c !== undefined && c !== THREW && c.faulted;
        })
        .map((d) => d.name);
      if (faulted.length > 0) this.logAt('error', `${this.where}: summary left out ${faulted.length} permission(s) whose decision rests on an engine fault: ${faulted.slice(0, 10).join(', ')}${faulted.length > 10 ? ', …' : ''}`);
      out.permissions = candidates.flatMap((def, i) => {
        const c = checked[i];
        if (c === undefined || c === THREW || c.faulted) return [];
        if (c.decision.allowed) return [summaryEntry(def, c.decision.residual.op !== 'true', c.decision.fields)];
        const entries = listed.get(def.name);
        if (entries === undefined) return [];
        try {
          return [summaryEntry(def, true, def.fields === true ? this.listedFields(entries) : NO_FIELDS)];
        } catch (e) {
          this.logAt('error', `${this.where}: summary left out ${def.name}: the fields its model summaries list could not be combined: ${describeError(e)}`);
          return [];
        }
      });
      return deepFreeze(out);
    } finally {
      limit.clear();
    }
  }

  /**
   * B26: the holder's combined set at `at` strictly contains the target's,
   * over every permission checkable at `at`. At `$global` both are also
   * checked on each type of the permission, since the `$global` node does not
   * speak for the rows below it, and every comparison must hold on each of
   * those refs (strictly above on any). RFC L1-3, asymmetric so that a
   * summary can only shrink what the holder covers: the holder's set is its
   * checks at `at`; the target's is its checks at `at` and the entries of
   * every model routed for the permission (at `$global`, also for each of
   * its types) after the target's ceilings. A summary entry needs an
   * unconditional holder with its fields, and keeps an equal holder from being
   * strictly above. The target's denies never drop an entry: a deny may rest
   * on session facts (authn, actor) that change under impersonation. The
   * holder's fields are those of its unconditional permits only (`firmFields`).
   * False when a compared route plan uses a custom combinator, for a target
   * (or a holder other than SYSTEM) that the principal gate or the
   * onBehalfOf resolution refuses, when a model routed for the
   * target gives no summary, when any check throws or rests on an engine
   * fault, when a field comparison throws, and past the call's deadline.
   */
  async covers(holder: Principal, target: Principal, at: ResourceRef = GLOBAL, scope?: RequestScope): Promise<boolean> {
    const ref = this.requireRef(at);
    this.refuseLateType(ref.type);
    // A refused principal's checks all deny, yet it may hold anything elsewhere (SYSTEM of a second authn copy).
    if (!this.admitted(target)) return false;
    if (holder === SYSTEM) return true;
    if (!this.admitted(holder)) return false;
    const { defs, truncated } = this.checkable(ref, 'covers');
    if (truncated) return false;
    const run = this.quietRun(scope);
    // After quietRun: a model version change recompiles the routes there.
    const custom = this.customPlan(defs, ref);
    if (custom) {
      this.logAt('error', `${this.where}: covers is false: ${custom.def.name} on ${quote(custom.type)} uses the combinator ${quote(custom.algorithm)}, which may allow without a permit that a summary lists`);
      return false;
    }
    const limit = new Deadline(DEADLINE_FACTOR * this.config.modelTimeoutMs);
    let strict = false;
    try {
      const summarized = await limit.race(this.modelSummaries(target, ref, defs, { ...run, nested: newNested() }));
      if (summarized === EXPIRED) {
        this.logAt('error', `${this.where}: covers is false: it ran past its deadline of ${limit.ms} ms`);
        return false;
      }
      if (summarized.names === undefined) {
        this.logAt('error', `${this.where}: covers is false: a model routed for the target gave no summary`);
        return false;
      }
      const listed = this.summaryEntries(target, summarized.list, defs, run.instant);
      if (listed === undefined) {
        this.logAt('error', `${this.where}: covers is false: the onBehalfOf chain of the target does not resolve`);
        return false;
      }
      for (let i = 0; i < defs.length; i += SUMMARY_BATCH) {
        const batch = defs.slice(i, i + SUMMARY_BATCH);
        const compared = await limit.race(Promise.all(batch.map((def) => Promise.all(comparedRefs(def, ref).map((r) => Promise.all([this.quietCheck(holder, def, r, run, true), this.quietCheck(target, def, r, run)]))))));
        if (compared === EXPIRED) {
          this.logAt('error', `${this.where}: covers is false: it ran past its deadline of ${limit.ms} ms`);
          return false;
        }
        for (const [k, pairs] of compared.entries()) {
          const def = batch[k];
          // A denial on missing data is no proof that the target lacks the permission; a holder fault is refused too, to stay simple.
          const fault = pairs.find(([h, t]) => h.faulted || t.faulted);
          if (fault) {
            this.logAt('error', `${this.where}: covers is false: the ${fault[0].faulted ? 'holder' : 'target'} check of ${def.name} rests on an engine fault`);
            return false;
          }
          // Only the gate denies `unattended`: the target read as another type than when it was admitted.
          if (pairs.some(([h, t]) => t.decision.reason?.code === 'unattended' || !entryCovers(h.decision, t.decision, firmFieldsOf(h)))) return false;
          const entries = listed.get(def.name) ?? [];
          if (entries.some((e) => pairs.some(([h]) => !this.summaryCovered(h, e, def)))) return false;
          // An entry against a conditional holder is unknown, so it does not make the holder strictly above.
          const blocked = (h: Checked) => entries.some((e) => !e.conditional || h.decision.residual.op !== 'true');
          if (pairs.some(([h, t]) => h.decision.allowed && !entryCovers(t.decision, h.decision) && !blocked(h))) strict = true;
        }
      }
    } catch (e) {
      this.logAt('error', `${this.where}: covers is false: a check or a field comparison failed: ${describeError(e)}`);
      return false;
    } finally {
      limit.clear();
    }
    return strict;
  }

  /**
   * Preloads every principal the models of a check would run with: the run-as
   * principal and each intersect delegate's, never an inherit agent. A model
   * preload that fails or outlasts modelTimeoutMs leaves its principal
   * unrecorded and marks the request scope faulted.
   */
  async preload(principal: Principal, scope?: RequestScope): Promise<void> {
    const runAs: { readonly who: Principal; readonly cacheId: string }[] = [];
    try {
      // Mirrors the pipeline: the gate, then delegation, then the intersect delegate's own check with the hops left.
      let next: Principal | undefined = principal;
      let hopsLeft = this.config.maxDelegation;
      while (next !== undefined) {
        const gate = this.principalGate(next);
        if (gate.kind !== 'run') break;
        const d = resolveDelegation(gate.principal, undefined, hopsLeft);
        if (d.denial) break;
        runAs.push({ who: d.principal, cacheId: principalCacheId(d.principal) });
        next = d.intersect;
        hopsLeft -= d.hopsUsed;
      }
    } catch (e) {
      // A check of this principal throws too, so no model would run.
      this.logAt('error', `${this.where}: preload could not resolve the onBehalfOf chain, preloading nothing: ${describeError(e)}`);
      return;
    }
    const map = scopeMap(scope);
    const instant = this.now();
    // A version change first, so the scope is born with the generation its data belongs to.
    this.epoch();
    this.bornOf(map);
    const generation = this.generation;
    const failed = new Set<string>();
    await Promise.all(
      this.modelList.flatMap((model) =>
        typeof model.preload !== 'function'
          ? []
          : runAs.map(async ({ who, cacheId }) => {
              const settled = await settleWithin(
                Promise.resolve().then(() => model.preload!(who, new ModelContext(this.host, model.name, map, instant, 0, undefined, contextCacheKey(model.name, cacheId)))),
                this.config.modelTimeoutMs,
                describeError,
                'preload',
              );
              if (settled.ok) return;
              failed.add(cacheId);
              // The model may now vote from missing per-request state.
              this.markFault(map);
              this.logAt('error', `${this.where}: model ${quote(model.name)} failed to preload: ${settled.error}`);
            }),
      ),
    );
    // An invalidate() during the preload may have dropped what it loaded.
    if (this.generation !== generation) return;
    for (const { cacheId } of runAs) {
      if (failed.has(cacheId)) continue;
      map.set(l1Key('preloaded', this.domain, cacheId), generation);
      this.preloaded.delete(cacheId);
      this.preloaded.set(cacheId, generation);
      if (this.preloaded.size > MAX_PRELOADED) this.preloaded.delete(this.preloaded.keys().next().value!);
    }
  }

  invalidate(tags: readonly string[]): void {
    this.generation = nextGeneration();
    this.preloaded.clear();
    this.invalidateL2(invalidationTags(tags));
    const copy = Object.freeze(Array.isArray(tags) ? [...tags] : []);
    for (const model of this.modelList) {
      try {
        if (typeof model.invalidate === 'function') model.invalidate(copy);
      } catch (e) {
        this.logAt('error', `${this.where}: model ${quote(model.name)} failed to invalidate: ${describeError(e)}`);
      }
    }
  }

  models(): readonly AuthorizationModel[] {
    return this.modelList;
  }

  routes(): RouteTable {
    return this.table;
  }

  // ---- summary and covers ----

  /** The principal gate lets `p` run models and its onBehalfOf chain resolves without a denial or a throw. */
  private admitted(p: unknown): boolean {
    const gate = this.principalGate(p);
    if (gate.kind !== 'run') return false;
    try {
      return this.delegation(gate.principal, undefined, this.config.maxDelegation).denial === undefined;
    } catch (e) {
      this.logAt('debug', `${this.where}: covers is false: the onBehalfOf chain of ${principalKey(gate.ref)} does not resolve: ${describeError(e)}`);
      return false;
    }
  }

  /** The base run of one summary or covers call: one instant, version vector and generation for every check; never audited. */
  private quietRun(scope: RequestScope | undefined): Run {
    return { ...this.newRun(false, scope), quiet: true };
  }

  /** Registered permissions checkable at `ref` (its type in `types`, or `$global`), sorted by name, at most MAX_SUMMARY_PERMISSIONS. */
  private checkable(ref: ResourceRef, what: string): { readonly defs: readonly PermissionDef[]; readonly truncated: boolean } {
    const defs = this.registry
      .all()
      .filter((d) => ref.type === GLOBAL_TYPE || d.types.includes(ref.type))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (defs.length <= MAX_SUMMARY_PERMISSIONS) return { defs, truncated: false };
    this.logAt('warn', `${this.where}: ${what} at ${resourceKey(ref)} has ${defs.length} permissions to check, more than the limit of ${MAX_SUMMARY_PERMISSIONS}`);
    return { defs: defs.slice(0, MAX_SUMMARY_PERMISSIONS), truncated: true };
  }

  /**
   * The summaries of the models routed for `defs` at `ref` (at `$global`, also
   * at each of a permission's types) that serve the principal the models run
   * with. `names` is undefined when one of them gave no usable summary.
   */
  private async modelSummaries(principal: Principal, ref: ResourceRef, defs: readonly PermissionDef[], run: Run): Promise<{ readonly list: readonly ModelSummary[]; readonly names: ReadonlySet<string> | undefined }> {
    let runAs: Principal;
    try {
      const d = this.delegation(principal, undefined, this.config.maxDelegation);
      // Every check denies `delegate` then.
      if (d.denial) return { list: [], names: undefined };
      runAs = d.principal;
    } catch (e) {
      this.logAt('error', `${this.where}: summary could not resolve the onBehalfOf chain: ${describeError(e)}`);
      return { list: [], names: undefined };
    }
    const routed = new Set<AuthorizationModel>();
    for (const def of defs) {
      // A check at $global is concrete: the models routed for the permission's types hold what lies below it.
      for (const type of ref.type === GLOBAL_TYPE ? [ref.type, ...def.types] : [ref.type]) for (const m of this.table.get(def.name, type)?.models ?? []) routed.add(m);
    }
    const host = this.hostFor(run);
    const cacheId = principalCacheId(runAs);
    let complete = true;
    const results = await Promise.all(
      this.modelList
        .filter((m) => routed.has(m) && admits(m, runAs))
        .map(async (model): Promise<ModelSummary | undefined> => {
          try {
            if (typeof model.summarize !== 'function') {
              complete = false;
              return undefined;
            }
            // Its own memo: a summarize that fails half-way must not leave state the votes read.
            const ctx = new ModelContext(host, model.name, run.scope, run.instant, 0, undefined, contextCacheKey(model.name, cacheId, 'summarize'));
            const settled = await settleWithin(
              Promise.resolve().then(() => model.summarize!(runAs, ref, ctx)),
              this.config.modelTimeoutMs,
              describeError,
              'summarize',
            );
            if (!settled.ok) throw new Error(settled.error);
            return copySummary(settled.value, model.name);
          } catch (e) {
            complete = false;
            this.logAt('error', `${this.where}: model ${quote(model.name)} failed to summarize, left out: ${describeError(e)}`);
            return undefined;
          }
        }),
    );
    const list = results.filter((s): s is ModelSummary => s !== undefined);
    return { list, names: complete ? new Set(list.flatMap((s) => s.permissions.map((p) => p.name))) : undefined };
  }

  /**
   * One quiet check per permission, SUMMARY_BATCH at a time, until `limit`
   * passes: THREW where the check threw, undefined where it had not settled
   * by then (checks still running are left to finish unread).
   */
  private async checkEach(principal: Principal, defs: readonly PermissionDef[], ref: ResourceRef, run: Run, limit: Deadline): Promise<(Checked | typeof THREW | undefined)[]> {
    const out: (Checked | typeof THREW | undefined)[] = defs.map(() => undefined);
    let failed = 0;
    let first: unknown;
    for (let i = 0; i < defs.length && !limit.expired; i += SUMMARY_BATCH) {
      const batch = defs.slice(i, i + SUMMARY_BATCH).map((def, j) =>
        this.quietCheck(principal, def, ref, run).then(
          (c) => {
            if (!limit.expired) out[i + j] = c;
          },
          (e: unknown) => {
            if (limit.expired) return;
            out[i + j] = THREW;
            if (failed++ === 0) first = e;
          },
        ),
      );
      await limit.race(Promise.all(batch));
    }
    if (failed > 0) this.logAt('error', `${this.where}: summary left out ${failed} permission(s) whose check threw, the first: ${describeError(first)}`);
    const unchecked = out.filter((c) => c === undefined).length;
    if (unchecked > 0) this.logAt('error', `${this.where}: summary left out ${unchecked} permission(s) not checked within its deadline of ${limit.ms} ms`);
    return out;
  }

  /** `run`: the call's quietRun; each check is its own call tree, so it gets its own nested record. */
  private quietCheck(principal: Principal, def: PermissionDef, ref: ResourceRef, run: Run, firm = false): Promise<Checked> {
    return runAsync(this.pipeline({ principal, permission: def.name }, { ...run, nested: newNested(), ...(firm ? { firm } : {}) }, { ref, subject: undefined }));
  }

  /**
   * The summary entries for `defs` by name, under the ceilings of the
   * principal's onBehalfOf resolution (the ones its checks apply); undefined
   * when the resolution throws or denies.
   */
  private summaryEntries(principal: Principal, list: readonly ModelSummary[], defs: readonly PermissionDef[], instant: Date): Map<Permission, SummaryItem[]> | undefined {
    let ceilings: readonly unknown[];
    try {
      const d = this.delegation(principal, undefined, this.config.maxDelegation);
      if (d.denial) return undefined;
      ceilings = d.ceilings;
    } catch {
      return undefined;
    }
    const names = new Set(defs.map((d) => d.name));
    const out = new Map<Permission, SummaryItem[]>();
    for (const summary of list) {
      for (const entry of summary.permissions) {
        if (!names.has(entry.name)) continue;
        const kept = underCeilings(ceilings, entry, instant);
        if (kept === undefined) continue;
        const entries = out.get(entry.name);
        if (entries) entries.push(kept);
        else out.set(entry.name, [kept]);
      }
    }
    return out;
  }

  /** The union of the entries' fields (none listed: every field), less neverRead. Throws AuthzConfigError past the field budget. */
  private listedFields(entries: readonly SummaryItem[]): Fields {
    const union = (k: 'read' | 'write') => subtractFieldGlobs(unionFieldGlobs(...entries.map((e) => e.fields?.[k] ?? ['*'])), this.config.neverRead);
    return { read: union('read'), write: union('write') };
  }

  /**
   * An entry has no residual to compare, so only an unconditional holder
   * covers it, with every field it lists (none listed: every field but
   * neverRead). `hide` only narrows the target, so it is not read.
   */
  private summaryCovered(holder: Checked, entry: SummaryItem, def: PermissionDef): boolean {
    if (!holder.decision.allowed || holder.decision.residual.op !== 'true') return false;
    if (def.fields !== true) return true;
    const held = firmFieldsOf(holder);
    const inside = (k: 'read' | 'write') => subtractFieldGlobs(subtractFieldGlobs(entry.fields?.[k] ?? ['*'], this.config.neverRead), held[k]).length === 0;
    return inside('read') && inside('write');
  }

  /** The first route plan of `defs` at `ref` (at `$global`, also on each type) whose algorithm is not built in. */
  private customPlan(defs: readonly PermissionDef[], ref: ResourceRef): { readonly def: PermissionDef; readonly type: ResourceType; readonly algorithm: string } | undefined {
    for (const def of defs) {
      for (const r of comparedRefs(def, ref)) {
        const algorithm = this.table.get(def.name, r.type)?.algorithm;
        if (algorithm !== undefined && !BUILTIN_ALGORITHMS.has(algorithm)) return { def, type: r.type, algorithm };
      }
    }
    return undefined;
  }

  // ---- the check pipeline (design §10.1) ----

  /** `resolved`: a ref (and subject) the caller already resolved, so no adapter sees it again. */
  private *pipeline(input: CheckInput, run: Run, resolved?: { readonly ref: ResourceRef; readonly subject: unknown }): Pipeline<Checked> {
    const started = performance.now();
    if (!isObject(input)) throw new AuthzConfigError(`${this.where}: check input must be an object`);
    const explain = run.depth === 0 && input.explain === true;
    if (explain) run = { ...run, bypass: true };
    const steps: TraceStep[] | undefined = explain || this.config.explain ? [] : undefined;
    // Engine-owned data goes in as is (frozen with the trace), so a deep residual is never cut.
    const core = (step: string, note: string, data?: unknown) => steps?.push(data === undefined ? { by: CORE, step, note } : { by: CORE, step, note, data });

    const def = this.requirePermission(input.permission);
    const { ref, subject } = resolved ?? (yield* this.resolveResource(input.resource, input.subject, def));
    this.refuseLateType(ref.type);
    if (ref.type !== GLOBAL_TYPE && !def.types.includes(ref.type)) {
      throw new AuthzConfigError(`${this.where}: permission ${quote(def.name)} is checked on type ${quote(ref.type)}, which is not in its types (${def.types.join(', ')}) or $global`);
    }
    core('resource', resourceKey(ref));
    const plan = this.table.get(def.name, ref.type) ?? { algorithm: 'deny-overrides', models: [] };
    const base = { def, ref, algorithm: plan.algorithm, run, explain, steps, started };

    const gate = this.principalGate(input.principal);
    if (gate.kind === 'system') {
      core('principal', 'SYSTEM: allowed without models');
      return { decision: this.finish({ ...base, requester: SYSTEM_REF, system: true }, { principal: SYSTEM_REF, residual: TRUE, roles: NO_ROLES, fields: this.allFields, models: [], votes: [] }), uncacheable: true, faulted: false, ...(run.firm ? { firmFields: this.allFields } : {}) };
    }
    if (gate.kind === 'deny') {
      core('principal', `denied before the models: ${gate.reason.code}`);
      return { decision: this.finish({ ...base, requester: gate.principal }, this.coreDenial(gate.principal, gate.reason)), uncacheable: false, faulted: false };
    }
    const requester = gate.ref;
    const actor = input.actor as Principal | undefined;
    // Before the resource step, so a chain deeper than maxDelegation throws whatever the resource.
    const delegation = this.delegation(gate.principal, actor, run.delegationBudget);
    // Undefined for a forbidden or unreadable delegate: no model runs, so the denial names the requester.
    const parties = delegation.denial ? undefined : this.parties(delegation, gate.principal, requester);
    // Step 6's key, in the same synchronous stretch as the delegation: the caller may change the principal while a step waits.
    const keyed = parties !== undefined && subject === undefined && !run.bypass && run.versions !== undefined;
    const key = keyed ? decisionKey({ domain: this.domain, principal: gate.principal, actor, permission: def.name, ref, versions: run.versions! }) : undefined;
    if (keyed && key === undefined) this.logAt('debug', `${this.where}: ${def.name} for ${principalKey(requester)} is not cached: the principal or actor has no canonical state`);

    let ancestors: readonly ResourceRef[] | undefined;
    if (ref.id !== undefined) {
      const list = (yield this.ancestorsOf(ref, run.scope)) as readonly ResourceRef[] | null;
      if (list === null) {
        core('resource', 'unknown resource: ancestors answered null');
        // No revocation tag reaches a resource that does not exist yet: a decision resting on this one is not cached.
        if (run.depth > 0) run.nested.uncacheable = true;
        return { decision: this.finish({ ...base, requester }, parties ? this.partiesDenial(parties, { code: 'unknown_resource' }) : this.coreDenial(requester, { code: 'unknown_resource' })), uncacheable: false, faulted: false };
      }
      ancestors = list;
    }

    if (!parties) {
      core('delegation', 'denied before the models: a forbidden or unreadable delegate');
      return { decision: this.finish({ ...base, requester }, this.coreDenial(requester, delegation.denial!)), uncacheable: false, faulted: false };
    }

    // Step 6.
    const principals: Principal[] = [gate.principal, ...delegation.chain];
    if (actor !== undefined) principals.push(actor);
    if (delegation.actor !== undefined) principals.push(delegation.actor);
    const tags = once(() => this.tagsOf(plan.models, principals, ref, ancestors, run));
    if (key !== undefined && run.firm !== true) {
      const hit = this.cached(key, run, def, ref, requester, parties.ref);
      if (hit) return hit;
    }

    if (parties.principal !== gate.principal) core('delegation', `inherit: the models run as ${principalKey(parties.ref)}`);
    // Before the models: a model receives the principal and must not be able to move what the ceiling reads.
    const ceiling = this.ceilingOf(delegation, def, ref, ancestors, run.instant);
    const env = this.envOf(input.env, run.instant);
    const delegated = delegation.intersect === undefined ? undefined : yield* this.delegateCheck(delegation.intersect, delegation.hopsUsed, def, ref, subject, input.env, run);
    const delegate = delegated?.decision;
    if (delegate) core('delegation', `intersect: the delegate ${delegation.intersectKey} is ${delegate.allowed ? 'allowed' : 'denied'}`, { residual: delegate.residual });

    const models = plan.models.filter((m) => {
      const admitted = admits(m, parties.principal);
      if (!admitted) core('skip', `model ${quote(m.name)} does not serve principal type ${quote(parties.principal.type)}`);
      return admitted;
    });
    core('route', `${plan.algorithm} over ${models.length} model(s)`, { models: models.map((m) => m.name) });
    const host = this.hostFor(run);
    const contexts = models.map((m) => new ModelContext(host, m.name, run.scope, run.instant, run.depth, steps, contextCacheKey(m.name, parties.cacheId)));
    const request = () => this.request(parties, def, ref, subject, input.env, run.instant, explain);
    const label = `${def.name} on ${resourceKey(ref)}`;
    const binder = this.refBinder(parties, env, ancestors, run);
    const voteLoads = { degraded: false };
    const resolve = (vs: readonly Vote[]) => this.resolveScopeRefs(vs, binder, label, voteLoads);
    const votes = yield* this.evaluate(models, contexts, request, plan.algorithm, explain, run, label, resolve, parties.cacheId);

    const combined = this.combine(plan.algorithm, votes);
    const allow = ceiling.denials.length > 0 ? FALSE : and(combined.allow, ceiling.restrict);
    const bound = yield* this.bind(allow, binder);
    let residual = bound.residual;
    const coreDenials: DenyReason[] = [...ceiling.denials];
    // Core contexts handed to native filters during the subject steps.
    const cores: ModelContext[] = [];
    let subjectFault = false;
    let typeLevel: Checked | undefined;
    if (delegate) {
      const strips = delegation.intersectKey !== principalKey(parties.ref);
      // The delegate's residual is already bound for the delegate; SQL and the subject evaluator would read its principal ops as ours.
      let theirs = !delegate.allowed ? FALSE : strips ? stripPrincipalOps(delegate.residual) : delegate.residual;
      if (strips && subject !== undefined && delegate.allowed && residual.op !== 'false') {
        // The filter strips the delegate's relation and native ops, which the subject check above evaluated exactly: the row must also pass the stripped type-level residual, or filter and check part (B06).
        typeLevel = yield* this.delegateCheck(delegation.intersect!, delegation.hopsUsed, def, { type: ref.type }, undefined, input.env, run);
        const strip = typeLevel.decision.allowed ? stripPrincipalOps(typeLevel.decision.residual) : FALSE;
        let truth: string = !typeLevel.decision.allowed ? 'the delegate is denied' : strip.op === 'true' ? 'TRUE' : 'FALSE';
        let holds = strip.op === 'true';
        if (strip.op !== 'true' && strip.op !== 'false') {
          const settled = (yield settleWithin(evaluateResidual(strip, subject, this.subjectEnv(parties, ref, run, steps, cores)), this.config.modelTimeoutMs, describeError, 'subject evaluation')) as Settled;
          if (!settled.ok) {
            subjectFault = true;
            this.logAt('error', `${this.where}: evaluating the stripped type-level residual of the delegate ${delegation.intersectKey} of ${label} against the subject failed: ${settled.error}`);
          }
          holds = settled.ok && settled.value === true;
          truth = settled.ok ? (settled.value === undefined ? 'UNKNOWN' : String(settled.value)) : settled.error;
        }
        core('delegation', `intersect: the delegate's type-level residual, stripped, against the subject: ${truth}`, { residual: strip });
        if (!holds) theirs = FALSE;
      }
      if (theirs.op === 'false') coreDenials.push(Object.freeze({ code: 'delegate', priority: DELEGATE_PRIORITY, delegate: delegation.intersectKey }));
      residual = and(residual, theirs);
    }
    core('combine', `allow ${residual.op === 'true' ? 'TRUE' : residual.op === 'false' ? 'FALSE' : 'residual'}`, { residual });

    let subjectDenied = false;
    if (subject !== undefined && residual.op !== 'true' && residual.op !== 'false') {
      const settled = (yield settleWithin(evaluateResidual(residual, subject, this.subjectEnv(parties, ref, run, steps, cores)), this.config.modelTimeoutMs, describeError, 'subject evaluation')) as Settled;
      const truth = settled.ok ? settled.value : undefined;
      if (!settled.ok) {
        subjectFault = true;
        this.logAt('error', `${this.where}: evaluating the residual of ${label} against the subject failed: ${settled.error}`);
      }
      core('subject', `residual against the subject: ${settled.ok ? (truth === undefined ? 'UNKNOWN' : String(truth)) : settled.error}`);
      residual = truth === true ? TRUE : FALSE;
      subjectDenied = truth !== true;
    }

    let allowed = residual.op !== 'false';
    let fields: Fields = NO_FIELDS;
    let firmFields: Fields | undefined = run.firm ? NO_FIELDS : undefined;
    let fieldsFailed = false;
    let fieldsUncacheable = false;
    let fieldsFaulted = false;
    if (allowed) {
      const firmDelegate = delegated?.firmFields ?? delegate?.fields;
      const f = yield* this.fieldsOf(plan.algorithm, votes, binder, delegate?.fields, label, run.firm ? (firmDelegate ? { delegate: firmDelegate } : {}) : undefined);
      fieldsUncacheable = f.uncacheable;
      fieldsFaulted = f.faulted;
      if (f.failed) {
        core('fields', 'combining the field sets failed: denied');
        residual = FALSE;
        allowed = false;
        fieldsFailed = true;
      } else {
        fields = f.fields;
        if (run.firm) firmFields = f.firm ?? NO_FIELDS;
      }
    }
    let reason: DenyReason | undefined;
    let reasonsUncacheable = false;
    // The allow held up to the fields step, so no vote or core step caused this denial.
    if (fieldsFailed) reason = ENGINE_FAULT;
    else if (!allowed) {
      // Also when the allow was FALSE before the subject step: a row-level deny entry may still beat a ceiling.
      const pass = subject !== undefined && !subjectFault ? yield* this.subjectTruths(votes, combined.deciding, plan.algorithm, subject, binder, parties, ref, run, label, core, cores) : { truths: votes.map(staticTruths), uncacheable: false };
      reasonsUncacheable = pass.uncacheable;
      reason = this.denyReason(coreDenials, votes, pass.truths, combined.deciding, plan.algorithm, subjectDenied && !subjectFault, combined.failed || bound.failed || subjectFault);
    }
    const outcome: { -readonly [K in keyof Outcome]: Outcome[K] } = {
      principal: parties.ref,
      residual: allowed ? residual : FALSE,
      roles: mergeRoles(votes),
      fields,
      models: models.map((m) => m.name),
      votes,
    };
    if (parties.actorRef) outcome.actor = parties.actorRef;
    if (reason) outcome.reason = reason;
    const validUntil = earliest([...votes.map((v) => v.validUntil), ceiling.expiresAt, delegate?.validUntil, typeLevel?.decision.validUntil]);
    if (validUntil) outcome.validUntil = validUntil;
    const faulted = votes.some((v) => v.error !== undefined) || voteLoads.degraded || combined.failed || bound.failed || bound.degraded || subjectFault || fieldsFaulted || delegated?.faulted === true || typeLevel?.faulted === true || run.nested.faulted || this.scopeFaulted(run.scope);
    if (faulted) {
      run.nested.faulted = true;
      // A model may memoise a nested answer in ctx.cache; the marker stops later checks of the request trusting it.
      if (run.depth > 0) this.markFault(run.scope);
      // A marker here would fail every later summary/covers of the request; dropping the memos this decision wrote is enough.
      else for (const ctx of [...contexts.slice(0, votes.length), ...cores]) ctx.detachMemo();
    }
    const uncacheable = faulted || bound.uncacheable || fieldsUncacheable || reasonsUncacheable || delegated?.uncacheable === true || typeLevel?.uncacheable === true || votes.some((v) => v.cacheable !== true) || run.nested.uncacheable;
    return this.remember({ decision: this.finish({ ...base, requester }, outcome), uncacheable, faulted, ...(firmFields ? { firmFields } : {}) }, key, run, tags);
  }

  // ---- L1/L2 lookup and store (design §10.3) ----

  /** L1, then L2. An L1 hit is not audited again, unless no audit recorded its denial yet; an L2 hit is audited like a fresh decision. */
  private cached(key: string, run: Run, def: PermissionDef, ref: ResourceRef, requester: PrincipalRef, runAs: PrincipalRef): Checked | undefined {
    const now = run.instant.getTime();
    const l1 = l1Key('decision', this.domain, key);
    const entry = run.scope.get(l1);
    if (entry instanceof CachedDecision && entry.generation === this.generation && now < entry.expiresAt) {
      if (run.depth > 0) nest(run, entry.tags);
      if (entry.unaudited && audits(run)) {
        entry.unaudited = false;
        this.auditDenial(requester, def, ref, entry.decision);
      }
      return { decision: withOwnDate(entry.decision), uncacheable: false, faulted: false };
    }
    if (!this.cache || this.l2Stale) return undefined;
    let found: unknown;
    try {
      found = this.cache.get(key);
    } catch (e) {
      this.logAt('error', `${this.where}: the decision cache failed on get: ${describeError(e)}`);
      return undefined;
    }
    swallow(found);
    const decision = this.usable(found, def, ref, runAs, now);
    if (!decision) {
      if (found !== undefined) this.logAt('warn', `${this.where}: ignored a cached decision that does not match ${def.name} on ${resourceKey(ref)} or has expired`);
      return undefined;
    }
    // The L2 returns no tags, so what the stored decision rested on (nested checks, scope nodes) is unknown here.
    if (run.depth > 0) nest(run, undefined);
    const ttl = this.ttlOf(decision);
    if (ttl) run.scope.set(l1, new CachedDecision(decision, undefined, ttl.now + ttl.ms, run.generation, !decision.allowed && !audits(run)));
    if (audits(run) && !decision.allowed) this.auditDenial(requester, def, ref, decision);
    return { decision: withOwnDate(decision), uncacheable: false, faulted: false };
  }

  private auditDenial(requester: PrincipalRef, def: PermissionDef, ref: ResourceRef, decision: Decision): void {
    if (this.config.auditDenials) this.record({ kind: 'deny', principal: requester, permission: def.name, resource: ref, reason: decision.reason?.code ?? 'no_access' });
  }

  /** A decision from the L2 is used only when it is what this check asks for and still valid. */
  private usable(v: unknown, def: PermissionDef, ref: ResourceRef, runAs: PrincipalRef, now: number): Decision | undefined {
    if (!isObject(v) || typeof v.allowed !== 'boolean' || v.domain !== this.domain || v.permission !== def.name || !isObject(v.residual) || !isObject(v.resource)) return undefined;
    if (v.allowed !== (v.residual.op !== 'false') || !isObject(v.principal) || v.principal.type !== runAs.type || v.principal.id !== runAs.id || v.resource.type !== ref.type || (v.resource.id ?? undefined) !== ref.id) return undefined;
    if (v.validUntil !== undefined) {
      const until = validDate(v.validUntil);
      if (!until || until.getTime() <= now) return undefined;
    }
    return Object.isFrozen(v) ? (v as unknown as Decision) : deepFreeze(v as unknown as Decision);
  }

  /** Stores a cacheable decision (L1 always, L2 when its tags are known and no invalidate came since the scope was born) and hands its tags to the decisions above. */
  private remember(checked: Checked, key: string | undefined, run: Run, tags: () => readonly string[] | undefined): Checked {
    if (run.depth > 0) {
      if (checked.uncacheable) run.nested.uncacheable = true;
      else nest(run, tags());
    }
    if (key === undefined || checked.uncacheable) return checked;
    const ttl = this.ttlOf(checked.decision);
    if (!ttl) return checked;
    const t = tags();
    const stored = withOwnDate(checked.decision);
    run.scope.set(l1Key('decision', this.domain, key), new CachedDecision(stored, t, ttl.now + ttl.ms, run.generation, !stored.allowed && !audits(run)));
    if (this.cache && !this.l2Stale && t !== undefined && this.generation === run.generation) {
      try {
        this.cache.set(key, stored, t, ttl.ms);
      } catch (e) {
        this.logAt('error', `${this.where}: the decision cache failed on set: ${describeError(e)}`);
      }
    }
    return checked;
  }

  /** min(cacheTtlSeconds, validUntil − now), measured when the decision is stored; undefined when it is not positive. */
  private ttlOf(decision: Decision): { readonly ms: number; readonly now: number } | undefined {
    let now: number;
    try {
      const date = validDate(this.clock());
      if (!date) return undefined;
      now = date.getTime();
    } catch {
      return undefined;
    }
    let ms = this.config.cacheTtlSeconds * 1000;
    if (decision.validUntil !== undefined) ms = Math.min(ms, decision.validUntil.getTime() - now);
    return Number.isFinite(ms) && ms > 0 ? { ms, now } : undefined;
  }

  /** entryTags plus every scope node the request loaded (binder or ctx.attributes) and the nested decisions' tags; undefined when some nested tags are unknown. */
  private tagsOf(models: readonly AuthorizationModel[], principals: readonly Principal[], ref: ResourceRef, ancestors: readonly ResourceRef[] | undefined, run: Run): readonly string[] | undefined {
    let base: readonly string[] | undefined;
    try {
      base = entryTags({ models: models.map((m) => m.name), principals, ref, ancestors: ref.id === undefined ? undefined : ancestors });
    } catch {
      return undefined;
    }
    if (base === undefined || run.nested.untagged) return undefined;
    const out = new Set(base);
    for (const load of this.loads(run.scope)) out.add(`scope:${resourceKey(load.ref)}`);
    for (const t of run.nested.tags) out.add(t);
    return Object.freeze([...out].sort());
  }

  /** Every scope node load of this request, in this domain. */
  private loads(scope: Map<string, unknown>): NodeLoad[] {
    return memo(scope, l1Key('nodes', this.domain, ''), () => [] as NodeLoad[]);
  }

  /** A model may memoise in ctx.cache what a degraded load or a rejected host call gave it, so every later decision of the request may rest on it. */
  private scopeFaulted(scope: Map<string, unknown>): boolean {
    return scope.get(l1Key('fault', this.domain, '')) === true || this.loads(scope).some((l) => l.degraded);
  }

  private markFault(scope: Map<string, unknown>): void {
    scope.set(l1Key('fault', this.domain, ''), true);
  }

  /** Marks the request scope when the call throws or rejects, then lets the failure through. */
  private marking<T>(scope: Map<string, unknown>, call: () => MaybePromise<T>): MaybePromise<T> {
    let r: MaybePromise<T>;
    try {
      r = call();
    } catch (e) {
      this.markFault(scope);
      throw e;
    }
    if (!isThenable(r)) return r;
    return Promise.resolve(r).catch((e: unknown) => {
      this.markFault(scope);
      throw e;
    });
  }

  /** The version vector of a top-level call. A change recompiles the routes and drops the L2; undefined turns caching off for the call. */
  private epoch(): string | undefined {
    // The first failure was logged at error; a cache that stays down would log every call.
    if (this.l2Stale) this.invalidateL2(['*'], 'debug');
    const versions = versionVector(this.modelList);
    if (versions === undefined) {
      if (!this.versionsWarned) {
        this.versionsWarned = true;
        this.logAt('warn', `${this.where}: a model's version() threw or returned a non-string; decisions are not cached while it does`);
      }
      return undefined;
    }
    if (versions !== this.versions) {
      this.generation = nextGeneration();
      this.invalidateL2(['*']);
      try {
        this.table = this.compileTable();
      } catch (e) {
        // The old routes stay; the next call tries again.
        this.logAt('error', `${this.where}: recompiling the routes after a model version change failed; decisions are not cached: ${describeError(e)}`);
        return undefined;
      }
      this.versions = versions;
    }
    return versions;
  }

  /** The generation when this Authorizer first touched the request scope (its first run or preload). */
  private bornOf(scope: Map<string, unknown>): number {
    return memo(scope, l1Key('generation', this.domain, ''), () => this.generation);
  }

  private compileTable(): RouteTable {
    return compileRoutes({ domain: this.domain, models: this.modelList, registry: this.registry, combine: this.combineConfig, algorithms: [...this.combinators.keys()] });
  }

  private invalidateL2(tags: readonly string[], level: 'error' | 'debug' = 'error'): void {
    if (!this.cache) return;
    try {
      this.cache.invalidate(tags);
      if (tags.includes('*')) this.l2Stale = false;
    } catch (e) {
      this.l2Stale = true;
      this.logAt(level, `${this.where}: the decision cache failed to invalidate ${tags.join(', ')}; it is not used until a full invalidation succeeds: ${describeError(e)}`);
    }
  }

  /**
   * The context host of one call tree: a model's ctx.check shares its versions,
   * generation, nested record and cache bypass. A failed (or, for attributes,
   * timed-out) call marks the tree faulted even when the model catches it; a
   * rejection also marks the request, as nothing else records it.
   */
  private hostFor(run: Run): ContextHost {
    const fault = (e: unknown): never => {
      run.nested.faulted = true;
      this.markFault(run.scope);
      throw e;
    };
    const watched = <T>(call: () => MaybePromise<T>): MaybePromise<T> => {
      let r: MaybePromise<T>;
      try {
        r = call();
      } catch (e) {
        return fault(e);
      }
      return isThenable(r) ? Promise.resolve(r).then(undefined, fault) : r;
    };
    return Object.freeze({
      ...this.host,
      ancestors: (ref: ResourceRef, scope: Map<string, unknown>) => watched(() => this.ancestorsOf(this.requireRef(ref), scope)),
      attributes: (ref: ResourceRef, scope: Map<string, unknown>) =>
        watched(() =>
          this.nodeLoad(this.requireRef(ref), scope).result.then((l) => {
            if (l.degraded) run.nested.faulted = true;
            return l.attributes;
          }),
        ) as Promise<Attributes>,
      nestedCheck: (req: Omit<DecisionRequest, 'explain'>, scope: Map<string, unknown>, instant: Date, depth: number) => runAsync(this.pipeline(req, { ...run, sync: false, scope, instant, depth, delegationBudget: this.config.maxDelegation })).then((r) => r.decision, fault),
    });
  }

  private *resolveResource(resource: unknown, subject: unknown, def: PermissionDef): Pipeline<{ readonly ref: ResourceRef; readonly subject: unknown }> {
    if (resource === undefined) return { ref: Object.freeze({ type: def.resource }), subject };
    const resolved = yield* this.resolveObject(resource);
    return { ref: resolved.ref, subject: subject === undefined ? resolved.subject : subject };
  }

  private *resolveObject(resource: unknown): Pipeline<{ readonly ref: ResourceRef; readonly subject: unknown }> {
    if (!isObject(resource)) throw new AuthzConfigError(`${this.where}: a resource must be a ResourceRef or an object an adapter accepts, got ${resource === null ? 'null' : typeof resource}`);
    for (const adapter of this.adapterList) {
      if (adapter.accepts(resource) !== true) continue;
      const ref = copyRef(yield adapter.refOf(resource));
      if (!ref) throw new AuthzConfigError(`${this.where}: adapter ${quote(adapter.kind)} returned a malformed ref from refOf()`);
      return { ref, subject: resource };
    }
    const ref = refShaped(resource);
    if (!ref) throw new AuthzConfigError(`${this.where}: the resource is neither accepted by an adapter nor a ResourceRef ({ type, id? } with a string id or null)`);
    return { ref, subject: undefined };
  }

  /**
   * Step 8: concurrent under deny-overrides and custom algorithms; in plan
   * order with a stop otherwise. `resolve` (resolveScopeRefs) runs on each vote
   * before the stop rule reads it, so check and explain stop at the same vote.
   */
  private *evaluate(models: readonly AuthorizationModel[], contexts: readonly ModelContext[], request: () => DecisionRequest, algorithm: string, explain: boolean, run: Run, label: string, resolve: (votes: readonly Vote[]) => Pipeline<Vote[]>, cacheId: string): Pipeline<Vote[]> {
    if (run.sync && models.some((m) => syncMode(m) === 'never')) yield NEEDS_ASYNC;
    // B22: such a model may answer sync from state only its preload loads.
    if (run.sync && models.some((m) => syncMode(m) === 'after-preload') && !this.wasPreloaded(cacheId, run.scope)) yield NEEDS_ASYNC;

    if (algorithm === 'permit-overrides' || algorithm === 'first-applicable') {
      const votes: Vote[] = [];
      for (let i = 0; i < models.length; i++) {
        const started = this.start(models[i], contexts[i], request(), run, label);
        const [vote] = yield* resolve([(isThenable(started) ? yield started : started) as Vote]);
        votes.push(vote);
        if (!explain && decides(algorithm, vote)) break;
      }
      return votes;
    }

    const started: (Vote | PromiseLike<unknown>)[] = [];
    for (let i = 0; i < models.length; i++) {
      const s = this.start(models[i], contexts[i], request(), run, label);
      if (run.sync && isThenable(s)) yield s;
      started.push(s);
    }
    return yield* resolve(started.some(isThenable) ? ((yield Promise.all(started)) as Vote[]) : (started as Vote[]));
  }

  private wasPreloaded(cacheId: string, scope: Map<string, unknown>): boolean {
    if (scope.get(l1Key('preloaded', this.domain, cacheId)) === this.generation) return true;
    if (this.preloaded.get(cacheId) !== this.generation) return false;
    this.preloaded.delete(cacheId);
    this.preloaded.set(cacheId, this.generation);
    return true;
  }

  /**
   * B39 (design §5.6): a vote holding a scope.* ref that resolves missing (absent
   * attribute, unknown node, a type-level ref other than $global, a failed or
   * timed-out load) is indeterminate. Loads through the check's binder, so the
   * allow, fields and reasons reuse them; sync mode yields NEEDS_ASYNC before
   * any load.
   */
  private *resolveScopeRefs(votes: readonly Vote[], binder: RefBinder, label: string, loads: { degraded: boolean }): Pipeline<Vote[]> {
    const filtersOf = (v: Vote): ResourceFilter[] => [v.permitWhen, v.denyWhen, ...(v.denies ?? []).map((d) => d.when)];
    try {
      if ((yield* binder.cover(votes.filter((v) => v.error === undefined).flatMap(filtersOf))).degraded) loads.degraded = true;
    } catch (e) {
      // Nodes left unloaded make their refs missing below.
      loads.degraded = true;
      this.logAt('error', `${this.where}: loading the scope attributes of the votes of ${label} failed: ${describeError(e)}`);
    }
    return votes.map((v) => {
      if (v.error !== undefined) return v;
      let fault: string | undefined;
      try {
        const missing = binder.missingScopeRef(filtersOf(v));
        if (missing !== undefined) fault = `scope ref ${quote(missing)} resolves missing`;
      } catch (e) {
        fault = `reading its scope refs failed: ${describeError(e)}`;
      }
      if (fault === undefined) return v;
      this.logAt('error', `${this.where}: model ${quote(v.model)} is indeterminate for ${label}: ${fault}`);
      return faultVote(v.model, fault);
    });
  }

  /** A clean vote, or (async) a promise of one that never rejects, or (sync) the model's thenable. */
  private start(model: AuthorizationModel, ctx: ModelContext, request: DecisionRequest, run: Run, label: string): Vote | PromiseLike<unknown> {
    let raw: unknown;
    try {
      raw = model.evaluate(request, ctx);
    } catch (e) {
      return this.accept(model, ctx, { fault: `evaluate threw: ${describeError(e)}` }, label);
    }
    let pending: boolean;
    try {
      pending = isThenable(raw);
    } catch (e) {
      return this.accept(model, ctx, { fault: `evaluate returned an unreadable value: ${describeError(e)}` }, label);
    }
    if (!pending) return this.accept(model, ctx, { raw }, label);
    if (run.sync) return raw as PromiseLike<unknown>;
    return settleWithin(raw as PromiseLike<unknown>, this.config.modelTimeoutMs, describeError, 'evaluate').then((s) => this.accept(model, ctx, s.ok ? { raw: s.value } : { fault: s.error }, label));
  }

  /** Step 9: vote hygiene. */
  private accept(model: AuthorizationModel, ctx: ModelContext, result: { readonly raw: unknown } | { readonly fault: string }, label: string): Vote {
    let vote = 'fault' in result ? faultVote(model.name, result.fault) : sanitizeVote(result.raw, model.name, capabilitiesOf(model));
    if (vote.error === undefined && ctx.fault !== undefined) vote = faultVote(model.name, ctx.fault);
    if (vote.error !== undefined) this.logAt('error', `${this.where}: model ${quote(model.name)} is indeterminate for ${label}: ${vote.error}`);
    return vote;
  }

  /** Step 10. */
  private combine(algorithm: string, votes: readonly Vote[]): Combined {
    try {
      const combinator = this.combinators.get(algorithm);
      if (!combinator) throw new AuthzConfigError(`unknown algorithm ${quote(algorithm)}`);
      const result = combinator.combine(votes);
      if (isThenable(result)) {
        swallow(result);
        throw new AuthzConfigError('combine() must be synchronous, it returned a thenable');
      }
      const scale = votes.length * votes.length + 1;
      // first-applicable repeats every earlier vote's not(or(P, D)), so k votes expand to about k * (sum of votes).
      const allow = simplify(sanitizeFilter(result.allow, '*', 'combinator allow', budget(MAX_FILTER_NODES * scale), budget(MAX_DATA_VALUES * scale)));
      return algorithm === 'first-applicable' && result.deciding !== undefined ? { allow, deciding: result.deciding, failed: false } : { allow, failed: false };
    } catch (e) {
      this.logAt('error', `${this.where}: combinator ${quote(algorithm)} failed: ${describeError(e)}`);
      return { allow: FALSE, failed: true };
    }
  }

  /** Step 11's binder for one check, shared with the reason pass so both read the same refs and attributes. */
  private refBinder(parties: Parties, env: Readonly<Record<string, unknown>>, ancestors: readonly ResourceRef[] | undefined, run: Run): RefBinder {
    return new RefBinder({ principal: parties.principal, env }, parties.actor ?? parties.principal, ancestors, run.sync, (node) => this.boundAttributes(node, run.scope));
  }

  /** Step 11. A malformed node or a binder error gives FALSE (fail closed). */
  private *bind(allow: ResourceFilter, binder: RefBinder): Pipeline<{ readonly residual: ResourceFilter; readonly failed: boolean; readonly degraded: boolean; readonly uncacheable: boolean }> {
    try {
      const covered = yield* binder.cover([allow]);
      return { residual: binder.bind(allow), failed: covered.failed, degraded: covered.degraded, uncacheable: covered.uncacheable };
    } catch (e) {
      this.logAt('error', `${this.where}: binding refs failed: ${describeError(e)}`);
      return { residual: FALSE, failed: true, degraded: true, uncacheable: true };
    }
  }

  /**
   * A scope node's attributes for the binder, never waiting past modelTimeoutMs
   * (a model may already have given up on the memoised load). Either failure
   * leaves the node unknown; only a rejection is an engine fault.
   */
  private boundAttributes(node: ResourceRef, scope: Map<string, unknown>): Promise<BoundAttributes> {
    const load = this.nodeLoad(node, scope);
    return bounded(() => load.result, this.config.modelTimeoutMs).then((r): BoundAttributes => {
      if (r.kind === 'value') return { ...(r.value as LoadedAttributes), failed: false };
      if (r.kind === 'error') this.logAt('error', `${this.where}: scope attributes of ${resourceKey(node)} failed: ${describeError(r.error)}; its refs bind as missing`);
      else this.logTimeout(load, `${this.where}: scope attributes of ${resourceKey(node)} timed out after ${this.config.modelTimeoutMs} ms; its refs bind as missing`);
      return { attributes: null, failed: r.kind === 'error', degraded: true };
    });
  }

  private logTimeout(load: NodeLoad, message: string): void {
    if (load.timeoutLogged) return;
    load.timeoutLogged = true;
    this.logAt('error', message);
  }

  /** Throws AuthzConfigError for a malformed actor and for a chain deeper than the budget or with a cycle (B08). */
  private delegation(principal: Principal, actor: unknown, budget: number): Delegation {
    if (actor !== undefined && (!isObject(actor) || typeof actor.type !== 'string' || typeof actor.id !== 'string')) throw new AuthzConfigError(`${this.where}: actor must be a principal`);
    try {
      return resolveDelegation(principal, actor as Principal | undefined, budget);
    } catch (e) {
      if (e instanceof AuthzConfigError) throw new AuthzConfigError(`${this.where}: ${e.message}`, { cause: e });
      throw e;
    }
  }

  /** Who the models run with: under inherit the narrowed delegate (a frozen copy), else the request principal. */
  private parties(d: Delegation, requestPrincipal: Principal, requester: PrincipalRef): Parties {
    const ref = d.principal === requestPrincipal ? requester : principalRef(d.principal);
    const cacheId = principalCacheId(d.principal);
    if (d.actor === undefined) return { principal: d.principal, ref, cacheId };
    return { principal: d.principal, ref, cacheId, actor: d.actor, actorRef: d.actor === requestPrincipal ? requester : principalRef(d.actor) };
  }

  /** Every ceiling of the resolution (the request principal's and each inherit delegate's), from the validated copies. */
  private ceilingOf(d: Delegation, def: PermissionDef, ref: ResourceRef, ancestors: readonly ResourceRef[] | undefined, instant: Date): CeilingOutcome {
    return mergeCeilings(d.ceilings.map((c) => ceilingOutcome(c, def.name, ref, ancestors, instant)));
  }

  /** The intersect delegate's full decision: same permission, ref, subject, env and scope, with the hops left. */
  private *delegateCheck(delegate: Principal, hopsUsed: number, def: PermissionDef, ref: ResourceRef, subject: unknown, env: unknown, run: Run): Pipeline<Checked> {
    const input: { -readonly [K in keyof CheckInput]: CheckInput[K] } = { principal: delegate, permission: def.name };
    if (env !== undefined) input.env = env as Readonly<Record<string, unknown>>;
    return yield* this.pipeline(input, { ...run, depth: run.depth + 1, delegationBudget: run.delegationBudget - hopsUsed }, { ref, subject });
  }

  /**
   * Fields of an allowed decision, intersected with an intersect delegate's.
   * The votes' terms are bound like the allow; their refs may be gone from the
   * simplified allow, so their scope nodes are loaded first. `failed`: an
   * AuthzConfigError (glob budget, binder), which denies with model_error.
   * A degraded or failed load leaves its refs missing: the decision stands
   * but is faulted and not cached. `firm` (firm runs) also gives `firm`,
   * intersected with the delegate's firm fields.
   */
  private *fieldsOf(algorithm: string, votes: readonly Vote[], binder: RefBinder, delegate: Fields | undefined, label: string, firm?: { readonly delegate?: Fields }): Pipeline<{ readonly fields: Fields; readonly firm?: Fields; readonly failed: boolean; readonly faulted: boolean; readonly uncacheable: boolean }> {
    let uncacheable: boolean;
    let faulted: boolean;
    try {
      const covered = yield* binder.cover(votes.filter((v) => v.error === undefined).flatMap((v) => [v.permitWhen, v.denyWhen]));
      uncacheable = covered.uncacheable;
      faulted = covered.degraded;
    } catch (e) {
      // Refs of nodes left unloaded bind as missing: fewer fields, more hidden.
      this.logAt('error', `${this.where}: loading the scope attributes of the field sets of ${label} failed: ${describeError(e)}`);
      uncacheable = true;
      faulted = true;
    }
    try {
      const own = this.fieldCombiner.combine(algorithm, votes, (f) => binder.bind(f));
      const fields = delegate ? this.fieldCombiner.intersect(own, delegate) : own;
      if (!firm) return { fields, failed: false, faulted, uncacheable };
      const firmOwn = this.fieldCombiner.combine(algorithm, votes, (f) => binder.bind(f), true);
      return { fields, firm: firm.delegate ? this.fieldCombiner.intersect(firmOwn, firm.delegate) : firmOwn, failed: false, faulted, uncacheable };
    } catch (e) {
      if (!(e instanceof AuthzConfigError)) throw e;
      this.logAt('error', `${this.where}: combining the field sets of ${label} failed: ${describeError(e)}`);
      return { fields: NO_FIELDS, failed: true, faulted: true, uncacheable: true };
    }
  }

  /** `subjectEvaluated`: the subject itself denied (only then `residual_false`, B36). */
  private denyReason(core: readonly DenyReason[], votes: readonly Vote[], truths: readonly VoteTruths[], deciding: Vote | undefined, algorithm: string, subjectEvaluated: boolean, engineFault: boolean): DenyReason {
    return selectDenyReason({ core: engineFault ? [...core, ENGINE_FAULT] : core, votes, truths, algorithm, deciding, subjectEvaluated });
  }

  /**
   * Truths of the counted votes against the subject, the loads and the batch
   * under one time limit; static truths for the others and on timeout. Not
   * traced as subject checks: one core 'reason' step holds the result.
   */
  private *subjectTruths(votes: readonly Vote[], deciding: Vote | undefined, algorithm: string, subject: unknown, binder: RefBinder, parties: Parties, ref: ResourceRef, run: Run, label: string, core: (step: string, note: string, data?: unknown) => void, cores: ModelContext[]): Pipeline<{ readonly truths: readonly VoteTruths[]; readonly uncacheable: boolean }> {
    const started = performance.now();
    const counted: readonly Vote[] = algorithm === 'first-applicable' && deciding !== undefined ? [deciding] : votes;
    const subjectEnv = this.subjectEnv(parties, ref, run, undefined, cores);
    let uncacheable: boolean;
    try {
      // Deny entries may read scope nodes the allow did not.
      uncacheable = (yield* binder.cover(counted.filter((v) => v.error === undefined).flatMap((v) => [v.permitWhen, ...(v.denies ?? []).map((d) => d.when)]))).uncacheable;
    } catch (e) {
      // Refs of nodes left unloaded bind as missing.
      this.logAt('error', `${this.where}: loading the scope attributes of the deny reasons of ${label} failed: ${describeError(e)}`);
      uncacheable = true;
    }
    // A deny entry sits under `not` in the allow, where the binder reads a missing ref as TRUE: it is bound under `not` here too.
    const truthOf = (f: ResourceFilter, deny: boolean): Promise<Truth> => {
      let bound: ResourceFilter;
      try {
        bound = binder.bind(deny ? not(f) : f);
      } catch {
        uncacheable = true;
        return Promise.resolve(undefined);
      }
      const truth = evaluateResidual(bound, subject, subjectEnv);
      return deny ? truth.then((t) => (t === undefined ? undefined : !t)) : truth;
    };
    const batch = Promise.all(
      votes.map((v): VoteTruths | Promise<VoteTruths> => {
        if (!counted.includes(v) || v.error !== undefined) return staticTruths(v);
        // Against the subject, a permit that is not TRUE does not permit, whether or not the subject step denied.
        return Promise.all([truthOf(v.permitWhen, false), Promise.all((v.denies ?? []).map((d) => truthOf(d.when, true)))]).then(([permit, denies]) => Object.freeze({ permit: permit === true, denies: Object.freeze(denies) }));
      }),
    );
    const left = Math.max(0, this.config.modelTimeoutMs - (performance.now() - started));
    const settled = (yield settleWithin(batch, left, describeError, 'deny reason pass')) as Settled;
    if (!settled.ok) {
      this.logAt('error', `${this.where}: evaluating the deny reasons of ${label} against the subject failed: ${settled.error}; using static truths`);
      core('reason', 'deny reason against the subject', { fallback: 'static' });
      return { truths: votes.map(staticTruths), uncacheable };
    }
    const truths = settled.value as readonly VoteTruths[];
    const traced = counted.map((v) => {
      const i = votes.indexOf(v);
      return v.error !== undefined || i < 0 ? { model: v.model, indeterminate: true } : { model: v.model, permit: truths[i].permit, denies: truths[i].denies };
    });
    core('reason', 'deny reason against the subject', { truths: traced });
    return { truths, uncacheable };
  }

  // SYSTEM and UNATTENDED are recognised by identity only (B09, design §10.3).
  private principalGate(p: unknown): Gate {
    if (p === SYSTEM) return { kind: 'system' };
    const unattended = (principal: PrincipalRef): Gate => ({ kind: 'deny', principal, reason: { code: 'unattended' } });
    let type: unknown;
    let id: unknown;
    try {
      if (!isObject(p)) return unattended(UNATTENDED_REF);
      // Read once: a getter must not pass the gate as one type and reach the decision as another.
      type = p.type;
      id = p.id;
    } catch {
      return unattended(UNATTENDED_REF);
    }
    if (typeof type !== 'string' || typeof id !== 'string') return unattended(UNATTENDED_REF);
    const ref: PrincipalRef = Object.freeze({ type, id });
    if ((p as unknown) === UNATTENDED || type === 'system' || type === 'unattended') return unattended(ref);
    return { kind: 'run', principal: p as unknown as Principal, ref };
  }

  private coreDenial(principal: PrincipalRef, reason: DenyReason): Outcome {
    return { principal, residual: FALSE, reason: Object.freeze({ ...reason }), roles: NO_ROLES, fields: NO_FIELDS, models: [], votes: [] };
  }

  /** A core denial after delegation, with the same principal and actor refs as a decision of the models. */
  private partiesDenial(parties: Parties, reason: DenyReason): Outcome {
    const denial = this.coreDenial(parties.ref, reason);
    return parties.actorRef ? { ...denial, actor: parties.actorRef } : denial;
  }

  /** Steps 13-15. */
  private finish(f: Finish, o: Outcome): Decision {
    const allowed = o.residual.op !== 'false';
    const decision: { -readonly [K in keyof Decision]: Decision[K] } = { allowed, permission: f.def.name, resource: f.ref, principal: o.principal, residual: o.residual, fields: o.fields, roles: o.roles, domain: this.domain };
    if (o.actor) decision.actor = o.actor;
    if (!allowed) decision.reason = o.reason ?? { code: 'no_access' };
    if (o.validUntil) decision.validUntil = o.validUntil;

    let trace: Trace | undefined;
    if (f.steps) {
      trace = deepFreeze({ domain: this.domain, algorithm: f.algorithm as CombiningAlgorithm, models: [...o.models], votes: [...o.votes], steps: [...f.steps], durationMs: performance.now() - f.started });
      if (f.explain) decision.trace = trace;
      if (this.config.explain) this.logAt('debug', `${this.where}: trace of ${f.def.name} on ${resourceKey(f.ref)}`, trace);
    }
    deepFreeze(decision);

    if (audits(f.run)) {
      const base = { principal: f.requester, permission: f.def.name, resource: f.ref };
      if (f.system) this.record({ kind: 'system', ...base });
      if (!allowed && this.config.auditDenials) this.record({ kind: 'deny', ...base, reason: decision.reason!.code });
      if (f.explain) this.record(allowed ? { kind: 'explain', ...base, trace } : { kind: 'explain', ...base, reason: decision.reason!.code, trace });
    }
    return decision;
  }

  private record(entry: Parameters<DecisionAudit['record']>[0]): void {
    if (!this.auditSink) return;
    const failed = (e: unknown) => this.logAt('error', `${this.where}: audit failed for a ${entry.kind} entry: ${describeError(e)}`);
    try {
      const r = this.auditSink.record(entry);
      if (isThenable(r)) r.then(undefined, failed);
    } catch (e) {
      failed(e);
    }
  }

  // ---- context services ----

  private request(parties: Parties, def: PermissionDef, ref: ResourceRef, subject: unknown, env: unknown, instant: Date, explain: boolean): DecisionRequest {
    const req: { -readonly [K in keyof DecisionRequest]: DecisionRequest[K] } = { principal: parties.principal, permission: def.name, resource: ref, env: this.envOf(env, instant), explain };
    if (parties.actor) req.actor = parties.actor;
    if (subject !== undefined) req.subject = subject;
    return Object.freeze(req);
  }

  /** A fresh frozen env per use; `now` from the clock always wins. */
  private envOf(env: unknown, instant: Date): Readonly<Record<string, unknown>> {
    if (env !== undefined && (!isObject(env) || Array.isArray(env))) throw new AuthzConfigError(`${this.where}: env must be an object`);
    return Object.freeze({ ...env, now: new Date(instant.getTime()) });
  }

  /** `cores` gets the env's context. */
  private subjectEnv(parties: Parties, ref: ResourceRef, run: Run, steps: TraceStep[] | undefined, cores: ModelContext[]): SubjectEnv {
    const adapter = this.adapterByType.get(ref.type);
    const attribute = adapter && typeof adapter.attribute === 'function' ? (subject: unknown, field: string) => adapter.attribute!(subject, field) : defaultAttribute;
    const ctx = new ModelContext(this.hostFor(run), CORE, run.scope, run.instant, run.depth, steps, contextCacheKey('\u0000core', parties.cacheId));
    cores.push(ctx);
    return {
      principal: parties.principal,
      ref,
      attribute,
      relation: (type, name) => this.relation(type, name),
      ancestors: (r) => Promise.resolve(this.ancestorsOf(this.requireRef(r), run.scope)),
      native: (op) => {
        const filter = this.natives.get(op);
        return filter && detachingOnThrow(filter, ctx);
      },
      ctx,
    };
  }

  private relation(type: ResourceType, name: string): RelationResolver | undefined {
    return this.relationIndex.get(`${type}\u0000${name}`);
  }

  /** Step 5 and ctx.ancestors: memoised in L1; sync for refs that need no IO. */
  private ancestorsOf(ref: ResourceRef, scope: Map<string, unknown>): MaybePromise<readonly ResourceRef[] | null> {
    return memo(scope, l1Key('ancestors', this.domain, resourceKey(ref)), () => this.loadAncestors(ref));
  }

  private loadAncestors(ref: ResourceRef): MaybePromise<readonly ResourceRef[] | null> {
    if (ref.type === GLOBAL_TYPE && ref.id === undefined) return GLOBAL_ANCESTORS;
    if (ref.id === undefined) return Object.freeze([ref, GLOBAL]);
    const adapter = this.adapterByType.get(ref.type);
    // An ancestor or scope node a model reads, not only the checked ref, may be of a late type.
    if (!adapter) this.refuseLateType(ref.type);
    const source = adapter ?? this.resolverByType.get(ref.type);
    if (!source) return Object.freeze([ref, GLOBAL]);
    const raw = source.ancestors(ref);
    return isThenable(raw) ? Promise.resolve(raw).then((list) => this.ancestorList(list, ref)) : this.ancestorList(raw, ref);
  }

  private ancestorList(list: unknown, ref: ResourceRef): readonly ResourceRef[] | null {
    if (list === null) return null;
    const out = Array.isArray(list) ? Array.from(list, (r: unknown) => copyRef(r)) : undefined;
    if (!out || out.some((r) => r === undefined)) throw new AuthzConfigError(`${this.where}: ancestors of ${resourceKey(ref)} must be a list of refs or null`);
    return Object.freeze(out as ResourceRef[]);
  }

  private attributesOf(ref: ResourceRef, scope: Map<string, unknown>): Promise<Attributes> {
    return this.nodeLoad(ref, scope).result.then((l) => l.attributes);
  }

  private nodeLoad(ref: ResourceRef, scope: Map<string, unknown>): NodeLoad {
    return memo(scope, l1Key('attributes', this.domain, resourceKey(ref)), () => {
      const load = { ref, timeoutLogged: false, degraded: false } as { -readonly [K in keyof NodeLoad]: NodeLoad[K] };
      // The flag is set before any awaiting model resumes, so a vote built on a degraded load is never stored.
      load.result = this.loadAttributes(ref, load).then(
        (l) => {
          if (l.degraded) load.degraded = true;
          return l;
        },
        (e: unknown) => {
          load.degraded = true;
          throw e;
        },
      );
      swallow(load.result);
      this.loads(scope).push(load);
      return load;
    });
  }

  /**
   * Schema defaults ⊕ the adapter's (else the resolver's) attributes ⊕ the
   * store row, deeply frozen. Errors propagate, so the asking model is
   * indeterminate; a null answer or a load past modelTimeoutMs gives null
   * (unknown node).
   */
  private async loadAttributes(ref: ResourceRef, load: NodeLoad): Promise<LoadedAttributes> {
    const adapter = this.adapterByType.get(ref.type);
    const resolver = this.resolverByType.get(ref.type);
    if (!adapter) this.refuseLateType(ref.type);
    let own: unknown = {};
    if (adapter && typeof adapter.scopeAttributes === 'function') own = await this.attributeLoad(ref, load, `adapter ${quote(adapter.kind)}`, () => adapter.scopeAttributes!(ref));
    else if (resolver && typeof resolver.attributes === 'function') own = await this.attributeLoad(ref, load, 'the scope resolver', () => resolver.attributes!(ref));
    if (own === TIMED_OUT) return { attributes: null, degraded: true };
    if (own === null) return { attributes: null, degraded: false };
    const layers: unknown[] = [this.attributeDefaults.get(ref.type) ?? {}, own];
    const store = this.attributeStore;
    if (store) {
      const row = await this.attributeLoad(ref, load, 'the scope attribute store', () => store.get(ref));
      if (row === TIMED_OUT) return { attributes: null, degraded: true };
      layers.push(row);
    }
    try {
      return { attributes: mergeAttributes(layers), degraded: false };
    } catch (e) {
      throw new AuthzConfigError(`${this.where}: scope attributes of ${resourceKey(ref)}: ${describeError(e)}`, { cause: e });
    }
  }

  private async attributeLoad(ref: ResourceRef, node: NodeLoad, source: string, load: () => unknown): Promise<unknown> {
    const r = await bounded(load, this.config.modelTimeoutMs);
    if (r.kind === 'error') throw r.error;
    if (r.kind === 'value') return r.value;
    this.logTimeout(node, `${this.where}: scope attributes of ${resourceKey(ref)} from ${source} timed out after ${this.config.modelTimeoutMs} ms; the node is unknown`);
    return TIMED_OUT;
  }

  /**
   * Adapters such as authz-orm's list their types live, but the constructor
   * indexed them once: a type listed only now has no adapter here (no load,
   * ancestors or attributes), so every use of it throws until a reboot.
   */
  private refuseLateType(type: ResourceType): void {
    const adapter = this.lateType(type);
    if (adapter) throw this.lateTypeError(type, adapter, AuthzConfigError);
  }

  /** An unknown permission that a late type's adapter lists now throws the late-type error instead. */
  private requirePermission(name: Permission): PermissionDef {
    try {
      return this.registry.require(name);
    } catch (e) {
      if (!(e instanceof UnknownPermission)) throw e;
      for (const adapter of this.adapterList) {
        let types: unknown;
        try {
          const listed: unknown = typeof adapter.permissions === 'function' ? adapter.permissions() : undefined;
          const def: unknown = Array.isArray(listed) ? listed.find((d: unknown) => isObject(d) && d.name === name) : undefined;
          types = isObject(def) ? def.types : undefined;
        } catch {
          continue;
        }
        if (!Array.isArray(types)) continue;
        for (const type of types) {
          const late = typeof type === 'string' ? this.lateType(type) : undefined;
          if (late) throw this.lateTypeError(type as ResourceType, late, UnknownPermission);
        }
      }
      throw e;
    }
  }

  /** The adapter whose live `types` lists `type` although the constructor did not index it; an adapter whose types cannot be read is passed over. */
  private lateType(type: ResourceType): ResourceAdapter | undefined {
    if (type === GLOBAL_TYPE || this.adapterByType.has(type)) return undefined;
    for (const adapter of this.adapterList) {
      try {
        const types: unknown = adapter.types;
        if (Array.isArray(types) && types.includes(type)) return adapter;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private lateTypeError(type: ResourceType, adapter: ResourceAdapter, kind: typeof AuthzConfigError): AuthzConfigError {
    let name: unknown;
    try {
      name = adapter.kind;
    } catch {
      name = '<unreadable>';
    }
    return new kind(`${this.where}: resource type ${quote(type)} was registered with adapter ${quote(name)} after the domain booted; register it before boot, or boot the domain again`);
  }

  private requireRef(v: unknown): ResourceRef {
    const ref = copyRef(v);
    if (!ref) throw new AuthzConfigError(`${this.where}: expected a ResourceRef`);
    return ref;
  }

  // ---- plumbing ----

  private newRun(sync: boolean, scope: RequestScope | undefined): Run {
    return this.topRun(sync, scopeMap(scope), this.now(), 0);
  }

  /** A run that starts a call tree; epoch() first, so a fresh scope is born with the generation after a version change. */
  private topRun(sync: boolean, scope: Map<string, unknown>, instant: Date, depth: number): Run {
    const versions = this.epoch();
    return { sync, scope, instant, depth, delegationBudget: this.config.maxDelegation, versions, generation: this.bornOf(scope), nested: newNested(), bypass: false };
  }

  private now(): Date {
    const now = validDate(this.clock());
    if (!now) throw new AuthzConfigError(`${this.where}: the clock returned an invalid date`);
    return now;
  }

  private logAt(level: keyof EngineLog, message: string, ...args: unknown[]): void {
    try {
      this.log[level](message, ...args);
    } catch {
      // a broken logger must not change a decision
    }
  }

  private readConfig(c: NonNullable<AuthorizerOptions['config']>): EngineConfig {
    const number = (name: string, v: unknown, dflt: number, min: 'positive' | 'non-negative'): number => {
      if (v === undefined) return dflt;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (min === 'positive' && v === 0)) throw new AuthzConfigError(`${this.where}: config.${name} must be a ${min} number, got ${quote(v)}`);
      return v;
    };
    const flag = (name: string, v: unknown, dflt: boolean): boolean => {
      if (v === undefined) return dflt;
      if (typeof v !== 'boolean') throw new AuthzConfigError(`${this.where}: config.${name} must be a boolean`);
      return v;
    };
    const neverRead = c.neverRead ?? ['Password'];
    if (!Array.isArray(neverRead) || neverRead.some((x) => typeof x !== 'string')) throw new AuthzConfigError(`${this.where}: config.neverRead must be a list of field globs`);
    const maxDelegation = c.maxDelegation ?? 2;
    if (typeof maxDelegation !== 'number' || !Number.isInteger(maxDelegation) || maxDelegation < 0) throw new AuthzConfigError(`${this.where}: config.maxDelegation must be an integer >= 0`);
    return Object.freeze({
      modelTimeoutMs: number('modelTimeoutMs', c.modelTimeoutMs, 2000, 'positive'),
      maxDelegation,
      neverRead: Object.freeze([...neverRead]),
      explain: flag('explain', c.explain, false),
      cacheTtlSeconds: number('cacheTtlSeconds', c.cacheTtlSeconds, 60, 'non-negative'),
      auditDenials: flag('auditDenials', c.auditDenials, true),
    });
  }
}

const scopeMap = (scope: RequestScope | undefined): Map<string, unknown> => (scope?.cache instanceof Map ? scope.cache : new Map());

const newNested = (): Nested => ({ uncacheable: false, untagged: false, faulted: false, tags: new Set() });

const THREW: unique symbol = Symbol('threw');
const EXPIRED: unique symbol = Symbol('expired');

/** One time limit for a whole summary() or covers() call; clear() it when the call ends. */
class Deadline {
  expired = false;
  private readonly reached: Promise<typeof EXPIRED>;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly ms: number) {
    this.reached = new Promise((resolve) => {
      this.timer = setTimeout(() => {
        this.expired = true;
        resolve(EXPIRED);
      }, ms);
    });
  }

  /** EXPIRED when the limit comes first; `work` is left running. */
  race<T>(work: Promise<T>): Promise<T | typeof EXPIRED> {
    if (!this.expired) return Promise.race([work, this.reached]);
    swallow(work);
    return Promise.resolve(EXPIRED);
  }

  clear(): void {
    clearTimeout(this.timer);
  }
}

/** Only a top-level check outside summary/covers is an access attempt. */
const audits = (run: Run): boolean => run.depth === 0 && run.quiet !== true;

/** undefined tags: no invalidate can reach a decision above this one in the L2, so it stays in the L1 (which the generation guards). */
function nest(run: Run, tags: readonly string[] | undefined): void {
  if (tags === undefined) run.nested.untagged = true;
  else for (const t of tags) run.nested.tags.add(t);
}

function once<T>(f: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = f();
      done = true;
    }
    return value;
  };
}

const principalRef = (p: PrincipalRef): PrincipalRef => Object.freeze({ type: p.type, id: p.id });

const principalObjects = new WeakMap<object, number>();
let nextPrincipalObject = 0;

/**
 * ctx.cache is per model and per full state of the principal the
 * models run with, not per type:id: a narrowed inherit copy differs from its
 * delegate only in ceiling.roles. A principal with no canonical state gets a
 * key of its own object.
 */
function principalCacheId(p: Principal): string {
  const state = principalState(p);
  if (state !== undefined) return `state:${state}`;
  let n = principalObjects.get(p);
  if (n === undefined) {
    n = nextPrincipalObject++;
    principalObjects.set(p, n);
  }
  return `object:${n}`;
}

/** The subject evaluator reads a native filter's throw as UNKNOWN, not a fault, so nothing else drops what it memoised before throwing. */
function detachingOnThrow(filter: NativeFilter, ctx: ModelContext): NativeFilter {
  const detach = (e: unknown): never => {
    ctx.detachMemo();
    throw e;
  };
  return {
    op: filter.op,
    matches: (args, subject, ref, c) => {
      let out: boolean | Promise<boolean>;
      try {
        out = filter.matches(args, subject, ref, c);
      } catch (e) {
        return detach(e);
      }
      return Promise.resolve(out).catch(detach);
    },
  };
}

/** `hook`: a model hook with a memo of its own (summarize), apart from the votes' one. */
const contextCacheKey = (owner: string, cacheId: string, hook?: string): string => JSON.stringify(hook === undefined ? [cacheId, owner] : [cacheId, owner, hook]);

/** Exactly `{ type, id? }` as own data properties; `id: null` = no id. */
function refShaped(v: object): ResourceRef | undefined {
  if (Reflect.ownKeys(v).some((k) => k !== 'type' && k !== 'id')) return undefined;
  const type = Object.getOwnPropertyDescriptor(v, 'type');
  if (!type || !('value' in type) || typeof type.value !== 'string' || type.value === '') return undefined;
  const id = Object.getOwnPropertyDescriptor(v, 'id');
  if (id === undefined || ('value' in id && id.value === null)) return Object.freeze({ type: type.value });
  return 'value' in id && typeof id.value === 'string' ? Object.freeze({ type: type.value, id: id.value }) : undefined;
}

function capabilitiesOf(model: AuthorizationModel): { readonly effects?: unknown; readonly residuals?: unknown } {
  try {
    const caps: unknown = model.capabilities;
    return isObject(caps) ? { effects: caps.effects, residuals: caps.residuals } : {};
  } catch {
    return {};
  }
}

function syncMode(model: AuthorizationModel): unknown {
  try {
    return model.capabilities.sync;
  } catch {
    return 'never';
  }
}

// Skipping drops a model's denies too, so only a well-formed principalTypes list that lacks the type skips.
function admits(model: AuthorizationModel, principal: Principal): boolean {
  try {
    const types: unknown = model.capabilities.principalTypes;
    return !Array.isArray(types) || types.includes(principal.type);
  } catch {
    return true;
  }
}

function decides(algorithm: string, vote: Vote): boolean {
  const v = normalizeVote(vote);
  return (algorithm === 'permit-overrides' ? and(v.permitWhen, not(v.denyWhen)) : or(v.permitWhen, v.denyWhen)).op === 'true';
}

const TIMED_OUT: unique symbol = Symbol('timed out');

type Bounded = { readonly kind: 'value'; readonly value: unknown } | { readonly kind: 'error'; readonly error: unknown } | { readonly kind: 'timeout' };

/** `settleWithin` that keeps a rejection (with its error) apart from a timeout. Never rejects. */
function bounded(load: () => unknown, ms: number): Promise<Bounded> {
  const outcome = Promise.resolve()
    .then(load)
    .then(
      (value): Bounded => ({ kind: 'value', value }),
      (error): Bounded => ({ kind: 'error', error }),
    );
  return settleWithin(outcome, ms, describeError, 'scope attribute load').then((s): Bounded => (s.ok ? (s.value as Bounded) : { kind: 'timeout' }));
}

/**
 * Step 11 for one check: `bindRefs`, then actor.* and scope.* refs. `cover`
 * loads the scope nodes the refs of some filters need (each type once);
 * `bind` is sync, and a scope ref of a type no `cover` loaded binds as
 * missing, so every ref is gone either way.
 */
class RefBinder {
  private readonly attributes = new Map<string, Attributes>();

  constructor(
    private readonly scope: { readonly principal: Principal; readonly env: Readonly<Record<string, unknown>> },
    private readonly actor: Principal,
    /** undefined for a ref without id: only $global resolves then. */
    private readonly ancestors: readonly ResourceRef[] | undefined,
    private readonly sync: boolean,
    private readonly load: (node: ResourceRef) => Promise<BoundAttributes>,
  ) {}

  /** `uncacheable`: a filter read a ref the L2 key does not hold (refs read before `bindRefs`, which replaces principal.* and env.*), or a load it needed was degraded. */
  *cover(filters: readonly ResourceFilter[]): Pipeline<{ readonly failed: boolean; readonly degraded: boolean; readonly uncacheable: boolean }> {
    let uncacheable = false;
    const refs = new Set<string>();
    for (const f of filters) {
      if (!collectRefs(f).every(cacheSafeRef)) uncacheable = true;
      for (const r of collectRefs(bindRefs(f, this.scope))) refs.add(r);
    }
    const nodes = [...scopeNodes([...refs], { ancestors: this.ancestors })].filter(([type]) => !this.attributes.has(type));
    if (nodes.length === 0) return { failed: false, degraded: false, uncacheable };
    if (this.sync) yield NEEDS_ASYNC;
    const loaded = (yield Promise.all(nodes.map(([, node]) => this.load(node)))) as readonly BoundAttributes[];
    nodes.forEach(([type], i) => this.attributes.set(type, loaded[i].attributes));
    const degraded = loaded.some((l) => l.degraded);
    return { failed: loaded.some((l) => l.failed), degraded, uncacheable: uncacheable || degraded };
  }

  bind(f: ResourceFilter): ResourceFilter {
    const pre = bindRefs(f, this.scope);
    return bindEngineRefs(pre, refValues(collectRefs(pre), this.actor, this.attributes));
  }

  /** The first scope.* ref of `filters` without a value from the nodes `cover` loaded. */
  missingScopeRef(filters: readonly ResourceFilter[]): string | undefined {
    for (const f of filters) {
      const refs = collectRefs(bindRefs(f, this.scope)).filter((r) => r.startsWith('scope.'));
      const values = refValues(refs, this.actor, this.attributes);
      const missing = refs.find((r) => !values.has(r));
      if (missing !== undefined) return missing;
    }
    return undefined;
  }
}

function mergeRoles(votes: readonly Vote[]): Readonly<Record<string, string>> {
  const merged: Record<string, string> = {};
  for (const vote of votes.filter((v) => v.error === undefined && v.roles !== undefined).sort(byName)) {
    for (const [ladder, role] of Object.entries(vote.roles!)) {
      if (!Object.hasOwn(merged, ladder)) Object.defineProperty(merged, ladder, { value: role, enumerable: true, writable: true, configurable: true });
    }
  }
  return Object.freeze(merged);
}

/** Freezing does not stop setTime: the store and every cache hit get their own validUntil, so no caller can move another's. */
function withOwnDate(d: Decision): Decision {
  const until = validDate(d.validUntil);
  return until === undefined ? d : Object.freeze({ ...d, validUntil: until });
}

function earliest(dates: readonly (Date | undefined)[]): Date | undefined {
  let best: Date | undefined;
  for (const d of dates) {
    const valid = validDate(d);
    if (valid && (best === undefined || valid.getTime() < best.getTime())) best = valid;
  }
  return best;
}

function summaryEntry(def: PermissionDef, conditional: boolean, fields: Fields): AccessSummary['permissions'][number] {
  return def.fields === true ? { name: def.name, conditional, fields: { read: [...fields.read], write: [...fields.write] } } : { name: def.name, conditional };
}

type SummaryItem = ModelSummary['permissions'][number];

/**
 * A summary entry under its principal's ceilings, judged at GLOBAL and
 * `instant`: dropped (undefined) when a ceiling's permissions, expiry or
 * empty resources rule it out, or the ceiling is malformed; conditional
 * when a ceiling's resources lie below GLOBAL.
 */
function underCeilings(ceilings: readonly unknown[], entry: SummaryItem, instant: Date): SummaryItem | undefined {
  let conditional = entry.conditional;
  for (const raw of ceilings) {
    const read = readCeiling(raw);
    if (!read.ok) return undefined;
    if (read.ceiling === undefined) continue;
    const { resources, ...rest } = read.ceiling;
    if (ceilingOutcome(rest, entry.name, GLOBAL, undefined, instant).denials.length > 0) return undefined;
    if (resources === undefined) continue;
    if (resources.length === 0) return undefined;
    if (!resources.some((r) => scopeCovers(r, GLOBAL))) conditional = true;
  }
  return conditional === entry.conditional ? entry : { ...entry, conditional };
}

/** The refs covers compares a permission on: at `$global`, also each of its types, whose type-level check stands for every row (B06). */
function comparedRefs(def: PermissionDef, ref: ResourceRef): readonly ResourceRef[] {
  return ref.type === GLOBAL_TYPE ? [ref, ...def.types.map((type) => Object.freeze({ type }))] : [ref];
}

/** A validated copy; a malformed ceiling (every check denies then) is left out. */
function summaryCeiling(p: Principal): Ceiling | undefined {
  let raw: unknown;
  try {
    raw = p.ceiling;
  } catch {
    return undefined;
  }
  const read = readCeiling(raw);
  return read.ok ? read.ceiling : undefined;
}

/** A frozen engine copy of a model's summary, stamped with the model's name; throws when malformed or over the data budget. */
function copySummary(raw: unknown, model: string): ModelSummary {
  const data = copyData(raw, true);
  if (!isObject(data) || !Array.isArray(data.permissions)) throw new Error('the summary has no permissions list');
  const permissions = data.permissions.map((p: unknown, i): ModelSummary['permissions'][number] => {
    if (!isObject(p) || typeof p.name !== 'string' || typeof p.conditional !== 'boolean') throw new Error(`permissions[${i}] is not { name, conditional }`);
    if (p.fields === undefined) return { name: p.name, conditional: p.conditional };
    const given = p.fields;
    if (!isObject(given)) throw new Error(`permissions[${i}].fields is not a field set`);
    // Rebuilt: anything else a model puts there would reach the access summary (B25).
    const fields: { -readonly [K in keyof FieldSet]: FieldSet[K] } = {};
    for (const k of ['read', 'write', 'hide'] as const) {
      const globs = given[k];
      if (globs === undefined) continue;
      if (!isStrings(globs)) throw new Error(`permissions[${i}].fields is not a field set`);
      fields[k] = globs as string[];
    }
    return { name: p.name, conditional: p.conditional, fields };
  });
  const out: { -readonly [K in keyof ModelSummary]: ModelSummary[K] } = { model, permissions };
  if (data.roles !== undefined) {
    if (!Array.isArray(data.roles)) throw new Error('roles is not a list');
    out.roles = data.roles.map((r: unknown, i) => {
      const scope = isObject(r) ? copyRef(r.scope) : undefined;
      if (!isObject(r) || typeof r.role !== 'string' || !scope || (r.expiresAt !== undefined && typeof r.expiresAt !== 'string')) throw new Error(`roles[${i}] is not { role, scope, expiresAt? }`);
      return r.expiresAt === undefined ? { role: r.role, scope } : { role: r.role, scope, expiresAt: r.expiresAt };
    });
  }
  return deepFreeze(out);
}

const isStrings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');

// Residuals are engine copies within the vote budgets; past this a walk fails closed (no cover).
const COMPARE_NODES = 100_000;
const COMPARE_DEPTH = 256;

/**
 * `big` covers `small`: nothing to cover, or `big` is unconditional or the
 * same tree without a relation or native node (those mean the current
 * principal, so equal trees still differ), and `small`'s fields are inside
 * `bigFields` (by default `big`'s). Throws AuthzConfigError when the field
 * budget runs out.
 */
function entryCovers(big: Decision, small: Decision, bigFields: Fields = big.fields): boolean {
  if (!small.allowed) return true;
  if (!big.allowed) return false;
  if (big.residual.op !== 'true' && (readsPrincipal(big.residual, 0, { left: COMPARE_NODES }) || !sameTree(big.residual, small.residual, 0, { left: COMPARE_NODES }))) return false;
  return subtractFieldGlobs(small.fields.read, bigFields.read).length === 0 && subtractFieldGlobs(small.fields.write, bigFields.write).length === 0;
}

/** A holder check of covers; none recorded (not a firm run) counts as no field. */
function firmFieldsOf(holder: Checked): Fields {
  return holder.firmFields ?? NO_FIELDS;
}

function readsPrincipal(f: unknown, depth: number, nodes: { left: number }): boolean {
  if (--nodes.left < 0 || depth > COMPARE_DEPTH || !isObject(f)) return true;
  const op = f.op;
  if (op === 'relation' || (typeof op === 'string' && op.startsWith('native:'))) return true;
  if (op === 'and' || op === 'or') return !Array.isArray(f.args) || f.args.some((x) => readsPrincipal(x, depth + 1, nodes));
  if (op === 'not') return readsPrincipal(f.arg, depth + 1, nodes);
  return false;
}

function sameTree(a: unknown, b: unknown, depth: number, nodes: { left: number }): boolean {
  if (--nodes.left < 0 || depth > COMPARE_DEPTH) return false;
  if (a === b) return true;
  if (!isObject(a) || !isObject(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.hasOwn(b, k) && sameTree(a[k], b[k], depth + 1, nodes));
}
