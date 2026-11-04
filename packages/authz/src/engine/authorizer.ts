import { quote, compareStrings } from '@spinajs/util';
import { Perf } from '@spinajs/log-common';
import { AuthzConfigError, UnknownPermission } from '../contracts/errors.js';
import { FALSE, TRUE, and, not, simplify } from '../contracts/filter.js';
import type { ResourceFilter } from '../contracts/filter.js';
import type { Decision, DecisionRequest, DenyReason, FieldSet, TraceStep, Vote } from '../contracts/decision.js';
import { compareDenyReasons } from '../contracts/decision.js';
import type { AccessPlan, ListPlanRequest, ModelListPlan } from '../contracts/plan.js';
import type { AuthorizationModel, ModelSummary } from '../contracts/model.js';
import type { Permission, PermissionDef } from '../contracts/permission.js';
import { SYSTEM, principalKey } from '../contracts/principal.js';
import type { Ceiling, Principal, PrincipalRef, ResourceRef, ResourceType } from '../contracts/principal.js';
import { GLOBAL, resourceKey } from '../contracts/resource.js';
import type { RelationResolver, ResourceAdapter } from '../contracts/adapter.js';
import type { AccessSummary, CheckInput } from '../contracts/service.js';
import { subtractFieldGlobs, unionFieldGlobs } from '../contracts/fields.js';
import { DEFAULT_COMBINE } from './routes.js';
import type { RouteTable } from './routes.js';
import { defaultAttribute, evaluateResidual } from './evaluate.js';
import type { SubjectEnv, Truth } from './evaluate.js';
import { selectDenyReason, staticTruths } from './reasons.js';
import { ceilingOutcome, mergeCeilings, readCeiling, scopeCovers } from './ceiling.js';
import type { CeilingOutcome } from './ceiling.js';
import { resolveDelegation, stripPrincipalOps } from './delegation.js';
import type { Delegation } from './delegation.js';
import type { VoteTruths } from './reasons.js';
import { decisionKey, invalidationTags, principalState, versionVector } from './cache-key.js';
import { mergeAttributes } from './attributes.js';
import { ModelContext, NoConditionCompiler, l1Key, memo } from './context.js';
import type { ContextHost, MaybePromise } from './context.js';
import { NEEDS_ASYNC, isThenable, runAsync, runSync, settleWithin, swallow } from './run.js';
import type { Pipeline, Settled } from './run.js';
import { MAX_DATA_VALUES, MAX_FILTER_NODES, budget, copyData, copyRef, deepFreeze, describeError, faultVote, sanitizeFilter, sanitizeVote, thrownError } from './vote.js';
import { ALL_PLAN, CEILING_DENIAL, combinePlans, nonePlan, readModelPlan, withinOf } from './plan.js';
import type { PlanAnswer } from './plan.js';
import { isObject } from './internal/util.js';
import { BUILTIN_ALGORITHMS, CORE, CachedPlan, DEADLINE_FACTOR, DELEGATE_PRIORITY, ENGINE_FAULT, FAILED_ROW, GLOBAL_ANCESTORS, GLOBAL_TYPE, INVALID_REQUEST, MAX_PRELOADED, MAX_SUMMARY_PERMISSIONS, MISSING_ROW, NO_FIELDS, NO_LOG, NO_ROLES, SUMMARY_BATCH, SYSTEM_REF, UNKNOWN_RESOURCE, nextGeneration } from './types.js';
import type { Attributes, AuthorizerOptions, Engine, BoundAttributes, Checked, Combined, Fields, LoadedAttributes, NodeLoad, Outcome, Parties, RequestScope, RowLoad, Run } from './types.js';
import { Deadline, EXPIRED, THREW } from './support/deadline.js';
import { RefBinder, TIMED_OUT, bounded } from './support/ref-binder.js';
import { entryCovers, firmFieldsOf } from './support/compare.js';
import { combinatorsOf, compileTable, decisionCacheOf, fieldSetup, readConfig, resourceIndexes, scopeAttributesOf } from './support/setup.js';
import { admits, byType, capabilitiesOf, contextCacheKey, decides, deniedCopy, detachingOnThrow, earliest, mergeRoles, newNested, once, principalCacheId, principalRef, refShaped, scopeMap, syncMode } from './support/misc.js';
import { logAt, newRun, now, topRun } from './support/plumbing.js';
import { bornOf, epoch, invalidateL2 } from './cache/generation.js';
import { cached } from './cache/lookup.js';
import { loads, markFault, marking, remember, scopeFaulted, tagsOf } from './cache/store.js';
import { coreDenial, partiesDenial, principalGate } from './pipeline/principal-gate.js';
import { finish } from './pipeline/finish.js';

export { MAX_SUMMARY_PERMISSIONS } from './types.js';
export type { AuthorizerOptions, RequestScope } from './types.js';

export class Authorizer {
  readonly domain: string;
  private readonly engine: Engine;
  private readonly host: ContextHost;
  /** Principal cache id ⇒ the generation its preload finished in; a stale generation counts as not preloaded. */
  private readonly preloaded = new Map<string, number>();

  constructor(options: AuthorizerOptions) {
    const generation = nextGeneration();
    if (!isObject(options)) throw new AuthzConfigError('Authorizer options must be an object');
    if (typeof options.domain !== 'string' || options.domain === '') throw new AuthzConfigError(`Authorizer domain must be a non-empty string, got ${quote(options.domain)}`);
    this.domain = options.domain;
    const where = `Authz domain ${quote(this.domain)}`;
    if (!isObject(options.registry)) throw new AuthzConfigError(`${where}: a permission registry is required`);
    if (!Array.isArray(options.models)) throw new AuthzConfigError(`${where}: models must be an array`);
    const modelList = Object.freeze([...options.models]);
    const config = readConfig(where, options.config ?? {});
    const routing = { domain: this.domain, registry: options.registry, modelList, combinators: combinatorsOf(where, options.combinators), combineConfig: options.combine ?? DEFAULT_COMBINE };
    this.engine = {
      ...routing,
      where,
      config,
      log: options.log ?? NO_LOG,
      auditSink: options.audit,
      clock: options.clock ?? (() => new Date()),
      conditions: options.conditions ?? new NoConditionCompiler(),
      table: compileTable(routing),
      versions: versionVector(modelList),
      versionsWarned: false,
      generation,
      l2Stale: false,
      cache: decisionCacheOf(where, options.cache),
      ...resourceIndexes(where, options),
      ...scopeAttributesOf(where, options.scopeAttributes),
      ...fieldSetup(where, config.neverRead),
    };
    this.host = Object.freeze({
      domain: this.domain,
      permissions: this.engine.registry,
      conditions: this.engine.conditions,
      ancestors: (ref: ResourceRef, scope: Map<string, unknown>) => marking(this.engine, scope, () => this.ancestorsOf(this.requireRef(ref), scope)),
      attributes: (ref: ResourceRef, scope: Map<string, unknown>) => this.attributesOf(this.requireRef(ref), scope),
      relation: (type: ResourceType, name: string) => this.relation(type, name),
      // Contexts outside a check (preload); a check's own contexts use hostFor(run).
      nestedCheck: (req: Omit<DecisionRequest, 'explain'>, scope: Map<string, unknown>, instant: Date, depth: number): Promise<Decision> =>
        Promise.resolve(
          marking(this.engine, scope, () =>
            runAsync(this.pipeline(req, topRun(this.engine, false, scope, instant, depth))).then((r) => {
              if (r.faulted) markFault(this.engine, scope);
              return r.decision;
            }),
          ),
        ),
    });
  }

