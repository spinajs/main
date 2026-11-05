import { quote, compareStrings } from '@spinajs/util';
import { Perf } from '@spinajs/log-common';
import { AuthzConfigError } from '../contracts/errors.js';
import { FALSE } from '../contracts/filter.js';
import type { ResourceFilter } from '../contracts/filter.js';
import type { Decision } from '../contracts/decision.js';
import { compareDenyReasons } from '../contracts/decision.js';
import type { AccessPlan, ListPlanRequest, ModelListPlan } from '../contracts/plan.js';
import type { AuthorizationModel, ModelSummary } from '../contracts/model.js';
import type { Permission, PermissionDef } from '../contracts/permission.js';
import { SYSTEM, principalKey } from '../contracts/principal.js';
import type { Principal, ResourceRef, ResourceType } from '../contracts/principal.js';
import { GLOBAL, resourceKey } from '../contracts/resource.js';
import type { AccessSummary, CheckInput } from '../contracts/service.js';
import { DEFAULT_COMBINE } from './routes.js';
import type { RouteTable } from './routes.js';
import { resolveDelegation } from './delegation.js';
import type { Delegation } from './delegation.js';
import { invalidationTags, principalState, versionVector } from './cache-key.js';
import { ModelContext, NoConditionCompiler, l1Key } from './context.js';
import { runAsync, runSync, settleWithin } from './run.js';
import type { Pipeline } from './run.js';
import { deepFreeze, describeError, thrownError } from './vote.js';
import { ALL_PLAN, CEILING_DENIAL, combinePlans, nonePlan, readModelPlan, withinOf } from './plan.js';
import type { PlanAnswer } from './plan.js';
import { isObject } from './internal/util.js';
import { CachedPlan, DEADLINE_FACTOR, DELEGATE_PRIORITY, ENGINE_FAULT, GLOBAL_TYPE, INVALID_REQUEST, MAX_PRELOADED, MAX_SUMMARY_PERMISSIONS, NO_FIELDS, NO_LOG, NO_ROLES, SUMMARY_BATCH, SYSTEM_REF, UNKNOWN_RESOURCE, nextGeneration } from './types.js';
import type { AuthorizerOptions, Engine, Checked, RequestScope, Run } from './types.js';
import { Deadline, EXPIRED, THREW } from './support/deadline.js';
import { entryCovers, firmFieldsOf } from './support/compare.js';
import { combinatorsOf, compileTable, decisionCacheOf, fieldSetup, readConfig, resourceIndexes, scopeAttributesOf } from './support/setup.js';
import { admits, contextCacheKey, deniedCopy, newNested, principalCacheId, scopeMap } from './support/misc.js';
import { logAt, newRun, now } from './support/plumbing.js';
import { bornOf, epoch, invalidateL2 } from './cache/generation.js';
import { markFault } from './cache/store.js';
import { principalGate } from './pipeline/principal-gate.js';
import { envOf, relation } from './context/request.js';
import { ancestorsOf } from './context/scope.js';
import { lateType, refuseLateType, requirePermission, requireRef } from './context/late-type.js';
import { loadRows, prefillAncestors } from './context/rows.js';
import { resolveObject } from './pipeline/resolve.js';
import { ceilingOf, delegationOf } from './pipeline/delegate.js';
import { comparedRefs, copySummary, customPlan, listedFields, summaryCeiling, summaryCovered, summaryEntries, summaryEntry } from './summary/entries.js';
import type { SummaryItem } from './summary/entries.js';
import { pipeline } from './pipeline/index.js';
import type { Resolved } from './pipeline/index.js';
import { baseHost, hostFor } from './context/host.js';

export { MAX_SUMMARY_PERMISSIONS } from './types.js';
export type { AuthorizerOptions, RequestScope } from './types.js';

