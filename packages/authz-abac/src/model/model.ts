import { AuthorizationModel, AuthzConfigError, BUILTIN_CONDITION_FUNCTIONS, DefaultConditionCompiler, FALSE, GLOBAL, TRUE, and, or } from '@spinajs/authz';
import type { AuthzContribution, CompiledCondition, ConditionFunction, DecisionRequest, DenyReason, EvaluationContext, FieldSet, ModelCapabilities, ModelInitContext, ModelSummary, ParsedCondition, PermissionDef, PermissionRegistry, Principal, ResourceFilter, ResourceRef, ResourceType, Vote } from '@spinajs/authz';

import { PolicyStore } from '../contracts.js';
import { PolicyIndex, loadPolicy, scopeFilter, targets } from './policies.js';
import type { LoadedPolicy } from './policies.js';
import { ConfigPolicyStore } from './stores/config.js';

export interface AbacModelOptions {
  /** Default 'abac'; the model reads `authz.<name>.*`. */
  readonly name?: string;
  /** Default: one ConfigPolicyStore over `authz.<name>.policies`. */
  readonly stores?: readonly PolicyStore[];
  /** Functions a policy condition may call, for the checks at load; default the core's built-ins. */
  readonly functions?: readonly ConditionFunction[];
}

const RESIDUALS = Object.freeze(['true', 'false', 'and', 'or', 'not', 'cmp', 'under'] as const);

interface Entry {
  readonly p: LoadedPolicy;
  readonly when: ResourceFilter;
  readonly needsSubject: boolean;
}

/**
 * ABAC (design §6.2): permit and deny policies from policy stores, targeted by permission glob,
 * resource type, principal type (the principal or a companion), actor type and scope, with core
 * conditions (§5.9). `permitWhen` is the OR of the permit policies that apply, `denyWhen` the OR
 * of the deny policies, one `denies` entry each with its reason and priority (default 500).
 */
export class AbacModel extends AuthorizationModel {
  readonly name: string;
  private readonly parser: DefaultConditionCompiler;
  private stores: readonly PolicyStore[] | undefined;
  private registry: PermissionRegistry | undefined;
  private loaded: readonly LoadedPolicy[] = [];
  private versions = '';
  private built: PolicyIndex | undefined;
  private stale = false;
  private reload: Promise<void> | undefined;

  constructor(options: AbacModelOptions = {}) {
    super();
    this.name = options.name ?? 'abac';
    this.parser = new DefaultConditionCompiler(options.functions ?? BUILTIN_CONDITION_FUNCTIONS);
    this.stores = options.stores;
  }

  /**
   * `sync: 'always'` while every loaded policy is unconditional and every store is static (config);
   * compiling a condition is async, so a model with conditions or a DB store says 'never'.
   */
  get capabilities(): ModelCapabilities {
    const sync = this.registry !== undefined && (this.stores ?? []).every((s) => s instanceof ConfigPolicyStore) && this.loaded.every((p) => !p.when && !p.policy.scope) ? 'always' : 'never';
    return { effects: ['permit', 'deny'], residuals: RESIDUALS, sync, fields: true, needsSubject: true };
  }

  async init(ctx: ModelInitContext): Promise<void> {
    this.registry = ctx.permissions;
    this.stores ??= [new ConfigPolicyStore(ctx.config<unknown[]>('policies', []))];
    // The registry is complete only after every model's init, so the index waits for the first applies().
    await this.load(false);
  }

  /** Static routing; the first call builds the index, so an unregistered permission fails the boot (B02). */
  applies(permission: PermissionDef, type: ResourceType): boolean {
    return this.index().candidates(permission.name, type).length > 0;
  }

  version(): string {
    return this.versions;
  }

  /** Any change of policy data (`policy`, `policy:<id>`) makes the next request reload the stores. */
  invalidate(tags: readonly string[]): void {
    if (tags.some((t) => t === 'policy' || t.startsWith('policy:') || t === `model:${this.name}`)) this.stale = true;
  }

  async preload(): Promise<void> {
    await this.fresh();
  }

  evaluate(req: DecisionRequest, ctx: EvaluationContext): Vote | Promise<Vote> {
    if (this.stale) return this.fresh().then(() => this.evaluate(req, ctx));
    const now = ctx.now;
    const live = this.index()
      .candidates(req.permission, req.resource.type)
      .filter((p) => targets(p, req, now));
    if (live.length === 0) return this.vote([], true);
    const byId = req.resource.id !== undefined && req.resource.id !== null;
    // GLOBAL is a node with no rows below it to filter: its path is itself.
    const root = !byId && req.resource.type === GLOBAL.type ? [GLOBAL] : undefined;
    const scoped = live.some((p) => p.policy.scope && !(p.policy.scope.type === GLOBAL.type && p.policy.scope.id === undefined));
    if (!live.some((p) => p.when) && !(scoped && byId)) {
      return this.vote(
        live.map((p) => ({ p, when: scopeFilter(p.policy.scope, root), needsSubject: false })),
        true,
      );
    }
    return this.evaluateAsync(req, ctx, live, byId && scoped, root);
  }

