import { AuthzConfigError } from '../contracts/errors.js';
import { FALSE, TRUE, and, bindRefs, not, or, simplify } from '../contracts/filter.js';
import type { ResourceFilter } from '../contracts/filter.js';
import { compareDenyReasons } from '../contracts/decision.js';
import type { CombiningAlgorithm, Decision, DecisionRequest, DenyReason, Trace, TraceStep, Vote } from '../contracts/decision.js';
import type { AuthorizationModel, Combinator, NativeFilter } from '../contracts/model.js';
import type { Permission, PermissionDef, PermissionRegistry } from '../contracts/permission.js';
import { SYSTEM, UNATTENDED } from '../contracts/principal.js';
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
import type { SubjectEnv } from './evaluate.js';
import { ModelContext, NoConditionCompiler, l1Key, memo } from './context.js';
import type { ContextHost, MaybePromise } from './context.js';
import { NEEDS_ASYNC, isThenable, runAsync, runSync, settleWithin } from './run.js';
import type { Pipeline, Settled } from './run.js';
import { MAX_DATA_VALUES, MAX_FILTER_NODES, budget, copyData, copyRef, deepFreeze, describeError, faultVote, sanitizeFilter, sanitizeVote, validDate } from './vote.js';

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
}

/** Who the models run with (task 7 adds delegation). */
interface Parties {
  readonly principal: Principal;
  readonly actor?: Principal;
}

type Gate = { readonly kind: 'system' } | { readonly kind: 'deny'; readonly principal: PrincipalRef; readonly reason: DenyReason } | { readonly kind: 'run'; readonly principal: Principal; readonly ref: PrincipalRef };