export class Authorizer {
  readonly domain: string;
  private readonly engine: Engine;
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
      preloaded: this.preloaded,
    };
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
    const resolved = resource === undefined ? undefined : await runAsync(resolveObject(this.engine, resource));
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
    const def = requirePermission(this.engine, permission);
    if (def.list !== true) throw new AuthzConfigError(`${this.engine.where}: permission ${quote(def.name)} is not declared with list: true, so it has no access plan`);
    refuseLateType(this.engine, type);
    if (!def.types.includes(type)) throw new AuthzConfigError(`${this.engine.where}: permission ${quote(def.name)} is planned on type ${quote(type)}, which is not in its types (${def.types.join(', ')})`);
    const gate = principalGate(principal);
    if (gate.kind === 'system') return ALL_PLAN;
    if (gate.kind === 'deny') return nonePlan(gate.reason);
    const fresh = def.consistency === 'fresh';
    const run: Run = fresh ? { ...this.newRun(false, scope), fresh: true } : this.newRun(false, scope);
    const delegation = delegationOf(this.engine, gate.principal, undefined, run.delegationBudget);
    if (delegation.denial) return nonePlan(delegation.denial);
    if (delegation.intersect !== undefined) return nonePlan({ code: 'delegate', priority: DELEGATE_PRIORITY, delegate: delegation.intersectKey });
    // Env facts are not in the key, so a call with a caller env is never memoised; a fresh plan is never read back.
    const key = env === undefined && !fresh ? this.planKey(gate.principal, def, type, run) : undefined;
    const hit = key === undefined ? undefined : this.cachedPlan(key, run);
    if (hit) return hit;
    const built = await this.buildPlan(delegation, def, type, envOf(this.engine, env, run.instant), run);
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
      const ref = requireRef(this.engine, r.resource);
      const def = typeof r.permission === 'string' ? this.engine.registry.get(r.permission) : undefined;
      if (!def || lateType(this.engine, ref.type) !== undefined || (ref.type !== GLOBAL_TYPE && !def.types.includes(ref.type))) {
        out[i] = this.invalidRequest(principal, r.permission, ref);
        return undefined;
      }
      return { def, ref };
    });
    const shared: RequestScope = { cache: scopeMap(scope) };
    await prefillAncestors(this.engine, 
      items.flatMap((x) => (x ? [x.ref] : [])),
      shared.cache!,
    );
    const check = async (def: PermissionDef, ref: ResourceRef, subject: unknown): Promise<Decision> => (await runAsync(this.pipeline({ principal, permission: def.name }, this.newRun(false, shared), { ref, subject }))).decision;
    for (const [i, x] of items.entries()) if (x) out[i] = await check(x.def, x.ref, undefined);
    const conditional = items.flatMap((x, i) => (x && out[i].allowed && out[i].residual.op !== 'true' && x.ref.id !== undefined ? [i] : []));
    if (conditional.length > 0) {
      const rows = await loadRows(this.engine, conditional.map((i) => items[i]!.ref));
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
    const ref = requireRef(this.engine, at);
    refuseLateType(this.engine, ref.type);
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
      const listed = summaryEntries(this.engine, gate.principal, summaries.list, defs, run.instant) ?? new Map<Permission, SummaryItem[]>();
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
          return [summaryEntry(def, true, def.fields === true ? listedFields(this.engine, entries) : NO_FIELDS)];
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
    const r = requireRef(this.engine, ref);
    refuseLateType(this.engine, r.type);
    return await ancestorsOf(this.engine, r, scope?.cache ?? new Map<string, unknown>());
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
    const ref = requireRef(this.engine, at);
    refuseLateType(this.engine, ref.type);
    // A refused principal's checks all deny, yet it may hold anything elsewhere (SYSTEM of a second authn copy).
    if (!this.admitted(target)) return false;
    if (holder === SYSTEM) return true;
    if (!this.admitted(holder)) return false;
    const { defs, truncated } = this.checkable(ref, 'covers');
    if (truncated) return false;
    const run = this.quietRun(scope);
    // After quietRun: a model version change recompiles the routes there.
    const custom = customPlan(this.engine, defs, ref);
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
      const listed = summaryEntries(this.engine, target, summarized.list, defs, run.instant);
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
          if (entries.some((e) => pairs.some(([h]) => !summaryCovered(this.engine, h, e, def)))) return false;
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
    const host = baseHost(this.engine);
    const failed = new Set<string>();
    await Promise.all(
      this.engine.modelList.flatMap((model) =>
        typeof model.preload !== 'function'
          ? []
          : runAs.map(async ({ who, cacheId }) => {
              const settled = await settleWithin(
                Promise.resolve().then(() => model.preload!(who, new ModelContext(host, model.name, map, instant, 0, undefined, contextCacheKey(model.name, cacheId)))),
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
      return delegationOf(this.engine, gate.principal, undefined, this.engine.config.maxDelegation).denial === undefined;
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
      const d = delegationOf(this.engine, principal, undefined, this.engine.config.maxDelegation);
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
    const host = hostFor(this.engine, run);
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
    const ceiling = ceilingOf(d, def, { type }, undefined, run.instant);
    if (ceiling.denials.length > 0) return { plan: nonePlan([...ceiling.denials].sort(compareDenyReasons)[0]), faulted: false };
    const within = withinOf(ceiling.restrict);
    if (within === null) return { plan: nonePlan(CEILING_DENIAL), faulted: false };
    const route = this.engine.table.get(def.name, type) ?? { algorithm: 'deny-overrides', models: [] };
    if (route.algorithm !== 'deny-overrides') throw new AuthzConfigError(`${this.engine.where}: list permission ${quote(def.name)} is routed on type ${quote(type)} with ${quote(route.algorithm)}; access plans combine with deny-overrides only (boot rule 12)`);
    const runAs = d.principal;
    const fresh = run.fresh === true ? { fresh: true } : {};
    const req: ListPlanRequest = Object.freeze(d.actor === undefined ? { principal: runAs, permission: def, type, env, ...fresh } : { principal: runAs, actor: d.actor, permission: def, type, env, ...fresh });
    const host = hostFor(this.engine, run);
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
      support = typeof model.listSupport === 'function' ? model.listSupport(req.permission, req.type, { relation: (type, name) => relation(this.engine, type, name) }) : undefined;
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

  // ---- the check pipeline (design §10.1) ----

  /** `resolved`: a ref (and subject) the caller already resolved, so no adapter sees it again. */
  private pipeline(input: CheckInput, run: Run, resolved?: Resolved): Pipeline<Checked> {
    return pipeline(this.engine, input, run, resolved);
  }

  // ---- context services ----

  // ---- plumbing ----

  private newRun(sync: boolean, scope: RequestScope | undefined): Run {
    return newRun(this.engine, sync, scope);
  }

}
