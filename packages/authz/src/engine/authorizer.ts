import { AuthzConfigError } from '../contracts/errors.js';
import { FALSE, TRUE, and, bindRefs, not, or, simplify } from '../contracts/filter.js';
import type { ResourceFilter } from '../contracts/filter.js';
import type { CombiningAlgorithm, Decision, DecisionRequest, DenyReason, Trace, TraceStep, Vote } from '../contracts/decision.js';
import type { AuthorizationModel, Combinator, NativeFilter } from '../contracts/model.js';
import type { Permission, PermissionDef, PermissionRegistry } from '../contracts/permission.js';
import { SYSTEM, UNATTENDED, principalKey } from '../contracts/principal.js';
import type { Principal, PrincipalRef, ResourceRef, ResourceType } from '../contracts/principal.js';
import { GLOBAL, resourceKey } from '../contracts/resource.js';
import type { RelationResolver, ResourceAdapter, ScopeAttributeSchema, ScopeAttributeStore, ScopeResolver } from '../contracts/adapter.js';
import type { AccessSummary, CheckInput, DecisionAudit, DecisionCache } from '../contracts/service.js';
import { subtractFieldGlobs } from '../contracts/fields.js';
import type { ConditionCompiler } from '../conditions/contracts.js';
import { BUILTIN_COMBINATORS, normalizeVote } from './combinators.js';
import { DEFAULT_COMBINE, compileRoutes } from './routes.js';
import type { CombineConfig, RouteTable } from './routes.js';
import { defaultAttribute, evaluateResidual } from './evaluate.js';
import type { SubjectEnv, Truth } from './evaluate.js';
import { selectDenyReason, staticTruths } from './reasons.js';
import { ceilingOutcome, mergeCeilings } from './ceiling.js';
import type { CeilingOutcome } from './ceiling.js';
import { resolveDelegation, stripPrincipalOps } from './delegation.js';
import type { Delegation } from './delegation.js';
import type { VoteTruths } from './reasons.js';
import { decisionKey, entryTags, invalidationTags, principalState, versionVector } from './cache-key.js';
import { mergeAttributes, schemaIndex } from './attributes.js';
import { FieldCombiner } from './fields.js';
import { bindEngineRefs, collectRefs, refValues, scopeNodes } from './refs.js';
import { ModelContext, NoConditionCompiler, l1Key, memo } from './context.js';
import type { ContextHost, MaybePromise } from './context.js';
import { NEEDS_ASYNC, isThenable, runAsync, runSync, settleWithin, swallow } from './run.js';
import type { Pipeline, Settled } from './run.js';
import { MAX_DATA_VALUES, MAX_FILTER_NODES, budget, copyRef, deepFreeze, describeError, faultVote, sanitizeFilter, sanitizeVote, validDate } from './vote.js';

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
  /** L2; absent = no L2. */
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
  /** The invalidation generation when the top-level call started; an L2 store needs it unchanged. */
  readonly generation: number;
  /** Shared by the whole call tree (intersect delegates, ctx.check). */
  readonly nested: Nested;
}

/** What nested decisions add to every decision above them: a vote may rest on a nested check. */
interface Nested {
  uncacheable: boolean;
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
  /** Set once the load settled degraded or rejected (decision 18). */
  degraded: boolean;
}

/** What a binder load gives: `failed` (a rejection) is an engine fault, `degraded` (a rejection or a timeout) only stops caching. */
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
   * fault; a ref outside the cache-safe paths (decision 17) in the allow, the
   * field terms or the reason pass; any scope load of the request that timed
   * out or rejected (decision 18; a load still pending when the decision is
   * built cannot be seen); the same in an intersect delegate's or a nested
   * ctx.check's decision.
   */
  readonly uncacheable: boolean;
}