  async check(input: CheckInput, scope?: RequestScope): Promise<Decision> {
    return Perf.measure('authz.check', async () => (await runAsync(this.pipeline(input, this.newRun(false, scope)))).decision, { labels: { domain: this.domain } });
  }

  /** Introspection, not an access attempt: unaudited, no decision cache read or stored, models read fresh. */
  async inspect(input: CheckInput, scope?: RequestScope): Promise<Decision> {
    if (!isObject(input)) throw new AuthzConfigError(`${this.engine.where}: check input must be an object`);
    for (const flag of ['fresh', 'explain'] as const) if (input[flag] !== undefined && typeof input[flag] !== 'boolean') throw new AuthzConfigError(`${this.engine.where}: ${flag} must be a boolean`);
    const run: Run = { ...this.newRun(false, scope), bypass: true, quiet: true };
    return (await runAsync(this.pipeline({ ...input, explain: false, fresh: true }, run))).decision;
  }

  /** Every model evaluated, trace attached, caches bypassed. */
  async explain(input: CheckInput, scope?: RequestScope): Promise<Decision> {
    if (!isObject(input)) throw new AuthzConfigError(`${this.engine.where}: check input must be an object`);
    return this.check({ ...input, explain: true }, scope);
  }

  async checkMany(principal: Principal, permissions: readonly Permission[], resource?: ResourceRef | object, scope?: RequestScope): Promise<ReadonlyMap<Permission, Decision>> {
    if (!Array.isArray(permissions)) throw new AuthzConfigError(`${this.engine.where}: checkMany permissions must be an array`);
    const shared: RequestScope = { cache: scopeMap(scope) };
    const resolved = resource === undefined ? undefined : await runAsync(this.resolveObject(resource));
    const out = new Map<Permission, Decision>();
    for (const permission of permissions) {
      if (out.has(permission)) continue;
      out.set(permission, (await runAsync(this.pipeline({ principal, permission }, this.newRun(false, shared), resolved))).decision);
    }
    return out;
  }

  /**
   * Design §6.2: the routed models' listPlan answers combined with deny-overrides, under the
   * principal's ceilings. Throws like check() for an unknown permission or a type outside its
   * types, and AuthzConfigError for a permission not declared `list: true`. PlanTerms are OR-ed,
   * so an intersect delegate (whose decision check() ANDs in) gets `none` with `delegate`.
   */
  async accessPlan(principal: Principal, permission: Permission, type: ResourceType, env?: Readonly<Record<string, unknown>>, scope?: RequestScope): Promise<AccessPlan> {
    const def = this.requirePermission(permission);
    if (def.list !== true) throw new AuthzConfigError(`${this.engine.where}: permission ${quote(def.name)} is not declared with list: true, so it has no access plan`);
    this.refuseLateType(type);
    if (!def.types.includes(type)) throw new AuthzConfigError(`${this.engine.where}: permission ${quote(def.name)} is planned on type ${quote(type)}, which is not in its types (${def.types.join(', ')})`);
    const gate = principalGate(principal);
    if (gate.kind === 'system') return ALL_PLAN;
    if (gate.kind === 'deny') return nonePlan(gate.reason);
    const fresh = def.consistency === 'fresh';
    const run: Run = fresh ? { ...this.newRun(false, scope), fresh: true } : this.newRun(false, scope);
    const delegation = this.delegation(gate.principal, undefined, run.delegationBudget);
    if (delegation.denial) return nonePlan(delegation.denial);
    if (delegation.intersect !== undefined) return nonePlan({ code: 'delegate', priority: DELEGATE_PRIORITY, delegate: delegation.intersectKey });
    // Env facts are not in the key, so a call with a caller env is never memoised; a fresh plan is never read back.
    const key = env === undefined && !fresh ? this.planKey(gate.principal, def, type, run) : undefined;
    const hit = key === undefined ? undefined : this.cachedPlan(key, run);
    if (hit) return hit;
    const built = await this.buildPlan(delegation, def, type, this.envOf(env, run.instant), run);
    if (key !== undefined && !built.faulted) run.scope.set(key, new CachedPlan(built.plan, run.generation));
    return built.plan;
  }

  /**
   * Many single-object checks of one principal over one request scope, in input order (resource-access
   * plan decision 3). One ancestorsMany call per type fills the L1 before the checks. A decision allowed
   * with a residual is checked again against its row, as authz-http's `subject: 'load'` does: one loadMany
   * call per type (else load per ref); no row denies with unknown_resource, a failed load with model_error;
   * an adapter that cannot load leaves the decision conditional. An unregistered permission or a type the
   * permission cannot be checked on is a denial with invalid_request, so one bad entry never fails the batch.
   */
  async checkAll(principal: Principal, requests: readonly { readonly permission: Permission; readonly resource: ResourceRef }[], scope?: RequestScope): Promise<readonly Decision[]> {
    if (!Array.isArray(requests)) throw new AuthzConfigError(`${this.engine.where}: checkAll requests must be an array`);
    const out: Decision[] = [];
    const items = (requests as readonly unknown[]).map((r, i) => {
      if (!isObject(r)) throw new AuthzConfigError(`${this.engine.where}: checkAll request ${i} must be an object`);
      const ref = this.requireRef(r.resource);
      const def = typeof r.permission === 'string' ? this.engine.registry.get(r.permission) : undefined;
      if (!def || this.lateType(ref.type) !== undefined || (ref.type !== GLOBAL_TYPE && !def.types.includes(ref.type))) {
        out[i] = this.invalidRequest(principal, r.permission, ref);
        return undefined;
      }
      return { def, ref };
    });
    const shared: RequestScope = { cache: scopeMap(scope) };
    await this.prefillAncestors(
      items.flatMap((x) => (x ? [x.ref] : [])),
      shared.cache!,
    );
    const check = async (def: PermissionDef, ref: ResourceRef, subject: unknown): Promise<Decision> => (await runAsync(this.pipeline({ principal, permission: def.name }, this.newRun(false, shared), { ref, subject }))).decision;
    for (const [i, x] of items.entries()) if (x) out[i] = await check(x.def, x.ref, undefined);
    const conditional = items.flatMap((x, i) => (x && out[i].allowed && out[i].residual.op !== 'true' && x.ref.id !== undefined ? [i] : []));
    if (conditional.length > 0) {
      const rows = await this.loadRows(conditional.map((i) => items[i]!.ref));
      for (const i of conditional) {
        const { def, ref } = items[i]!;
        const got = rows.get(resourceKey(ref));
        if (got === undefined) continue;
        if (got.kind === 'failed') out[i] = deniedCopy(out[i], ENGINE_FAULT);
        else if (got.kind === 'missing') out[i] = deniedCopy(out[i], UNKNOWN_RESOURCE);
        else out[i] = await check(def, ref, got.row);
      }
    }
    return Object.freeze(out);
  }