  private async evaluateAsync(req: DecisionRequest, ctx: EvaluationContext, live: readonly LoadedPolicy[], readAncestors: boolean, root: readonly ResourceRef[] | undefined): Promise<Vote> {
    let ancestors = root;
    if (readAncestors) {
      const list = await ctx.ancestors(req.resource);
      if (list === null) throw new Error(`the ancestors of ${req.resource.type}:${req.resource.id} are unknown`);
      ancestors = list;
    }
    let cacheable = true;
    const entries: Entry[] = [];
    for (const p of live) {
      const scope = scopeFilter(p.policy.scope, ancestors);
      if (scope === FALSE) continue;
      if (!p.when) {
        entries.push({ p, when: scope, needsSubject: false });
        continue;
      }
      const c = await this.compile(p, req, ctx);
      if (!c.cacheable) cacheable = false;
      if (!c.needsSubject) {
        entries.push({ p, when: and(scope, c.filter), needsSubject: false });
      } else if (p.policy.effect === 'deny') {
        // B19: fail closed; the deny holds wherever the policy applies, with its own reason.
        entries.push({ p, when: scope, needsSubject: true });
      } else if (c.unresolvedScope) {
        // B39: a scope.* ref a request without id cannot read makes the vote indeterminate.
        throw new Error(`${p.where}: its condition reads scope attributes, which a request without id cannot resolve`);
      }
      // A permit whose condition needs the row it was not given permits nothing (B19).
    }
    return this.vote(entries, cacheable);
  }

  private compile(p: LoadedPolicy, req: DecisionRequest, ctx: EvaluationContext): Promise<CompiledCondition> {
    const compiler = ctx.conditions as Partial<DefaultConditionCompiler>;
    if (typeof compiler.compileParsed === 'function') return compiler.compileParsed(p.when!, req, ctx);
    return ctx.conditions.compile(p.policy.when!, req, ctx) as Promise<CompiledCondition>;
  }

  private vote(entries: readonly Entry[], cacheable: boolean): Vote {
    const live = entries.filter((e) => e.when !== FALSE);
    const permits = live.filter((e) => e.p.policy.effect === 'permit');
    const denies = live.filter((e) => e.p.policy.effect === 'deny');
    const expiries = live.flatMap((e) => (e.p.expiresAt ? [e.p.expiresAt.getTime()] : []));
    const fields = fieldsOf(permits, denies);
    return {
      model: this.name,
      permitWhen: permits.length === 0 ? FALSE : or(...permits.map((e) => e.when)),
      denyWhen: denies.length === 0 ? FALSE : or(...denies.map((e) => e.when)),
      ...(denies.length > 0 ? { denies: denies.map((e) => ({ when: e.when, reason: reasonOf(e) })) } : {}),
      ...(fields ? { fields } : {}),
      ...(expiries.length > 0 ? { validUntil: new Date(Math.min(...expiries)) } : {}),
      cacheable,
    };
  }

  /**
   * H18 (design §6.2): the permissions this principal's permit policies give at `at`, with the
   * conditions bound for the principal and now; an entry is conditional when a condition or the
   * policy scope still depends on the resource. Deny policies add no entry: `summary` and
   * `covers` check every candidate permission, and the checks apply them.
   */
  async summarize(principal: Principal, at: ResourceRef, ctx: EvaluationContext): Promise<ModelSummary> {
    await this.fresh();
    const now = ctx.now;
    const root = (at.id === undefined || at.id === null) && at.type === GLOBAL.type;
    let ancestors: readonly ResourceRef[] | undefined = root ? [GLOBAL] : undefined;
    if (!root && at.id !== undefined && at.id !== null) ancestors = (await ctx.ancestors(at)) ?? undefined;
    const out: { name: string; conditional: boolean; fields?: FieldSet }[] = [];
    for (const name of [...this.index().permissions()].sort()) {
      const def = ctx.permissions.get(name);
      if (!def || (at.type !== GLOBAL.type && !def.types.includes(at.type))) continue;
      const req: DecisionRequest = { principal, permission: name, resource: at, env: { now } };
      let best: { conditional: boolean; fields?: FieldSet } | undefined;
      for (const p of this.index().candidates(name, at.type)) {
        if (p.policy.effect !== 'permit' || !targets(p, req, now)) continue;
        const scope = scopeFilter(p.policy.scope, ancestors);
        if (scope === FALSE) continue;
        let conditional = scope !== TRUE;
        if (p.when) {
          const c = await this.compile(p, req, ctx);
          if (c.filter.op === 'false' && !c.needsSubject) continue;
          if (c.needsSubject || c.filter.op !== 'true') conditional = true;
        }
        if (!best || (best.conditional && !conditional)) best = { conditional, ...(def.fields === true && p.policy.fields ? { fields: p.policy.fields } : {}) };
      }
      if (best) out.push({ name, ...best });
    }
    return { model: this.name, permissions: out };
  }