/** An L1 decision entry; `generation` makes an invalidate drop it too. */
class CachedDecision {
  constructor(
    readonly decision: Decision,
    /** undefined: no tags could be built, so a decision above it is not cached. */
    readonly tags: readonly string[] | undefined,
    readonly expiresAt: number,
    readonly generation: number,
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
  /** Bumped by invalidate() and by a version change: a check that overlapped one does not store into the L2. */
  private generation = 0;
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
    this.allFields = Object.freeze({ read: Object.freeze(subtractFieldGlobs(['*'], this.config.neverRead)), write: Object.freeze(['*']) });

    this.host = Object.freeze({
      domain: this.domain,
      permissions: this.registry,
      conditions: this.conditions,
      ancestors: (ref: ResourceRef, scope: Map<string, unknown>) => this.ancestorsOf(this.requireRef(ref), scope),
      attributes: (ref: ResourceRef, scope: Map<string, unknown>) => this.attributesOf(this.requireRef(ref), scope),
      relation: (type: ResourceType, name: string) => this.relation(type, name),
      // Contexts outside a check (preload); a check's own contexts use hostFor(run).
      nestedCheck: (req: Omit<DecisionRequest, 'explain'>, scope: Map<string, unknown>, instant: Date, depth: number) => runAsync(this.pipeline(req, { sync: false, scope, instant, depth, delegationBudget: this.config.maxDelegation, ...this.epoch(), nested: newNested() })).then((r) => r.decision),
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
      const input: { -readonly [K in keyof CheckInput]: CheckInput[K] } = { principal, permission };
      if (resolved) {
        input.resource = resolved.ref;
        if (resolved.subject !== undefined) input.subject = resolved.subject;
      }
      out.set(permission, await this.check(input, shared));
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

  // Task 4b.
  async summary(principal: Principal, at?: ResourceRef, scope?: RequestScope): Promise<AccessSummary> {
    void [principal, at, scope];
    throw new Error('Authorizer.summary is not implemented yet');
  }

  // Task 4b.
  async covers(holder: Principal, target: Principal, at?: ResourceRef, scope?: RequestScope): Promise<boolean> {
    void [holder, target, at, scope];
    throw new Error('Authorizer.covers is not implemented yet');
  }

  /** Preloads every principal the models of a check would run with: the run-as principal and each intersect delegate's, never an inherit agent. */
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
    await Promise.all(
      this.modelList.flatMap((model) =>
        typeof model.preload !== 'function'
          ? []
          : runAs.map(async ({ who, cacheId }) => {
              try {
                await model.preload!(who, new ModelContext(this.host, model.name, map, instant, 0, undefined, contextCacheKey(model.name, cacheId)));
              } catch (e) {
                this.logAt('error', `${this.where}: model ${quote(model.name)} failed to preload: ${describeError(e)}`);
              }
            }),
      ),
    );
  }

  invalidate(tags: readonly string[]): void {
    this.generation++;
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

  // ---- the check pipeline (conventions, "check" steps 1-15) ----

  /** `resolved`: a ref (and subject) the caller already resolved, so no adapter sees it again. */
  private *pipeline(input: CheckInput, run: Run, resolved?: { readonly ref: ResourceRef; readonly subject: unknown }): Pipeline<Checked> {
    const started = performance.now();
    if (!isObject(input)) throw new AuthzConfigError(`${this.where}: check input must be an object`);
    const explain = run.depth === 0 && input.explain === true;
    const steps: TraceStep[] | undefined = explain || this.config.explain ? [] : undefined;
    // Engine-owned data goes in as is (frozen with the trace), so a deep residual is never cut.
    const core = (step: string, note: string, data?: unknown) => steps?.push(data === undefined ? { by: CORE, step, note } : { by: CORE, step, note, data });

    const def = this.registry.require(input.permission);
    const { ref, subject } = resolved ?? (yield* this.resolveResource(input.resource, input.subject, def));
    if (ref.type !== GLOBAL_TYPE && !def.types.includes(ref.type)) {
      throw new AuthzConfigError(`${this.where}: permission ${quote(def.name)} is checked on type ${quote(ref.type)}, which is not in its types (${def.types.join(', ')}) or $global`);
    }
    core('resource', resourceKey(ref));
    const plan = this.table.get(def.name, ref.type) ?? { algorithm: 'deny-overrides', models: [] };
    const base = { def, ref, algorithm: plan.algorithm, run, explain, steps, started };

    const gate = this.principalGate(input.principal);
    if (gate.kind === 'system') {
      core('principal', 'SYSTEM: allowed without models');
      return { decision: this.finish({ ...base, requester: SYSTEM_REF, system: true }, { principal: SYSTEM_REF, residual: TRUE, roles: NO_ROLES, fields: this.allFields, models: [], votes: [] }), uncacheable: true };
    }
    if (gate.kind === 'deny') {
      core('principal', `denied before the models: ${gate.reason.code}`);
      return { decision: this.finish({ ...base, requester: gate.principal }, this.coreDenial(gate.principal, gate.reason)), uncacheable: false };
    }
    const requester = gate.ref;
    // Before the resource step, so a chain deeper than maxDelegation throws whatever the resource.
    const delegation = this.delegation(gate.principal, input.actor, run.delegationBudget);
    // Undefined for a forbidden or unreadable delegate: no model runs, so the denial names the requester.
    const parties = delegation.denial ? undefined : this.parties(delegation, gate.principal, requester);

    let ancestors: readonly ResourceRef[] | undefined;
    if (ref.id !== undefined) {
      const list = (yield this.ancestorsOf(ref, run.scope)) as readonly ResourceRef[] | null;
      if (list === null) {
        core('resource', 'unknown resource: ancestors answered null');
        // No revocation tag reaches a resource that does not exist yet: a decision resting on this one is not cached.
        if (run.depth > 0) run.nested.uncacheable = true;
        return { decision: this.finish({ ...base, requester }, parties ? this.partiesDenial(parties, { code: 'unknown_resource' }) : this.coreDenial(requester, { code: 'unknown_resource' })), uncacheable: false };
      }
      ancestors = list;
    }

    if (!parties) {
      core('delegation', 'denied before the models: a forbidden or unreadable delegate');
      return { decision: this.finish({ ...base, requester }, this.coreDenial(requester, delegation.denial!)), uncacheable: false };
    }

    // Step 6. The key is computed once, before any model reads the principal (10b wiring note 10).
    const key = subject === undefined && !explain && run.versions !== undefined ? decisionKey({ domain: this.domain, principal: gate.principal, actor: input.actor as Principal | undefined, permission: def.name, ref, versions: run.versions }) : undefined;
    if (key === undefined && subject === undefined && !explain && run.versions !== undefined) this.logAt('debug', `${this.where}: ${def.name} for ${principalKey(requester)} is not cached: the principal or actor has no canonical state`);
    const principals: Principal[] = [gate.principal, ...delegation.chain];
    if (input.actor !== undefined) principals.push(input.actor as Principal);
    if (delegation.actor !== undefined) principals.push(delegation.actor);
    const tags = once(() => this.tagsOf(plan.models, principals, ref, ancestors, run));
    if (key !== undefined) {
      const hit = this.cached(key, run, def, ref, requester, parties.ref, tags);
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
    const votes = yield* this.evaluate(models, contexts, request, plan.algorithm, explain, run, label);

    const combined = this.combine(plan.algorithm, votes);
    const allow = ceiling.denials.length > 0 ? FALSE : and(combined.allow, ceiling.restrict);
    const binder = this.refBinder(parties, env, ancestors, run);
    const bound = yield* this.bind(allow, binder);
    let residual = bound.residual;
    const coreDenials: DenyReason[] = [...ceiling.denials];
    if (delegate) {
      // The delegate's residual is already bound for the delegate; SQL and the subject evaluator would read its principal ops as ours.
      const theirs = !delegate.allowed ? FALSE : delegation.intersectKey === principalKey(parties.ref) ? delegate.residual : stripPrincipalOps(delegate.residual);
      if (theirs.op === 'false') coreDenials.push(Object.freeze({ code: 'delegate', priority: DELEGATE_PRIORITY, delegate: delegation.intersectKey }));
      residual = and(residual, theirs);
    }
    core('combine', `allow ${residual.op === 'true' ? 'TRUE' : residual.op === 'false' ? 'FALSE' : 'residual'}`, { residual });

    let subjectDenied = false;
    let subjectFault = false;
    if (subject !== undefined && residual.op !== 'true' && residual.op !== 'false') {
      const settled = (yield settleWithin(evaluateResidual(residual, subject, this.subjectEnv(parties, ref, run, steps)), this.config.modelTimeoutMs, describeError)) as Settled;
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
    let fieldsFailed = false;
    let fieldsUncacheable = false;
    if (allowed) {
      const f = yield* this.fieldsOf(plan.algorithm, votes, binder, delegate?.fields, label);
      fieldsUncacheable = f.uncacheable;
      if (f.failed) {
        core('fields', 'combining the field sets failed: denied');
        residual = FALSE;
        allowed = false;
        fieldsFailed = true;
      } else fields = f.fields;
    }
    let reason: DenyReason | undefined;
    let reasonsUncacheable = false;
    // The allow held up to the fields step, so no vote or core step caused this denial.
    if (fieldsFailed) reason = ENGINE_FAULT;
    else if (!allowed) {
      // Also when the allow was FALSE before the subject step: a row-level deny entry may still beat a ceiling.
      const pass = subject !== undefined && !subjectFault ? yield* this.subjectTruths(votes, combined.deciding, plan.algorithm, subject, binder, parties, ref, run, label, core) : { truths: votes.map(staticTruths), uncacheable: false };
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
    const validUntil = earliest([...votes.map((v) => v.validUntil), ceiling.expiresAt, delegate?.validUntil]);
    if (validUntil) outcome.validUntil = validUntil;
    const uncacheable = bound.uncacheable || fieldsUncacheable || reasonsUncacheable || delegated?.uncacheable === true || votes.some((v) => v.cacheable !== true) || run.nested.uncacheable || this.loads(run.scope).some((l) => l.degraded);
    return this.remember({ decision: this.finish({ ...base, requester }, outcome), uncacheable }, key, run, tags);
  }

  // ---- step 6 and the store (task 10) ----

  /** L1, then L2. An L1 hit is not audited again; an L2 hit is audited like a fresh decision. */
  private cached(key: string, run: Run, def: PermissionDef, ref: ResourceRef, requester: PrincipalRef, runAs: PrincipalRef, tags: () => readonly string[] | undefined): Checked | undefined {
    const now = run.instant.getTime();
    const l1 = l1Key('decision', this.domain, key);
    const entry = run.scope.get(l1);
    if (entry instanceof CachedDecision && entry.generation === this.generation && now < entry.expiresAt) {
      if (run.depth > 0) nest(run, entry.tags);
      return { decision: entry.decision, uncacheable: false };
    }
    if (!this.cache) return undefined;
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
    // Which scope nodes the stored decision's binder read is not known here: any scope change drops what rests on it.
    const own = tags();
    const withScope = own && Object.freeze([...new Set([...own, 'scope:*'])].sort());
    if (run.depth > 0) nest(run, withScope);
    const ttl = this.ttlOf(decision);
    if (ttl) run.scope.set(l1, new CachedDecision(decision, withScope, ttl.now + ttl.ms, run.generation));
    if (run.depth === 0 && !decision.allowed && this.config.auditDenials) this.record({ kind: 'deny', principal: requester, permission: def.name, resource: ref, reason: decision.reason?.code ?? 'no_access' });
    return { decision, uncacheable: false };
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

  /** Stores a cacheable decision (L1 always, L2 when tags exist and no invalidate overlapped) and hands its tags to the decisions above. */
  private remember(checked: Checked, key: string | undefined, run: Run, tags: () => readonly string[] | undefined): Checked {
    if (run.depth > 0) nest(run, checked.uncacheable ? undefined : tags());
    if (key === undefined || checked.uncacheable) return checked;
    const ttl = this.ttlOf(checked.decision);
    if (!ttl) return checked;
    const t = tags();
    run.scope.set(l1Key('decision', this.domain, key), new CachedDecision(checked.decision, t, ttl.now + ttl.ms, run.generation));
    if (this.cache && t !== undefined && this.generation === run.generation) {
      try {
        this.cache.set(key, checked.decision, t, ttl.ms);
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

  /** entryTags plus every scope node the request loaded (binder or ctx.attributes) and the nested decisions' tags. */
  private tagsOf(models: readonly AuthorizationModel[], principals: readonly Principal[], ref: ResourceRef, ancestors: readonly ResourceRef[] | undefined, run: Run): readonly string[] | undefined {
    let base: readonly string[] | undefined;
    try {
      base = entryTags({ models: models.map((m) => m.name), principals, ref, ancestors: ref.id === undefined ? undefined : ancestors });
    } catch {
      return undefined;
    }
    if (base === undefined) return undefined;
    const out = new Set(base);
    for (const load of this.loads(run.scope)) out.add(`scope:${resourceKey(load.ref)}`);
    for (const t of run.nested.tags) out.add(t);
    return Object.freeze([...out].sort());
  }

  /** Every scope node load of this request, in this domain. */
  private loads(scope: Map<string, unknown>): NodeLoad[] {
    return memo(scope, l1Key('nodes', this.domain, ''), () => [] as NodeLoad[]);
  }

  /** Wiring note 1: the version vector of a top-level call. A change recompiles the routes and drops the L2; undefined turns caching off for the call. */
  private epoch(): { readonly versions: string | undefined; readonly generation: number } {
    const versions = versionVector(this.modelList);
    if (versions === undefined) {
      if (!this.versionsWarned) {
        this.versionsWarned = true;
        this.logAt('warn', `${this.where}: a model's version() threw or returned a non-string; decisions are not cached while it does`);
      }
      return { versions: undefined, generation: this.generation };
    }
    if (versions !== this.versions) {
      this.generation++;
      this.invalidateL2(['*']);
      try {
        this.table = this.compileTable();
      } catch (e) {
        // The old routes stay; the next call tries again.
        this.logAt('error', `${this.where}: recompiling the routes after a model version change failed; decisions are not cached: ${describeError(e)}`);
        return { versions: undefined, generation: this.generation };
      }
      this.versions = versions;
    }
    return { versions, generation: this.generation };
  }

  private compileTable(): RouteTable {
    return compileRoutes({ domain: this.domain, models: this.modelList, registry: this.registry, combine: this.combineConfig, algorithms: [...this.combinators.keys()] });
  }

  private invalidateL2(tags: readonly string[]): void {
    if (!this.cache) return;
    try {
      this.cache.invalidate(tags);
    } catch (e) {
      this.logAt('error', `${this.where}: the decision cache failed to invalidate ${tags.join(', ')}: ${describeError(e)}`);
    }
  }

  /** The context host of one call tree: a model's ctx.check shares its versions, generation and nested record. */
  private hostFor(run: Run): ContextHost {
    return Object.freeze({
      ...this.host,
      nestedCheck: (req: Omit<DecisionRequest, 'explain'>, scope: Map<string, unknown>, instant: Date, depth: number) => runAsync(this.pipeline(req, { ...run, sync: false, scope, instant, depth, delegationBudget: this.config.maxDelegation })).then((r) => r.decision),
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

  /** Step 8: concurrent under deny-overrides and custom algorithms; in plan order with a stop otherwise. */
  private *evaluate(models: readonly AuthorizationModel[], contexts: readonly ModelContext[], request: () => DecisionRequest, algorithm: string, explain: boolean, run: Run, label: string): Pipeline<Vote[]> {
    if (run.sync && models.some((m) => syncMode(m) === 'never')) yield NEEDS_ASYNC;

    if (algorithm === 'permit-overrides' || algorithm === 'first-applicable') {
      const votes: Vote[] = [];
      for (let i = 0; i < models.length; i++) {
        const started = this.start(models[i], contexts[i], request(), run, label);
        const vote = (isThenable(started) ? yield started : started) as Vote;
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
    return started.some(isThenable) ? ((yield Promise.all(started)) as Vote[]) : (started as Vote[]);
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
    return settleWithin(raw as PromiseLike<unknown>, this.config.modelTimeoutMs, describeError).then((s) => this.accept(model, ctx, s.ok ? { raw: s.value } : { fault: s.error }, label));
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
  private *bind(allow: ResourceFilter, binder: RefBinder): Pipeline<{ readonly residual: ResourceFilter; readonly failed: boolean; readonly uncacheable: boolean }> {
    try {
      const covered = yield* binder.cover([allow]);
      return { residual: binder.bind(allow), failed: covered.failed, uncacheable: covered.uncacheable };
    } catch (e) {
      this.logAt('error', `${this.where}: binding refs failed: ${describeError(e)}`);
      return { residual: FALSE, failed: true, uncacheable: true };
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
   * A degraded or failed load leaves its refs missing and only stops caching.
   */
  private *fieldsOf(algorithm: string, votes: readonly Vote[], binder: RefBinder, delegate: Fields | undefined, label: string): Pipeline<{ readonly fields: Fields; readonly failed: boolean; readonly uncacheable: boolean }> {
    let uncacheable: boolean;
    try {
      uncacheable = (yield* binder.cover(votes.filter((v) => v.error === undefined).flatMap((v) => [v.permitWhen, v.denyWhen]))).uncacheable;
    } catch (e) {
      // Refs of nodes left unloaded bind as missing: fewer fields, more hidden.
      this.logAt('error', `${this.where}: loading the scope attributes of the field sets of ${label} failed: ${describeError(e)}`);
      uncacheable = true;
    }
    try {
      const own = this.fieldCombiner.combine(algorithm, votes, (f) => binder.bind(f));
      return { fields: delegate ? this.fieldCombiner.intersect(own, delegate) : own, failed: false, uncacheable };
    } catch (e) {
      if (!(e instanceof AuthzConfigError)) throw e;
      this.logAt('error', `${this.where}: combining the field sets of ${label} failed: ${describeError(e)}`);
      return { fields: NO_FIELDS, failed: true, uncacheable: true };
    }
  }

  /** `subjectEvaluated`: the subject itself denied (4a rule: only then `residual_false`). */
  private denyReason(core: readonly DenyReason[], votes: readonly Vote[], truths: readonly VoteTruths[], deciding: Vote | undefined, algorithm: string, subjectEvaluated: boolean, engineFault: boolean): DenyReason {
    return selectDenyReason({ core: engineFault ? [...core, ENGINE_FAULT] : core, votes, truths, algorithm, deciding, subjectEvaluated });
  }

  /**
   * Truths of the counted votes against the subject, the loads and the batch
   * under one time limit; static truths for the others and on timeout. Not
   * traced as subject checks: one core 'reason' step holds the result.
   */
  private *subjectTruths(votes: readonly Vote[], deciding: Vote | undefined, algorithm: string, subject: unknown, binder: RefBinder, parties: Parties, ref: ResourceRef, run: Run, label: string, core: (step: string, note: string, data?: unknown) => void): Pipeline<{ readonly truths: readonly VoteTruths[]; readonly uncacheable: boolean }> {
    const started = performance.now();
    const counted: readonly Vote[] = algorithm === 'first-applicable' && deciding !== undefined ? [deciding] : votes;
    const subjectEnv = this.subjectEnv(parties, ref, run, undefined);
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
    const settled = (yield settleWithin(batch, left, describeError)) as Settled;
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

  // Step 4 (task 7 owns the final form): SYSTEM and UNATTENDED are recognised by identity only.
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

    if (f.run.depth === 0) {
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

  private subjectEnv(parties: Parties, ref: ResourceRef, run: Run, steps: TraceStep[] | undefined): SubjectEnv {
    const adapter = this.adapterByType.get(ref.type);
    const attribute = adapter && typeof adapter.attribute === 'function' ? (subject: unknown, field: string) => adapter.attribute!(subject, field) : defaultAttribute;
    return {
      principal: parties.principal,
      ref,
      attribute,
      relation: (type, name) => this.relation(type, name),
      ancestors: (r) => Promise.resolve(this.ancestorsOf(this.requireRef(r), run.scope)),
      native: (op) => this.natives.get(op),
      ctx: new ModelContext(this.hostFor(run), CORE, run.scope, run.instant, run.depth, steps, contextCacheKey('\u0000core', parties.cacheId)),
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
    const source = this.adapterByType.get(ref.type) ?? this.resolverByType.get(ref.type);
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

  private requireRef(v: unknown): ResourceRef {
    const ref = copyRef(v);
    if (!ref) throw new AuthzConfigError(`${this.where}: expected a ResourceRef`);
    return ref;
  }

  // ---- plumbing ----

  private newRun(sync: boolean, scope: RequestScope | undefined): Run {
    return { sync, scope: scopeMap(scope), instant: this.now(), depth: 0, delegationBudget: this.config.maxDelegation, ...this.epoch(), nested: newNested() };
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

const newNested = (): Nested => ({ uncacheable: false, tags: new Set() });

/** undefined tags: a decision above this one cannot be invalidated reliably, so it is not cached. */
function nest(run: Run, tags: readonly string[] | undefined): void {
  if (tags === undefined) run.nested.uncacheable = true;
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
 * Decision 9: ctx.cache is per model and per full state of the principal the
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

const contextCacheKey = (owner: string, cacheId: string): string => JSON.stringify([cacheId, owner]);

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
  return settleWithin(outcome, ms, describeError).then((s): Bounded => (s.ok ? (s.value as Bounded) : { kind: 'timeout' }));
}

const KEYED_SCALARS = new Set(['type', 'id', 'authenticated', 'source', 'delegation']);
const KEYED_AUTHN = new Set(['method', 'strategy', 'assurance', 'mfa', 'authenticatedAt', 'sessionHandle']);
// The key holds these as sorted unique sets (ceilingHash): a whole list means the same in any order, an element path does not.
const CEILING_SETS = new Set(['roles', 'permissions', 'resources']);

/**
 * Decision 17: a ref is cache-safe only when the L2 key holds its path.
 * scope.* refs are safe: the entry is tagged with each loaded scope node
 * (decision 16).
 */
function cacheSafeRef(r: string): boolean {
  const [root, head, ...tail] = r.split('.');
  if (root === 'scope') return true;
  if ((root !== 'principal' && root !== 'actor') || head === undefined) return false;
  if (head === 'attributes') return true;
  if (head === 'ceiling') return tail.length <= 1 || !CEILING_SETS.has(tail[0]);
  if (head === 'authn') return tail.length === 1 ? KEYED_AUTHN.has(tail[0]) : tail.length === 2 && tail[0] === 'impersonator' && (tail[1] === 'type' || tail[1] === 'id');
  return tail.length === 0 && KEYED_SCALARS.has(head);
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
  *cover(filters: readonly ResourceFilter[]): Pipeline<{ readonly failed: boolean; readonly uncacheable: boolean }> {
    let uncacheable = false;
    const refs = new Set<string>();
    for (const f of filters) {
      if (!collectRefs(f).every(cacheSafeRef)) uncacheable = true;
      for (const r of collectRefs(bindRefs(f, this.scope))) refs.add(r);
    }
    const nodes = [...scopeNodes([...refs], { ancestors: this.ancestors })].filter(([type]) => !this.attributes.has(type));
    if (nodes.length === 0) return { failed: false, uncacheable };
    if (this.sync) yield NEEDS_ASYNC;
    const loaded = (yield Promise.all(nodes.map(([, node]) => this.load(node)))) as readonly BoundAttributes[];
    nodes.forEach(([type], i) => this.attributes.set(type, loaded[i].attributes));
    return { failed: loaded.some((l) => l.failed), uncacheable: uncacheable || loaded.some((l) => l.degraded) };
  }

  bind(f: ResourceFilter): ResourceFilter {
    const pre = bindRefs(f, this.scope);
    return bindEngineRefs(pre, refValues(collectRefs(pre), this.actor, this.attributes));
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

function earliest(dates: readonly (Date | undefined)[]): Date | undefined {
  let best: Date | undefined;
  for (const d of dates) {
    const valid = validDate(d);
    if (valid && (best === undefined || valid.getTime() < best.getTime())) best = valid;
  }
  return best;
}