  /** The denial checkAll answers for an entry check() would throw on (UnknownPermission, AuthzConfigError). */
  private invalidRequest(principal: unknown, permission: unknown, ref: ResourceRef): Decision {
    const gate = principalGate(principal);
    const who = gate.kind === 'system' ? SYSTEM_REF : gate.kind === 'deny' ? gate.principal : gate.ref;
    return deepFreeze({ allowed: false, permission: String(permission), resource: ref, principal: who, residual: FALSE, fields: NO_FIELDS, roles: NO_ROLES, reason: { ...INVALID_REQUEST }, domain: this.domain });
  }

  async filter(principal: Principal, permission: Permission, type: ResourceType, scope?: RequestScope): Promise<ResourceFilter> {
    return (await this.check({ principal, permission, resource: { type } }, scope)).residual;
  }

  /** `undefined` when some step needs IO. */
  filterNow(principal: Principal, permission: Permission, type: ResourceType, scope?: RequestScope): ResourceFilter | undefined {
    return runSync(this.pipeline({ principal, permission, resource: { type } }, this.newRun(true, scope)))?.value.decision.residual;
  }

  /**
   * B25: a quiet check per candidate permission at `at`. Candidates are the names the routed models' summaries
   * list, or every permission checkable at `at` when a routed model gives no summary. A denied check still gives a
   * conditional entry when a summary entry left by the ceilings lists the name, since a check at `$global` misses
   * grants below it. A check that throws, rests on an engine fault or misses the deadline leaves its permission out.
   */
  async summary(principal: Principal, at: ResourceRef = GLOBAL, scope?: RequestScope): Promise<AccessSummary> {
    const ref = this.requireRef(at);
    this.refuseLateType(ref.type);
    const gate = principalGate(principal);
    if (gate.kind === 'deny') return deepFreeze({ principal: gate.principal, models: [], permissions: [] });
    const { defs } = this.checkable(ref, 'summary');
    if (gate.kind === 'system') return deepFreeze({ principal: SYSTEM_REF, models: [], permissions: defs.map((def) => summaryEntry(def, false, this.engine.allFields)) });

    const run = this.quietRun(scope);
    const limit = new Deadline(DEADLINE_FACTOR * this.engine.config.modelTimeoutMs);
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
      if (faulted.length > 0) logAt(this.engine, 'error', { count: faulted.length, permissions: faulted.slice(0, 10), truncated: faulted.length > 10 ? true : undefined }, 'Authz domain ${domain}: summary left out ${count} permission(s) whose decision rests on an engine fault: ${permissions}${?truncated}, …${/truncated}');
      out.permissions = candidates.flatMap((def, i) => {
        const c = checked[i];
        if (c === undefined || c === THREW || c.faulted) return [];
        if (c.decision.allowed) return [summaryEntry(def, c.decision.residual.op !== 'true', c.decision.fields)];
        const entries = listed.get(def.name);
        if (entries === undefined) return [];
        try {
          return [summaryEntry(def, true, def.fields === true ? this.listedFields(entries) : NO_FIELDS)];
        } catch (e) {
          logAt(this.engine, 'error', { error: thrownError(e), permission: def.name }, 'Authz domain ${domain}: summary left out ${permission}: the fields its model summaries list could not be combined');
          return [];
        }
      });
      return deepFreeze(out);
    } finally {
      limit.clear();
    }
  }

  /** The path a check of `ref` walks: `[ref, ...ancestors, GLOBAL]`; null for an unknown resource. */
  async ancestors(ref: ResourceRef, scope?: RequestScope): Promise<readonly ResourceRef[] | null> {
    const r = this.requireRef(ref);
    this.refuseLateType(r.type);
    return await this.ancestorsOf(r, scope?.cache ?? new Map<string, unknown>());
  }

  /**
   * B26: the holder's combined set at `at` strictly contains the target's. At `$global` both are also checked on
   * each type of the permission, since `$global` does not speak for the rows below it. Asymmetric, so a summary can
   * only shrink what the holder covers: the target's set adds its routed models' summary entries (after its
   * ceilings), which only an unconditional holder with those fields covers; the holder's fields are those of its
   * unconditional permits (`firmFields`). The target's denies never drop an entry: a deny may rest on session facts
   * that change under impersonation. Fails closed on a custom combinator, a refused principal, a routed model
   * without a summary, a thrown or faulted check, and past the deadline.
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
      logAt(this.engine, 'error', { permission: custom.def.name, resourceType: custom.type, algorithm: custom.algorithm }, 'Authz domain ${domain}: covers is false: ${permission} on ${resourceType} uses the combinator ${algorithm}, which may allow without a permit that a summary lists');
      return false;
    }
    const limit = new Deadline(DEADLINE_FACTOR * this.engine.config.modelTimeoutMs);
    let strict = false;
    try {
      const summarized = await limit.race(this.modelSummaries(target, ref, defs, { ...run, nested: newNested() }));
      if (summarized === EXPIRED) {
        logAt(this.engine, 'error', { deadlineMs: limit.ms }, 'Authz domain ${domain}: covers is false: it ran past its deadline of ${deadlineMs} ms');
        return false;
      }
      if (summarized.names === undefined) {
        logAt(this.engine, 'error', {}, 'Authz domain ${domain}: covers is false: a model routed for the target gave no summary');
        return false;
      }
      const listed = this.summaryEntries(target, summarized.list, defs, run.instant);
      if (listed === undefined) {
        logAt(this.engine, 'error', {}, 'Authz domain ${domain}: covers is false: the onBehalfOf chain of the target does not resolve');
        return false;
      }
      for (let i = 0; i < defs.length; i += SUMMARY_BATCH) {
        const batch = defs.slice(i, i + SUMMARY_BATCH);
        const compared = await limit.race(Promise.all(batch.map((def) => Promise.all(comparedRefs(def, ref).map((r) => Promise.all([this.quietCheck(holder, def, r, run, true), this.quietCheck(target, def, r, run)]))))));
        if (compared === EXPIRED) {
          logAt(this.engine, 'error', { deadlineMs: limit.ms }, 'Authz domain ${domain}: covers is false: it ran past its deadline of ${deadlineMs} ms');
          return false;
        }
        for (const [k, pairs] of compared.entries()) {
          const def = batch[k];
          // A denial on missing data is no proof that the target lacks the permission; a holder fault is refused too, to stay simple.
          const fault = pairs.find(([h, t]) => h.faulted || t.faulted);
          if (fault) {
            logAt(this.engine, 'error', { side: fault[0].faulted ? 'holder' : 'target', permission: def.name }, 'Authz domain ${domain}: covers is false: the ${side} check of ${permission} rests on an engine fault');
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
      logAt(this.engine, 'error', { error: thrownError(e) }, 'Authz domain ${domain}: covers is false: a check or a field comparison failed');
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
      let hopsLeft = this.engine.config.maxDelegation;
      while (next !== undefined) {
        const gate = principalGate(next);
        if (gate.kind !== 'run') break;
        const d = resolveDelegation(gate.principal, undefined, hopsLeft);
        if (d.denial) break;
        runAs.push({ who: d.principal, cacheId: principalCacheId(d.principal) });
        next = d.intersect;
        hopsLeft -= d.hopsUsed;
      }
    } catch (e) {
      // A check of this principal throws too, so no model would run.
      logAt(this.engine, 'error', { error: thrownError(e) }, 'Authz domain ${domain}: preload could not resolve the onBehalfOf chain, preloading nothing');
      return;
    }
    const map = scopeMap(scope);
    const instant = now(this.engine);
    // A version change first, so the scope is born with the generation its data belongs to.
    epoch(this.engine);
    bornOf(this.engine, map);
    const generation = this.engine.generation;
    const failed = new Set<string>();
    await Promise.all(
      this.engine.modelList.flatMap((model) =>
        typeof model.preload !== 'function'
          ? []
          : runAs.map(async ({ who, cacheId }) => {
              const settled = await settleWithin(
                Promise.resolve().then(() => model.preload!(who, new ModelContext(this.host, model.name, map, instant, 0, undefined, contextCacheKey(model.name, cacheId)))),
                this.engine.config.modelTimeoutMs,
                describeError,
                'preload',
              );
              if (settled.ok) return;
              failed.add(cacheId);
              // The model may now vote from missing per-request state.
              markFault(this.engine, map);
              logAt(this.engine, 'error', { model: model.name, cause: settled.error }, 'Authz domain ${domain}: model ${model} failed to preload: ${cause}');
            }),
      ),
    );
    // An invalidate() during the preload may have dropped what it loaded.
    if (this.engine.generation !== generation) return;
    for (const { cacheId } of runAs) {
      if (failed.has(cacheId)) continue;
      map.set(l1Key('preloaded', this.domain, cacheId), generation);
      this.preloaded.delete(cacheId);
      this.preloaded.set(cacheId, generation);
      if (this.preloaded.size > MAX_PRELOADED) this.preloaded.delete(this.preloaded.keys().next().value!);
    }
  }

  invalidate(tags: readonly string[]): void {
    this.engine.generation = nextGeneration();
    this.preloaded.clear();
    invalidateL2(this.engine, invalidationTags(tags));
    const copy = Object.freeze(Array.isArray(tags) ? [...tags] : []);
    for (const model of this.engine.modelList) {
      try {
        if (typeof model.invalidate === 'function') model.invalidate(copy);
      } catch (e) {
        logAt(this.engine, 'error', { error: thrownError(e), model: model.name }, 'Authz domain ${domain}: model ${model} failed to invalidate');
      }
    }
  }

  models(): readonly AuthorizationModel[] {
    return this.engine.modelList;
  }

  routes(): RouteTable {
    return this.engine.table;
  }

  // ---- summary and covers ----

  /** The principal gate lets `p` run models and its onBehalfOf chain resolves without a denial or a throw. */
  private admitted(p: unknown): boolean {
    const gate = principalGate(p);
    if (gate.kind !== 'run') return false;
    try {
      return this.delegation(gate.principal, undefined, this.engine.config.maxDelegation).denial === undefined;
    } catch (e) {
      logAt(this.engine, 'debug', { error: thrownError(e), principal: principalKey(gate.ref) }, 'Authz domain ${domain}: covers is false: the onBehalfOf chain of ${principal} does not resolve');
      return false;
    }
  }

  /** The base run of one summary or covers call: one instant, version vector and generation for every check; never audited. */
  private quietRun(scope: RequestScope | undefined): Run {
    return { ...this.newRun(false, scope), quiet: true };
  }

  /** Registered permissions checkable at `ref` (its type in `types`, or `$global`), sorted by name, at most MAX_SUMMARY_PERMISSIONS. */
  private checkable(ref: ResourceRef, what: string): { readonly defs: readonly PermissionDef[]; readonly truncated: boolean } {
    const defs = this.engine.registry
      .all()
      .filter((d) => ref.type === GLOBAL_TYPE || d.types.includes(ref.type))
      .sort((a, b) => compareStrings(a.name, b.name));
    if (defs.length <= MAX_SUMMARY_PERMISSIONS) return { defs, truncated: false };
    logAt(this.engine, 'warn', { operation: what, resource: resourceKey(ref), count: defs.length, limit: MAX_SUMMARY_PERMISSIONS }, 'Authz domain ${domain}: ${operation} at ${resource} has ${count} permissions to check, more than the limit of ${limit}');
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
      const d = this.delegation(principal, undefined, this.engine.config.maxDelegation);
      // Every check denies `delegate` then.
      if (d.denial) return { list: [], names: undefined };
      runAs = d.principal;
    } catch (e) {
      logAt(this.engine, 'error', { error: thrownError(e) }, 'Authz domain ${domain}: summary could not resolve the onBehalfOf chain');
      return { list: [], names: undefined };
    }
    const routed = new Set<AuthorizationModel>();
    for (const def of defs) {
      // A check at $global is concrete: the models routed for the permission's types hold what lies below it.
      for (const type of ref.type === GLOBAL_TYPE ? [ref.type, ...def.types] : [ref.type]) for (const m of this.engine.table.get(def.name, type)?.models ?? []) routed.add(m);
    }
    const host = this.hostFor(run);
    const cacheId = principalCacheId(runAs);
    let complete = true;
    const results = await Promise.all(
      this.engine.modelList
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
              this.engine.config.modelTimeoutMs,
              describeError,
              'summarize',
            );
            if (!settled.ok) throw new Error(settled.error);
            return copySummary(settled.value, model.name);
          } catch (e) {
            complete = false;
            logAt(this.engine, 'error', { error: thrownError(e), model: model.name }, 'Authz domain ${domain}: model ${model} failed to summarize, left out');
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
    if (failed > 0) logAt(this.engine, 'error', { error: thrownError(first), count: failed }, 'Authz domain ${domain}: summary left out ${count} permission(s) whose check threw; the error is the first');
    const unchecked = out.filter((c) => c === undefined).length;
    if (unchecked > 0) logAt(this.engine, 'error', { count: unchecked, deadlineMs: limit.ms }, 'Authz domain ${domain}: summary left out ${count} permission(s) not checked within its deadline of ${deadlineMs} ms');
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
      const d = this.delegation(principal, undefined, this.engine.config.maxDelegation);
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
    const union = (k: 'read' | 'write') => subtractFieldGlobs(unionFieldGlobs(...entries.map((e) => e.fields?.[k] ?? ['*'])), this.engine.config.neverRead);
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
    const inside = (k: 'read' | 'write') => subtractFieldGlobs(subtractFieldGlobs(entry.fields?.[k] ?? ['*'], this.engine.config.neverRead), held[k]).length === 0;
    return inside('read') && inside('write');
  }

  /** The first route plan of `defs` at `ref` (at `$global`, also on each type) whose algorithm is not built in. */
  private customPlan(defs: readonly PermissionDef[], ref: ResourceRef): { readonly def: PermissionDef; readonly type: ResourceType; readonly algorithm: string } | undefined {
    for (const def of defs) {
      for (const r of comparedRefs(def, ref)) {
        const algorithm = this.engine.table.get(def.name, r.type)?.algorithm;
        if (algorithm !== undefined && !BUILTIN_ALGORITHMS.has(algorithm)) return { def, type: r.type, algorithm };
      }
    }
    return undefined;
  }

  // ---- accessPlan ----

  /** undefined when nothing may be cached for this call (a model version() that fails, a principal without canonical state). */
  private planKey(principal: Principal, def: PermissionDef, type: ResourceType, run: Run): string | undefined {
    if (run.versions === undefined) return undefined;
    const state = principalState(principal);
    return state === undefined ? undefined : l1Key('plan', this.domain, JSON.stringify([state, def.name, type, run.versions]));
  }

  private cachedPlan(key: string, run: Run): AccessPlan | undefined {
    const entry = run.scope.get(key);
    if (!(entry instanceof CachedPlan) || entry.generation !== this.engine.generation) return undefined;
    const until = entry.plan.kind === 'filter' ? entry.plan.validUntil : undefined;
    return until !== undefined && until.getTime() <= run.instant.getTime() ? undefined : entry.plan;
  }

  private async buildPlan(d: Delegation, def: PermissionDef, type: ResourceType, env: Readonly<Record<string, unknown>>, run: Run): Promise<{ readonly plan: AccessPlan; readonly faulted: boolean }> {
    const ceiling = this.ceilingOf(d, def, { type }, undefined, run.instant);
    if (ceiling.denials.length > 0) return { plan: nonePlan([...ceiling.denials].sort(compareDenyReasons)[0]), faulted: false };
    const within = withinOf(ceiling.restrict);
    if (within === null) return { plan: nonePlan(CEILING_DENIAL), faulted: false };
    const route = this.engine.table.get(def.name, type) ?? { algorithm: 'deny-overrides', models: [] };
    if (route.algorithm !== 'deny-overrides') throw new AuthzConfigError(`${this.engine.where}: list permission ${quote(def.name)} is routed on type ${quote(type)} with ${quote(route.algorithm)}; access plans combine with deny-overrides only (boot rule 12)`);
    const runAs = d.principal;
    const fresh = run.fresh === true ? { fresh: true } : {};
    const req: ListPlanRequest = Object.freeze(d.actor === undefined ? { principal: runAs, permission: def, type, env, ...fresh } : { principal: runAs, actor: d.actor, permission: def, type, env, ...fresh });
    const host = this.hostFor(run);
    const cacheId = principalCacheId(runAs);
    const label = `${def.name} on ${quote(type)}`;
    const answers = await Promise.all(route.models.filter((m) => admits(m, runAs)).map((m) => this.modelPlan(m, req, new ModelContext(host, m.name, run.scope, run.instant, 0, undefined, contextCacheKey(m.name, cacheId, 'listPlan')), label)));
    const bounds = { ...(within ? { within } : {}), ...(ceiling.expiresAt ? { validUntil: ceiling.expiresAt } : {}) };
    return { plan: combinePlans(answers, bounds), faulted: answers.some((a) => a.faulted) || run.nested.faulted };
  }

  /** A failure, a timeout, a ctx fault or a malformed plan is a deny-all with model_error: fail closed like an indeterminate vote (B04). */
  private async modelPlan(model: AuthorizationModel, req: ListPlanRequest, ctx: ModelContext, label: string): Promise<PlanAnswer & { readonly faulted: boolean }> {
    let support: unknown;
    try {
      support = typeof model.listSupport === 'function' ? model.listSupport(req.permission, req.type, { relation: (type, name) => this.relation(type, name) }) : undefined;
    } catch (e) {
      throw new AuthzConfigError(`${this.engine.where}: model ${quote(model.name)} threw from listSupport() for ${label}: ${describeError(e)}`, { cause: e });
    }
    if (support !== true || typeof model.listPlan !== 'function') throw new AuthzConfigError(`${this.engine.where}: model ${quote(model.name)} cannot plan lists of ${label} (boot rule 12)`);
    const settled = await settleWithin(
      Promise.resolve().then(() => model.listPlan!(req, ctx)),
      this.engine.config.modelTimeoutMs,
      describeError,
      'listPlan',
    );
    let fault: string | undefined;
    let plan: ModelListPlan | undefined;
    if (!settled.ok) fault = settled.error;
    else if (ctx.fault !== undefined) fault = ctx.fault;
    else {
      try {
        plan = readModelPlan(settled.value);
      } catch (e) {
        fault = `listPlan returned a malformed plan: ${describeError(e)}`;
      }
    }
    if (plan !== undefined) return { model: model.name, plan, faulted: false };
    logAt(this.engine, 'error', { model: model.name, check: label, cause: fault }, 'Authz domain ${domain}: model ${model} failed to plan ${check}: ${cause}');
    ctx.detachMemo();
    return { model: model.name, plan: Object.freeze({ kind: 'deny-all', reason: Object.freeze({ code: 'model_error', model: model.name }) }), faulted: true };
  }

  // ---- checkAll ----

  /** One ancestorsMany call per type for the refs with an id the L1 lacks; a failure leaves them to ancestors() per ref. */
  private async prefillAncestors(refs: readonly ResourceRef[], scope: Map<string, unknown>): Promise<void> {
    const pending = refs.filter((r) => r.id !== undefined && !scope.has(l1Key('ancestors', this.domain, resourceKey(r))));
    await Promise.all(
      [...byType(pending)].map(async ([type, list]) => {
        const adapter = this.engine.adapterByType.get(type);
        if (!adapter || typeof adapter.ancestorsMany !== 'function') return;
        const settled = await settleWithin(
          Promise.resolve().then(() => adapter.ancestorsMany!(list)),
          this.engine.config.modelTimeoutMs,
          describeError,
          'ancestorsMany',
        );
        if (!settled.ok || !(settled.value instanceof Map)) {
          logAt(this.engine, 'error', { adapter: adapter.kind, count: list.length, resourceType: type, cause: settled.ok ? 'it did not return a Map' : settled.error }, 'Authz domain ${domain}: ancestorsMany of adapter ${adapter} for ${count} ${resourceType} ref(s) failed, asking ancestors() per ref: ${cause}');
          return;
        }
        const found = settled.value as ReadonlyMap<string, unknown>;
        for (const ref of list) {
          const key = resourceKey(ref);
          try {
            scope.set(l1Key('ancestors', this.domain, key), this.ancestorList(found.get(key) ?? null, ref));
          } catch (e) {
            logAt(this.engine, 'error', { error: thrownError(e), adapter: adapter.kind, resource: key }, 'Authz domain ${domain}: ancestorsMany of adapter ${adapter} answered a malformed list for ${resource}, asking ancestors()');
          }
        }
      }),
    );
  }

  /** Rows by resourceKey; a type whose adapter has neither loadMany nor load is left out. */
  private async loadRows(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, RowLoad>> {
    const out = new Map<string, RowLoad>();
    const rowOf = (v: unknown): RowLoad => (v === undefined || v === null ? MISSING_ROW : { kind: 'row', row: v });
    await Promise.all(
      [...byType(refs)].map(async ([type, list]) => {
        const adapter = this.engine.adapterByType.get(type);
        if (adapter && typeof adapter.loadMany === 'function') {
          const settled = await settleWithin(
            Promise.resolve().then(() => adapter.loadMany!(list)),
            this.engine.config.modelTimeoutMs,
            describeError,
            'loadMany',
          );
          const found = settled.ok && settled.value instanceof Map ? (settled.value as ReadonlyMap<string, unknown>) : undefined;
          if (!found) logAt(this.engine, 'error', { adapter: adapter.kind, count: list.length, resourceType: type, cause: settled.ok ? 'it did not return a Map' : settled.error }, 'Authz domain ${domain}: loadMany of adapter ${adapter} for ${count} ${resourceType} row(s) failed: ${cause}');
          for (const ref of list) out.set(resourceKey(ref), found ? rowOf(found.get(resourceKey(ref))) : FAILED_ROW);
        } else if (adapter && typeof adapter.load === 'function') {
          await Promise.all(
            list.map(async (ref) => {
              const settled = await settleWithin(
                Promise.resolve().then(() => adapter.load!(ref)),
                this.engine.config.modelTimeoutMs,
                describeError,
                'load',
              );
              if (!settled.ok) logAt(this.engine, 'error', { resource: resourceKey(ref), adapter: adapter.kind, cause: settled.error }, 'Authz domain ${domain}: load of ${resource} from adapter ${adapter} failed: ${cause}');
              out.set(resourceKey(ref), settled.ok ? rowOf(settled.value) : FAILED_ROW);
            }),
          );
        }
      }),
    );
    return out;
  }

  // ---- the check pipeline (design §10.1) ----

  /** `resolved`: a ref (and subject) the caller already resolved, so no adapter sees it again. */
  private *pipeline(input: CheckInput, run: Run, resolved?: { readonly ref: ResourceRef; readonly subject: unknown }): Pipeline<Checked> {
    const started = performance.now();
    if (!isObject(input)) throw new AuthzConfigError(`${this.engine.where}: check input must be an object`);
    const explain = run.depth === 0 && input.explain === true;
    if (explain) run = { ...run, bypass: true };
    const steps: TraceStep[] | undefined = explain || this.engine.config.explain ? [] : undefined;
    // Engine-owned data goes in as is (frozen with the trace), so a deep residual is never cut.
    const core = (step: string, note: string, data?: unknown) => steps?.push(data === undefined ? { by: CORE, step, note } : { by: CORE, step, note, data });

    const def = this.requirePermission(input.permission);
    if (input.fresh !== undefined && typeof input.fresh !== 'boolean') throw new AuthzConfigError(`${this.engine.where}: fresh must be a boolean`);
    if (input.fresh === true || def.consistency === 'fresh') run = { ...run, fresh: true };
    const { ref, subject } = resolved ?? (yield* this.resolveResource(input.resource, input.subject, def));
    this.refuseLateType(ref.type);
    if (ref.type !== GLOBAL_TYPE && !def.types.includes(ref.type)) {
      throw new AuthzConfigError(`${this.engine.where}: permission ${quote(def.name)} is checked on type ${quote(ref.type)}, which is not in its types (${def.types.join(', ')}) or $global`);
    }
    core('resource', resourceKey(ref));
    const plan = this.engine.table.get(def.name, ref.type) ?? { algorithm: 'deny-overrides', models: [] };
    const base = { def, ref, algorithm: plan.algorithm, run, explain, steps, started };

    const gate = principalGate(input.principal);
    if (gate.kind === 'system') {
      core('principal', 'SYSTEM: allowed without models');
      return { decision: finish(this.engine, { ...base, requester: SYSTEM_REF, system: true }, { principal: SYSTEM_REF, residual: TRUE, roles: NO_ROLES, fields: this.engine.allFields, models: [], votes: [] }), uncacheable: true, faulted: false, ...(run.firm ? { firmFields: this.engine.allFields } : {}) };
    }
    if (gate.kind === 'deny') {
      core('principal', `denied before the models: ${gate.reason.code}`);
      return { decision: finish(this.engine, { ...base, requester: gate.principal }, coreDenial(gate.principal, gate.reason)), uncacheable: false, faulted: false };
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
    if (keyed && key === undefined) logAt(this.engine, 'debug', { permission: def.name, principal: principalKey(requester) }, 'Authz domain ${domain}: ${permission} for ${principal} is not cached: the principal or actor has no canonical state');

    let ancestors: readonly ResourceRef[] | undefined;
    if (ref.id !== undefined) {
      const list = (yield this.ancestorsOf(ref, run.scope)) as readonly ResourceRef[] | null;
      if (list === null) {
        core('resource', 'unknown resource: ancestors answered null');
        // No revocation tag reaches a resource that does not exist yet: a decision resting on this one is not cached.
        if (run.depth > 0) run.nested.uncacheable = true;
        return { decision: finish(this.engine, { ...base, requester }, parties ? partiesDenial(parties, { code: 'unknown_resource' }) : coreDenial(requester, { code: 'unknown_resource' })), uncacheable: false, faulted: false };
      }
      ancestors = list;
    }

    if (!parties) {
      core('delegation', 'denied before the models: a forbidden or unreadable delegate');
      return { decision: finish(this.engine, { ...base, requester }, coreDenial(requester, delegation.denial!)), uncacheable: false, faulted: false };
    }

    // Step 6.
    const principals: Principal[] = [gate.principal, ...delegation.chain];
    if (actor !== undefined) principals.push(actor);
    if (delegation.actor !== undefined) principals.push(delegation.actor);
    const tags = once(() => tagsOf(this.engine, plan.models, principals, ref, ancestors, run));
    if (key !== undefined && run.firm !== true && run.fresh !== true) {
      const hit = cached(this.engine, key, run, def, ref, requester, parties.ref);
      if (hit) return hit;
      Perf.count('authz.cache.miss');
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
    const request = () => this.request(parties, def, ref, subject, input.env, run.instant, explain, run.fresh === true);
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
      // A kept principalInArgs native is evaluated below and in SQL with our principal, context and ctx.cache: right only because its args name the delegate and the filter keys its memos by them.
      let theirs = !delegate.allowed ? FALSE : strips ? stripPrincipalOps(delegate.residual, this.engine.argBoundNatives) : delegate.residual;
      if (strips && subject !== undefined && delegate.allowed && residual.op !== 'false') {
        // The filter strips the delegate's relation ops and its natives without principalInArgs, which the subject check above evaluated exactly: the row must also pass the stripped type-level residual, or filter and check part (B06).
        typeLevel = yield* this.delegateCheck(delegation.intersect!, delegation.hopsUsed, def, { type: ref.type }, undefined, input.env, run);
        const strip = typeLevel.decision.allowed ? stripPrincipalOps(typeLevel.decision.residual, this.engine.argBoundNatives) : FALSE;
        let truth: string = !typeLevel.decision.allowed ? 'the delegate is denied' : strip.op === 'true' ? 'TRUE' : 'FALSE';
        let holds = strip.op === 'true';
        if (strip.op !== 'true' && strip.op !== 'false') {
          const settled = (yield settleWithin(evaluateResidual(strip, subject, this.subjectEnv(parties, ref, run, steps, cores)), this.engine.config.modelTimeoutMs, describeError, 'subject evaluation')) as Settled;
          if (!settled.ok) {
            subjectFault = true;
            logAt(this.engine, 'error', { delegate: delegation.intersectKey, check: label, cause: settled.error }, 'Authz domain ${domain}: evaluating the stripped type-level residual of the delegate ${delegate} of ${check} against the subject failed: ${cause}');
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
      const settled = (yield settleWithin(evaluateResidual(residual, subject, this.subjectEnv(parties, ref, run, steps, cores)), this.engine.config.modelTimeoutMs, describeError, 'subject evaluation')) as Settled;
      const truth = settled.ok ? settled.value : undefined;
      if (!settled.ok) {
        subjectFault = true;
        logAt(this.engine, 'error', { check: label, cause: settled.error }, 'Authz domain ${domain}: evaluating the residual of ${check} against the subject failed: ${cause}');
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
    const faulted = votes.some((v) => v.error !== undefined) || voteLoads.degraded || combined.failed || bound.failed || bound.degraded || subjectFault || fieldsFaulted || delegated?.faulted === true || typeLevel?.faulted === true || run.nested.faulted || scopeFaulted(this.engine, run.scope);
    if (faulted) {
      run.nested.faulted = true;
      // A model may memoise a nested answer in ctx.cache; the marker stops later checks of the request trusting it.
      if (run.depth > 0) markFault(this.engine, run.scope);
      // A marker here would fail every later summary/covers of the request; dropping the memos this decision wrote is enough.
      else for (const ctx of [...contexts.slice(0, votes.length), ...cores]) ctx.detachMemo();
    }
    const uncacheable = faulted || bound.uncacheable || fieldsUncacheable || reasonsUncacheable || delegated?.uncacheable === true || typeLevel?.uncacheable === true || votes.some((v) => v.cacheable !== true) || run.nested.uncacheable;
    return remember(this.engine, { decision: finish(this.engine, { ...base, requester }, outcome), uncacheable, faulted, ...(firmFields ? { firmFields } : {}) }, key, run, tags);
  }

  // ---- L1/L2 lookup and store (design §10.3) ----

  /**
   * The context host of one call tree: a model's ctx.check shares its versions,
   * generation, nested record and cache bypass. A failed (or, for attributes,
   * timed-out) call marks the tree faulted even when the model catches it; a
   * rejection also marks the request, as nothing else records it.
   */
  private hostFor(run: Run): ContextHost {
    const fault = (e: unknown): never => {
      run.nested.faulted = true;
      markFault(this.engine, run.scope);
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
      nestedCheck: (req: Omit<DecisionRequest, 'explain'>, scope: Map<string, unknown>, instant: Date, depth: number) => runAsync(this.pipeline(req, { ...run, sync: false, scope, instant, depth, delegationBudget: this.engine.config.maxDelegation })).then((r) => r.decision, fault),
    });
  }

  private *resolveResource(resource: unknown, subject: unknown, def: PermissionDef): Pipeline<{ readonly ref: ResourceRef; readonly subject: unknown }> {
    if (resource === undefined) return { ref: Object.freeze({ type: def.resource }), subject };
    const resolved = yield* this.resolveObject(resource);
    return { ref: resolved.ref, subject: subject === undefined ? resolved.subject : subject };
  }

  private *resolveObject(resource: unknown): Pipeline<{ readonly ref: ResourceRef; readonly subject: unknown }> {
    if (!isObject(resource)) throw new AuthzConfigError(`${this.engine.where}: a resource must be a ResourceRef or an object an adapter accepts, got ${resource === null ? 'null' : typeof resource}`);
    for (const adapter of this.engine.adapterList) {
      if (adapter.accepts(resource) !== true) continue;
      const ref = copyRef(yield adapter.refOf(resource));
      if (!ref) throw new AuthzConfigError(`${this.engine.where}: adapter ${quote(adapter.kind)} returned a malformed ref from refOf()`);
      return { ref, subject: resource };
    }
    const ref = refShaped(resource);
    if (!ref) throw new AuthzConfigError(`${this.engine.where}: the resource is neither accepted by an adapter nor a ResourceRef ({ type, id? } with a string id or null)`);
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
    if (scope.get(l1Key('preloaded', this.domain, cacheId)) === this.engine.generation) return true;
    if (this.preloaded.get(cacheId) !== this.engine.generation) return false;
    this.preloaded.delete(cacheId);
    this.preloaded.set(cacheId, this.engine.generation);
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
      logAt(this.engine, 'error', { error: thrownError(e), check: label }, 'Authz domain ${domain}: loading the scope attributes of the votes of ${check} failed');
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
      logAt(this.engine, 'error', { model: v.model, check: label, cause: fault }, 'Authz domain ${domain}: model ${model} is indeterminate for ${check}: ${cause}');
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
    return settleWithin(raw as PromiseLike<unknown>, this.engine.config.modelTimeoutMs, describeError, 'evaluate').then((s) => this.accept(model, ctx, s.ok ? { raw: s.value } : { fault: s.error }, label));
  }

  /** Step 9: vote hygiene. */
  private accept(model: AuthorizationModel, ctx: ModelContext, result: { readonly raw: unknown } | { readonly fault: string }, label: string): Vote {
    let vote = 'fault' in result ? faultVote(model.name, result.fault) : sanitizeVote(result.raw, model.name, capabilitiesOf(model));
    if (vote.error === undefined && ctx.fault !== undefined) vote = faultVote(model.name, ctx.fault);
    if (vote.error !== undefined) logAt(this.engine, 'error', { model: model.name, check: label, cause: vote.error }, 'Authz domain ${domain}: model ${model} is indeterminate for ${check}: ${cause}');
    return vote;
  }

  /** Step 10. */
  private combine(algorithm: string, votes: readonly Vote[]): Combined {
    try {
      const combinator = this.engine.combinators.get(algorithm);
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
      logAt(this.engine, 'error', { error: thrownError(e), algorithm }, 'Authz domain ${domain}: combinator ${algorithm} failed');
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
      logAt(this.engine, 'error', { error: thrownError(e) }, 'Authz domain ${domain}: binding refs failed');
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
    return bounded(() => load.result, this.engine.config.modelTimeoutMs).then((r): BoundAttributes => {
      if (r.kind === 'value') return { ...(r.value as LoadedAttributes), failed: false };
      if (r.kind === 'error') logAt(this.engine, 'error', { error: thrownError(r.error), resource: resourceKey(node) }, 'Authz domain ${domain}: scope attributes of ${resource} failed; its refs bind as missing');
      else this.logTimeout(load, { resource: resourceKey(node), timeoutMs: this.engine.config.modelTimeoutMs }, 'Authz domain ${domain}: scope attributes of ${resource} timed out after ${timeoutMs} ms; its refs bind as missing');
      return { attributes: null, failed: r.kind === 'error', degraded: true };
    });
  }

  private logTimeout(load: NodeLoad, fields: Record<string, unknown>, template: string): void {
    if (load.timeoutLogged) return;
    load.timeoutLogged = true;
    logAt(this.engine, 'error', fields, template);
  }

  /** Throws AuthzConfigError for a malformed actor and for a chain deeper than the budget or with a cycle (B08). */
  private delegation(principal: Principal, actor: unknown, budget: number): Delegation {
    if (actor !== undefined && (!isObject(actor) || typeof actor.type !== 'string' || typeof actor.id !== 'string')) throw new AuthzConfigError(`${this.engine.where}: actor must be a principal`);
    try {
      return resolveDelegation(principal, actor as Principal | undefined, budget);
    } catch (e) {
      if (e instanceof AuthzConfigError) throw new AuthzConfigError(`${this.engine.where}: ${e.message}`, { cause: e });
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
      logAt(this.engine, 'error', { error: thrownError(e), check: label }, 'Authz domain ${domain}: loading the scope attributes of the field sets of ${check} failed');
      uncacheable = true;
      faulted = true;
    }
    try {
      const own = this.engine.fieldCombiner.combine(algorithm, votes, (f) => binder.bind(f));
      const fields = delegate ? this.engine.fieldCombiner.intersect(own, delegate) : own;
      if (!firm) return { fields, failed: false, faulted, uncacheable };
      const firmOwn = this.engine.fieldCombiner.combine(algorithm, votes, (f) => binder.bind(f), true);
      return { fields, firm: firm.delegate ? this.engine.fieldCombiner.intersect(firmOwn, firm.delegate) : firmOwn, failed: false, faulted, uncacheable };
    } catch (e) {
      if (!(e instanceof AuthzConfigError)) throw e;
      logAt(this.engine, 'error', { error: thrownError(e), check: label }, 'Authz domain ${domain}: combining the field sets of ${check} failed');
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
      logAt(this.engine, 'error', { error: thrownError(e), check: label }, 'Authz domain ${domain}: loading the scope attributes of the deny reasons of ${check} failed');
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
    const left = Math.max(0, this.engine.config.modelTimeoutMs - (performance.now() - started));
    const settled = (yield settleWithin(batch, left, describeError, 'deny reason pass')) as Settled;
    if (!settled.ok) {
      logAt(this.engine, 'error', { check: label, cause: settled.error }, 'Authz domain ${domain}: evaluating the deny reasons of ${check} against the subject failed: ${cause}; using static truths');
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

  // ---- context services ----

  private request(parties: Parties, def: PermissionDef, ref: ResourceRef, subject: unknown, env: unknown, instant: Date, explain: boolean, fresh: boolean): DecisionRequest {
    const req: { -readonly [K in keyof DecisionRequest]: DecisionRequest[K] } = { principal: parties.principal, permission: def.name, resource: ref, env: this.envOf(env, instant), explain };
    if (parties.actor) req.actor = parties.actor;
    if (subject !== undefined) req.subject = subject;
    if (fresh) req.fresh = true;
    return Object.freeze(req);
  }

  /** A fresh frozen env per use; `now` from the clock always wins. */
  private envOf(env: unknown, instant: Date): Readonly<Record<string, unknown>> {
    if (env !== undefined && (!isObject(env) || Array.isArray(env))) throw new AuthzConfigError(`${this.engine.where}: env must be an object`);
    return Object.freeze({ ...env, now: new Date(instant.getTime()) });
  }

  /** `cores` gets the env's context. */
  private subjectEnv(parties: Parties, ref: ResourceRef, run: Run, steps: TraceStep[] | undefined, cores: ModelContext[]): SubjectEnv {
    const adapter = this.engine.adapterByType.get(ref.type);
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
        const filter = this.engine.natives.get(op);
        return filter && detachingOnThrow(filter, ctx);
      },
      ctx,
    };
  }

  private relation(type: ResourceType, name: string): RelationResolver | undefined {
    return this.engine.relationIndex.get(`${type}\u0000${name}`);
  }

  /** Step 5 and ctx.ancestors: memoised in L1; sync for refs that need no IO. */
  private ancestorsOf(ref: ResourceRef, scope: Map<string, unknown>): MaybePromise<readonly ResourceRef[] | null> {
    return memo(scope, l1Key('ancestors', this.domain, resourceKey(ref)), () => this.loadAncestors(ref));
  }

  private loadAncestors(ref: ResourceRef): MaybePromise<readonly ResourceRef[] | null> {
    if (ref.type === GLOBAL_TYPE && ref.id === undefined) return GLOBAL_ANCESTORS;
    if (ref.id === undefined) return Object.freeze([ref, GLOBAL]);
    const adapter = this.engine.adapterByType.get(ref.type);
    // An ancestor or scope node a model reads, not only the checked ref, may be of a late type.
    if (!adapter) this.refuseLateType(ref.type);
    const source = adapter ?? this.engine.resolverByType.get(ref.type);
    if (!source) return Object.freeze([ref, GLOBAL]);
    const raw = source.ancestors(ref);
    return isThenable(raw) ? Promise.resolve(raw).then((list) => this.ancestorList(list, ref)) : this.ancestorList(raw, ref);
  }

  private ancestorList(list: unknown, ref: ResourceRef): readonly ResourceRef[] | null {
    if (list === null) return null;
    const out = Array.isArray(list) ? Array.from(list, (r: unknown) => copyRef(r)) : undefined;
    if (!out || out.some((r) => r === undefined)) throw new AuthzConfigError(`${this.engine.where}: ancestors of ${resourceKey(ref)} must be a list of refs or null`);
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
      loads(this.engine, scope).push(load);
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
    const adapter = this.engine.adapterByType.get(ref.type);
    const resolver = this.engine.resolverByType.get(ref.type);
    if (!adapter) this.refuseLateType(ref.type);
    let own: unknown = {};
    if (adapter && typeof adapter.scopeAttributes === 'function') own = await this.attributeLoad(ref, load, `adapter ${quote(adapter.kind)}`, () => adapter.scopeAttributes!(ref));
    else if (resolver && typeof resolver.attributes === 'function') own = await this.attributeLoad(ref, load, 'the scope resolver', () => resolver.attributes!(ref));
    if (own === TIMED_OUT) return { attributes: null, degraded: true };
    if (own === null) return { attributes: null, degraded: false };
    const layers: unknown[] = [this.engine.attributeDefaults.get(ref.type) ?? {}, own];
    const store = this.engine.attributeStore;
    if (store) {
      const row = await this.attributeLoad(ref, load, 'the scope attribute store', () => store.get(ref));
      if (row === TIMED_OUT) return { attributes: null, degraded: true };
      layers.push(row);
    }
    try {
      return { attributes: mergeAttributes(layers), degraded: false };
    } catch (e) {
      throw new AuthzConfigError(`${this.engine.where}: scope attributes of ${resourceKey(ref)}: ${describeError(e)}`, { cause: e });
    }
  }

  private async attributeLoad(ref: ResourceRef, node: NodeLoad, source: string, load: () => unknown): Promise<unknown> {
    const r = await bounded(load, this.engine.config.modelTimeoutMs);
    if (r.kind === 'error') throw r.error;
    if (r.kind === 'value') return r.value;
    this.logTimeout(node, { resource: resourceKey(ref), source, timeoutMs: this.engine.config.modelTimeoutMs }, 'Authz domain ${domain}: scope attributes of ${resource} from ${source} timed out after ${timeoutMs} ms; the node is unknown');
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
      return this.engine.registry.require(name);
    } catch (e) {
      if (!(e instanceof UnknownPermission)) throw e;
      for (const adapter of this.engine.adapterList) {
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
    if (type === GLOBAL_TYPE || this.engine.adapterByType.has(type)) return undefined;
    for (const adapter of this.engine.adapterList) {
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
    return new kind(`${this.engine.where}: resource type ${quote(type)} was registered with adapter ${quote(name)} after the domain booted; register it before boot, or boot the domain again`);
  }

  private requireRef(v: unknown): ResourceRef {
    const ref = copyRef(v);
    if (!ref) throw new AuthzConfigError(`${this.engine.where}: expected a ResourceRef`);
    return ref;
  }

  // ---- plumbing ----

  private newRun(sync: boolean, scope: RequestScope | undefined): Run {
    return newRun(this.engine, sync, scope);
  }

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