  /**
   * B19: a policy whose condition reads `scope.<type>.*` (other than `$global`) or calls a function on
   * `resource.*` needs the row on a list request; such a policy on a list-scoped type (an adapter
   * that compiles filters) cannot be pushed into the query. One line per policy and type, for the
   * host to log at boot.
   */
  listWarnings(listScopedTypes: Iterable<ResourceType>): readonly string[] {
    const listed = [...new Set(listScopedTypes)];
    const out: string[] = [];
    for (const p of this.loaded) {
      if (!p.when || !needsRow(p.when)) continue;
      const types = p.resourceTypes ? listed.filter((t) => p.resourceTypes!.has(t)) : listed;
      for (const type of types) out.push(`${p.where} on list-scoped type ${JSON.stringify(type)}: its condition needs the row, so a list request ${p.policy.effect === 'deny' ? 'denies needs_subject' : 'gets nothing from it'}`);
    }
    return out;
  }

  /** Boot refs for validateBoot (design §6.5 rules 7 and 10), fed through AbacContributor. */
  contribution(): AuthzContribution {
    const permissionRefs = this.loaded.flatMap((p) => p.policy.permissions.filter((name) => !name.includes('*')).flatMap((permission) => (p.policy.resourceTypes ?? [undefined]).map((type) => ({ permission, ...(type === undefined ? {} : { type }), source: `${this.name} policy ${JSON.stringify(p.policy.id)}` }))));
    const scopeRefs = this.loaded.flatMap((p) => {
      const types = new Set<string>(p.when?.facts.scopeTypes ?? []);
      if (p.policy.scope) types.add(p.policy.scope.type);
      return [...types].map((type) => ({ type, source: `${this.name} policy ${JSON.stringify(p.policy.id)}` }));
    });
    return { permissionRefs, scopeRefs };
  }

  private index(): PolicyIndex {
    if (!this.registry) throw new AuthzConfigError(`${this.name}: the model is used before init`);
    this.built ??= new PolicyIndex(this.loaded, this.registry);
    return this.built;
  }

  private async load(index: boolean): Promise<void> {
    const stores = this.stores ?? [];
    const lists = await Promise.all(stores.map(async (s) => ({ store: s, policies: await s.load(), version: await s.version() })));
    const loaded: LoadedPolicy[] = [];
    for (const { store, policies } of lists) {
      if (!Array.isArray(policies)) throw new AuthzConfigError(`${this.name}: policy store ${JSON.stringify(store.name)} did not load a list`);
      for (const raw of policies) loaded.push(loadPolicy(raw, loaded.length, { source: store.name }, (c, where) => this.parser.parse(c, where)));
    }
    const built = index ? new PolicyIndex(loaded, this.registry!) : undefined;
    this.loaded = loaded;
    this.built = built;
    this.versions = lists.map((l) => `${l.store.name}=${l.version}`).join(';');
  }

  /** Reloads the stores once after an invalidation; concurrent requests share the load, a failed one is retried by the next. */
  private fresh(): Promise<void> {
    if (this.reload) return this.reload;
    if (!this.stale) return Promise.resolve();
    this.stale = false;
    this.reload = this.load(true)
      .catch((e) => {
        this.stale = true;
        throw e;
      })
      .finally(() => {
        this.reload = undefined;
      });
    return this.reload;
  }
}

function needsRow(c: ParsedCondition): boolean {
  switch (c.kind) {
    case 'all':
    case 'any':
      return c.items.some(needsRow);
    case 'not':
      return needsRow(c.item);
    case 'fn':
      return c.facts.roots.includes('resource') || c.facts.scopeTypes.some((t) => t !== GLOBAL.type);
    case 'cmp':
      return c.facts.scopeTypes.some((t) => t !== GLOBAL.type);
  }
}

function reasonOf(e: Entry): DenyReason {
  if (e.needsSubject) return { code: 'needs_subject', policy: e.p.policy.id, sortKey: e.p.policy.id };
  return { code: e.p.policy.reason ?? 'policy', policy: e.p.policy.id, priority: e.p.priority, sortKey: e.p.policy.id };
}

const union = (lists: readonly (readonly string[])[]): readonly string[] => {
  const all = new Set(lists.flat());
  return all.has('*') ? ['*'] : [...all].sort();
};

/** read/write: the union over the permits (a permit without fields gives '*'); hide: the union over the deny policies with fields. */
function fieldsOf(permits: readonly Entry[], denies: readonly Entry[]): FieldSet | undefined {
  const hide = union(denies.flatMap((e) => (e.p.policy.fields?.hide ? [e.p.policy.fields.hide] : [])));
  if (permits.length === 0 && hide.length === 0) return undefined;
  const read = union(permits.map((e) => (e.p.policy.fields ? e.p.policy.fields.read ?? [] : ['*'])));
  const write = union(permits.map((e) => (e.p.policy.fields ? e.p.policy.fields.write ?? [] : ['*'])));
  return { read, write, ...(hide.length > 0 ? { hide } : {}) };
}