interface CeilingOutcome {
  readonly denials: readonly DenyReason[];
  readonly restrict: ResourceFilter;
  readonly expiresAt?: Date;
}

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
const NO_LOG: EngineLog = Object.freeze({ error() {}, warn() {}, debug() {} });
const NO_CEILING: CeilingOutcome = Object.freeze({ denials: Object.freeze([]), restrict: TRUE });
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
  private readonly table: RouteTable;
  private readonly adapterList: readonly ResourceAdapter[];
  private readonly adapterByType = new Map<ResourceType, ResourceAdapter>();
  private readonly resolverByType = new Map<ResourceType, ScopeResolver>();
  private readonly relationIndex = new Map<string, RelationResolver>();
  private readonly natives = new Map<string, NativeFilter>();
  private readonly conditions: ConditionCompiler;
  private readonly clock: () => Date;
  private readonly log: EngineLog;
  private readonly auditSink: DecisionAudit | undefined;
  private readonly config: EngineConfig;
  private readonly allFields: Fields;
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

    this.table = compileRoutes({ domain: this.domain, models: this.modelList, registry: this.registry, combine: options.combine ?? DEFAULT_COMBINE, algorithms: [...this.combinators.keys()] });

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

    this.allFields = Object.freeze({ read: Object.freeze(subtractFieldGlobs(['*'], this.config.neverRead)), write: Object.freeze(['*']) });

    this.host = Object.freeze({
      domain: this.domain,
      permissions: this.registry,
      conditions: this.conditions,
      ancestors: (ref: ResourceRef, scope: Map<string, unknown>) => this.ancestorsOf(this.requireRef(ref), scope),
      attributes: (ref: ResourceRef, scope: Map<string, unknown>) => this.attributesOf(this.requireRef(ref), scope),
      relation: (type: ResourceType, name: string) => this.relation(type, name),
      nestedCheck: (req: Omit<DecisionRequest, 'explain'>, scope: Map<string, unknown>, instant: Date, depth: number) => runAsync(this.pipeline(req, { sync: false, scope, instant, depth })),
    });
  }

  async check(input: CheckInput, scope?: RequestScope): Promise<Decision> {
    return runAsync(this.pipeline(input, this.newRun(false, scope)));
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
    return runSync(this.pipeline({ principal, permission, resource: { type } }, this.newRun(true, scope)))?.value.residual;
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

  async preload(principal: Principal, scope?: RequestScope): Promise<void> {
    const chain: Principal[] = [];
    try {
      // Bounded by steps, not by pushed entries: skipped system/unattended links must still count.
      const seen = new Set<unknown>();
      let cur: unknown = principal;
      for (let step = 0; isObject(cur) && step <= this.config.maxDelegation && !seen.has(cur); step++) {
        seen.add(cur);
        const type = cur.type;
        if (type !== 'system' && type !== 'unattended') chain.push(cur as unknown as Principal);
        cur = cur.onBehalfOf;
      }
    } catch (e) {
      this.logAt('error', `${this.where}: preload could not read the principal chain: ${describeError(e)}`);
    }
    const map = scopeMap(scope);
    const instant = this.now();
    await Promise.all(
      this.modelList.flatMap((model) =>
        typeof model.preload !== 'function'
          ? []
          : chain.map(async (who) => {
              try {
                await model.preload!(who, new ModelContext(this.host, model.name, map, instant, 0, undefined));
              } catch (e) {
                this.logAt('error', `${this.where}: model ${quote(model.name)} failed to preload: ${describeError(e)}`);
              }
            }),
      ),
    );
  }

  // Task 10 adds the L2 and the tag mapping.
  invalidate(tags: readonly string[]): void {
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

  private *pipeline(input: CheckInput, run: Run): Pipeline<Decision> {
    const started = performance.now();
    if (!isObject(input)) throw new AuthzConfigError(`${this.where}: check input must be an object`);
    const explain = run.depth === 0 && input.explain === true;
    const steps: TraceStep[] | undefined = explain || this.config.explain ? [] : undefined;
    // Engine-owned data goes in as is (frozen with the trace), so a deep residual is never cut.
    const core = (step: string, note: string, data?: unknown) => steps?.push(data === undefined ? { by: CORE, step, note } : { by: CORE, step, note, data });

    const def = this.registry.require(input.permission);
    const { ref, subject } = yield* this.resolveResource(input.resource, input.subject, def);
    if (ref.type !== GLOBAL_TYPE && !def.types.includes(ref.type)) {
      throw new AuthzConfigError(`${this.where}: permission ${quote(def.name)} is checked on type ${quote(ref.type)}, which is not in its types (${def.types.join(', ')}) or $global`);
    }
    core('resource', resourceKey(ref));
    const plan = this.table.get(def.name, ref.type) ?? { algorithm: 'deny-overrides', models: [] };
    const base = { def, ref, algorithm: plan.algorithm, run, explain, steps, started };

    const gate = this.principalGate(input.principal);
    if (gate.kind === 'system') {
      core('principal', 'SYSTEM: allowed without models');
      return this.finish({ ...base, requester: SYSTEM_REF, system: true }, { principal: SYSTEM_REF, residual: TRUE, roles: NO_ROLES, fields: this.allFields, models: [], votes: [] });
    }
    if (gate.kind === 'deny') {
      core('principal', `denied before the models: ${gate.reason.code}`);
      return this.finish({ ...base, requester: gate.principal }, this.coreDenial(gate.principal, gate.reason));
    }
    const requester = gate.ref;

    if (ref.id !== undefined) {
      const ancestors = yield this.ancestorsOf(ref, run.scope);
      if (ancestors === null) {
        core('resource', 'unknown resource: ancestors answered null');
        return this.finish({ ...base, requester }, this.coreDenial(requester, { code: 'unknown_resource' }));
      }
    }

    const parties = this.parties(gate.principal, input.actor);
    const ceiling = this.ceilingOf();
    const env = this.envOf(input.env, run.instant);

    const models = plan.models.filter((m) => {
      const admitted = admits(m, parties.principal);
      if (!admitted) core('skip', `model ${quote(m.name)} does not serve principal type ${quote(parties.principal.type)}`);
      return admitted;
    });
    core('route', `${plan.algorithm} over ${models.length} model(s)`, { models: models.map((m) => m.name) });
    const contexts = models.map((m) => new ModelContext(this.host, m.name, run.scope, run.instant, run.depth, steps));
    const request = () => this.request(parties, def, ref, subject, input.env, run.instant, explain);
    const label = `${def.name} on ${resourceKey(ref)}`;
    const votes = yield* this.evaluate(models, contexts, request, plan.algorithm, explain, run, label);

    const combined = this.combine(plan.algorithm, votes);
    const allow = ceiling.denials.length > 0 ? FALSE : and(combined.allow, ceiling.restrict);
    const bound = this.bind(allow, parties, env);
    let residual = bound.residual;
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

    const allowed = residual.op !== 'false';
    const reason = allowed ? undefined : this.denyReason(ceiling.denials, votes, combined.deciding, plan.algorithm, subjectDenied && !subjectFault, combined.failed || bound.failed || subjectFault);
    const outcome: { -readonly [K in keyof Outcome]: Outcome[K] } = {
      principal: parties.principal === gate.principal ? requester : principalRef(parties.principal),
      residual: allowed ? residual : FALSE,
      roles: mergeRoles(votes),
      fields: this.fieldsOf(allowed),
      models: models.map((m) => m.name),
      votes,
    };
    if (parties.actor) outcome.actor = principalRef(parties.actor);
    if (reason) outcome.reason = reason;
    const validUntil = earliest([...votes.map((v) => v.validUntil), ceiling.expiresAt]);
    if (validUntil) outcome.validUntil = validUntil;
    return this.finish({ ...base, requester }, outcome);
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

  /** Step 11. */
  private bind(allow: ResourceFilter, parties: Parties, env: Readonly<Record<string, unknown>>): { readonly residual: ResourceFilter; readonly failed: boolean } {
    try {
      return { residual: this.bindEngineRefs(bindRefs(allow, { principal: parties.principal, env })), failed: false };
    } catch (e) {
      this.logAt('error', `${this.where}: binding refs failed: ${describeError(e)}`);
      return { residual: FALSE, failed: true };
    }
  }

  // Task 8 seam (refs.ts): binds actor.* and scope.*; until then every ref left after bindRefs is missing.
  private bindEngineRefs(f: ResourceFilter): ResourceFilter {
    return simplify(dropRefs(f, false));
  }

  // Task 7 seam (delegation.ts): onBehalfOf; for now the models run with the request principal.
  private parties(principal: Principal, actor: unknown): Parties {
    if (actor === undefined) return { principal };
    if (!isObject(actor) || typeof actor.type !== 'string' || typeof actor.id !== 'string') throw new AuthzConfigError(`${this.where}: actor must be a principal`);
    return { principal, actor: actor as unknown as Principal };
  }

  // Task 7 seam (ceiling.ts): step 7.
  private ceilingOf(): CeilingOutcome {
    return NO_CEILING;
  }

  // Task 9 seam (fields.ts).
  private fieldsOf(allowed: boolean): Fields {
    return allowed ? this.allFields : NO_FIELDS;
  }

  // Task 5 seam (reasons.ts): the minimum of the candidates under compareDenyReasons.
  private denyReason(core: readonly DenyReason[], votes: readonly Vote[], deciding: Vote | undefined, algorithm: string, subjectDenied: boolean, engineFault: boolean): DenyReason {
    const candidates: DenyReason[] = [...core];
    if (engineFault) candidates.push({ code: 'model_error' });
    const counted = algorithm === 'first-applicable' && deciding !== undefined ? [deciding] : votes;
    for (const v of counted) if (v.error !== undefined) candidates.push({ code: 'model_error', model: v.model });
    if (candidates.length === 0) candidates.push({ code: subjectDenied ? 'residual_false' : 'no_access' });
    const best = candidates.reduce((a, b) => (compareDenyReasons(b, a) < 0 ? b : a));
    return (copyData(best, false) as DenyReason | undefined) ?? Object.freeze({ code: 'model_error' });
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
      ctx: new ModelContext(this.host, CORE, run.scope, run.instant, run.depth, steps, '\u0000core'),
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

  private attributesOf(ref: ResourceRef, scope: Map<string, unknown>): Promise<Readonly<Record<string, unknown>> | null> {
    return memo(scope, l1Key('attributes', this.domain, resourceKey(ref)), () => this.loadAttributes(ref));
  }

  // Task 8 (attributes.ts) adds schema defaults, the store and the merge.
  private async loadAttributes(ref: ResourceRef): Promise<Readonly<Record<string, unknown>> | null> {
    const adapter = this.adapterByType.get(ref.type);
    const resolver = this.resolverByType.get(ref.type);
    let raw: unknown = {};
    if (adapter && typeof adapter.scopeAttributes === 'function') raw = await adapter.scopeAttributes(ref);
    else if (resolver && typeof resolver.attributes === 'function') raw = await resolver.attributes(ref);
    if (raw === null) return null;
    if (!isObject(raw) || Array.isArray(raw)) throw new AuthzConfigError(`${this.where}: scope attributes of ${resourceKey(ref)} must be an object or null`);
    const copy = copyData(raw, false);
    if (copy === undefined) throw new AuthzConfigError(`${this.where}: scope attributes of ${resourceKey(ref)} hold too many values`);
    return copy as Readonly<Record<string, unknown>>;
  }

  private requireRef(v: unknown): ResourceRef {
    const ref = copyRef(v);
    if (!ref) throw new AuthzConfigError(`${this.where}: expected a ResourceRef`);
    return ref;
  }

  // ---- plumbing ----

  private newRun(sync: boolean, scope: RequestScope | undefined): Run {
    return { sync, scope: scopeMap(scope), instant: this.now(), depth: 0 };
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

const principalRef = (p: PrincipalRef): PrincipalRef => Object.freeze({ type: p.type, id: p.id });

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

/** Any comparison still holding a ref is missing: FALSE under an even number of `not`, TRUE under an odd one. */
function dropRefs(f: ResourceFilter, negated: boolean): ResourceFilter {
  switch (f.op) {
    case 'and':
    case 'or':
      return { op: f.op, args: (f as Extract<ResourceFilter, { op: 'and' | 'or' }>).args.map((x) => dropRefs(x, negated)) };
    case 'not':
      return { op: 'not', arg: dropRefs((f as Extract<ResourceFilter, { op: 'not' }>).arg, !negated) };
    case 'cmp': {
      const value = (f as Extract<ResourceFilter, { op: 'cmp' }>).value;
      return isObject(value) && !Array.isArray(value) ? (negated ? TRUE : FALSE) : f;
    }
    default:
      return f;
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
