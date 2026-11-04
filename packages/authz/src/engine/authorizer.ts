import { quote } from '@spinajs/util';
import { Perf } from '@spinajs/log-common';
import { AuthzConfigError } from '../contracts/errors.js';
import { FALSE } from '../contracts/filter.js';
import type { ResourceFilter } from '../contracts/filter.js';
import type { Decision } from '../contracts/decision.js';
import type { AccessPlan } from '../contracts/plan.js';
import type { AuthorizationModel } from '../contracts/model.js';
import type { Permission, PermissionDef } from '../contracts/permission.js';
import { SYSTEM } from '../contracts/principal.js';
import type { Principal, ResourceRef, ResourceType } from '../contracts/principal.js';
import { GLOBAL, resourceKey } from '../contracts/resource.js';
import type { AccessSummary, CheckInput } from '../contracts/service.js';
import { DEFAULT_COMBINE } from './routes.js';
import type { RouteTable } from './routes.js';
import { resolveDelegation } from './delegation.js';
import { invalidationTags, versionVector } from './cache-key.js';
import { ModelContext, NoConditionCompiler, l1Key } from './context.js';
import { runAsync, runSync, settleWithin } from './run.js';
import type { Pipeline } from './run.js';
import { deepFreeze, describeError, thrownError } from './vote.js';
import { ALL_PLAN, nonePlan } from './plan.js';
import { isObject } from './internal/util.js';
import { CachedPlan, DEADLINE_FACTOR, DELEGATE_PRIORITY, ENGINE_FAULT, GLOBAL_TYPE, INVALID_REQUEST, MAX_PRELOADED, NO_FIELDS, NO_LOG, NO_ROLES, SYSTEM_REF, UNKNOWN_RESOURCE, nextGeneration } from './types.js';
import type { AuthorizerOptions, Engine, Checked, RequestScope, Run } from './types.js';
import { Deadline, THREW } from './support/deadline.js';
import { tapsOf, combinatorsOf, compileTable, decisionCacheOf, fieldSetup, readConfig, resourceIndexes, scopeAttributesOf } from './support/setup.js';
import { contextCacheKey, deniedCopy, newNested, principalCacheId, scopeMap } from './support/misc.js';
import { logAt, newRun, now } from './support/plumbing.js';
import { bornOf, epoch, invalidateL2 } from './cache/generation.js';
import { markFault } from './cache/store.js';
import { principalGate } from './pipeline/principal-gate.js';
import { envOf } from './context/request.js';
import { ancestorsOf } from './context/scope.js';
import { lateType, refuseLateType, requirePermission, requireRef } from './context/late-type.js';
import { loadRows, prefillAncestors } from './context/rows.js';
import { resolveObject } from './pipeline/resolve.js';
import { delegationOf } from './pipeline/delegate.js';
import { customPlan, listedFields, summaryCeiling, summaryEntries, summaryEntry } from './summary/entries.js';
import type { SummaryItem } from './summary/entries.js';
import { pipeline } from './pipeline/index.js';
import type { Resolved } from './pipeline/index.js';
import { baseHost } from './context/host.js';
import { admitted, checkEach, checkable, modelSummaries, quietRun } from './summary/checks.js';
import { coversAt } from './summary/covers.js';
import { buildPlan, cachedPlan, planKey } from './plan/build.js';

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
      taps: tapsOf(where, options.taps),
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
    const key = env === undefined && !fresh ? planKey(this.engine, gate.principal, def, type, run) : undefined;
    const hit = key === undefined ? undefined : cachedPlan(this.engine, key, run);
    if (hit) return hit;
    const built = await buildPlan(this.engine, delegation, def, type, envOf(this.engine, env, run.instant), run);
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
    const { defs } = checkable(this.engine, ref, 'summary');
    if (gate.kind === 'system') return deepFreeze({ principal: SYSTEM_REF, models: [], permissions: defs.map((def) => summaryEntry(def, false, this.engine.allFields)) });

    const run = quietRun(this.engine, scope);
    const limit = new Deadline(DEADLINE_FACTOR * this.engine.config.modelTimeoutMs);
    try {
      const out: { -readonly [K in keyof AccessSummary]: AccessSummary[K] } = { principal: gate.ref, models: [], permissions: [] };
      const ceiling = summaryCeiling(gate.principal);
      if (ceiling) out.ceiling = ceiling;
      const summaries = await modelSummaries(this.engine, gate.principal, ref, defs, { ...run, nested: newNested() });
      out.models = summaries.list;
      const candidates = summaries.names === undefined ? defs : defs.filter((d) => summaries.names!.has(d.name));
      const listed = summaryEntries(this.engine, gate.principal, summaries.list, defs, run.instant) ?? new Map<Permission, SummaryItem[]>();
      const checked = await checkEach(this.engine, gate.principal, candidates, ref, run, limit);
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
    if (!admitted(this.engine, target)) return false;
    if (holder === SYSTEM) return true;
    if (!admitted(this.engine, holder)) return false;
    const { defs, truncated } = checkable(this.engine, ref, 'covers');
    if (truncated) return false;
    const run = quietRun(this.engine, scope);
    // After quietRun: a model version change recompiles the routes there.
    const custom = customPlan(this.engine, defs, ref);
    if (custom) {
      logAt(this.engine, 'error', { permission: custom.def.name, resourceType: custom.type, algorithm: custom.algorithm }, 'Authz domain ${domain}: covers is false: ${permission} on ${resourceType} uses the combinator ${algorithm}, which may allow without a permit that a summary lists');
      return false;
    }
    return coversAt(this.engine, holder, target, ref, defs, run);
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

  /** `resolved`: a ref (and subject) the caller already resolved, so no adapter sees it again. */
  private pipeline(input: CheckInput, run: Run, resolved?: Resolved): Pipeline<Checked> {
    return pipeline(this.engine, input, run, resolved);
  }

  private newRun(sync: boolean, scope: RequestScope | undefined): Run {
    return newRun(this.engine, sync, scope);
  }
}
