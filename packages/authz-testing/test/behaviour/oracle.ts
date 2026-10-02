// A reference engine for the behaviour fixtures: just enough of design §5.4, §7 and §10.1 over the kit
// fakes to run the core parts. Test code only; never exported or shipped. It is deliberately naive
// (every routed model is evaluated, the cache drops everything on any invalidation).
import { AsyncLocalStorage } from 'node:async_hooks';

import { AccessDenied, AuthzConfigError, FALSE, GLOBAL, SYSTEM, TRUE, UNATTENDED, and, bindRefs, ceilingHash, compareDenyReasons, compilePermissionGlob, not, or, principalKey, resourceKey, simplify, subtractFieldGlobs, unionFieldGlobs } from '@spinajs/authz';
import type { AuthorizationModel, CheckInput, CombiningAlgorithm, Decision, DecisionRequest, DenyReason, EvaluationContext, NativeFilter, Permission, PermissionDef, Principal, PrincipalRef, ResourceFilter, ResourceRef, ResourceType, Vote } from '@spinajs/authz';

import { evaluateFilter, fakeModelInitContext, instantiateWorld } from '../../src/index.js';
import type { BehaviourAuthz, BehaviourDomains, BehaviourHarness, CombineConfig, CombineRoute, Facet, HarnessSession, KitWorld, World } from '../../src/index.js';
import { readPath, sameRef } from '../../src/util.js';

export const ORACLE_FACETS: readonly Facet[] = ['engine', 'boot', 'audit', 'clock', 'cache', 'host', 'bus'];

const refOf = (p: PrincipalRef): PrincipalRef => ({ type: p.type, id: p.id });
const isFalse = (f: ResourceFilter) => simplify(f).op === 'false';

interface Effective {
  readonly vote: Vote;
  readonly P: ResourceFilter;
  readonly D: ResourceFilter;
}

interface Outcome {
  readonly allow: ResourceFilter;
  readonly principal: Principal;
  readonly actor?: Principal;
  readonly algorithm: CombiningAlgorithm;
  readonly models: readonly string[];
  readonly votes: readonly Effective[];
  /** Per vote: did it contribute to the allow? */
  readonly contributes: readonly boolean[];
  readonly core: readonly DenyReason[];
}

interface Shared {
  readonly kit: KitWorld;
  readonly world: World;
  readonly als: AsyncLocalStorage<Principal>;
  readonly preloaded: Set<string>;
}

class Engine implements BehaviourAuthz {
  private readonly cache = new Map<string, { readonly decision: Decision; readonly until: number }>();
  private readonly unsubscribe: () => void;

  constructor(private readonly s: Shared, readonly domain: string, private readonly list: readonly AuthorizationModel[], readonly combine: CombineConfig) {
    this.unsubscribe = s.kit.bus.subscribe((c) => this.invalidate(c.tags));
  }

  close(): void {
    this.unsubscribe();
  }

  models(): readonly AuthorizationModel[] {
    return this.list;
  }

  current(): Principal {
    return this.s.als.getStore() ?? UNATTENDED;
  }

  async runAs<T>(principal: Principal, reason: string, fn: () => Promise<T>): Promise<T> {
    await this.s.kit.audit.record({ kind: 'runAs', principal: refOf(principal), reason });
    return this.s.als.run(principal, fn);
  }

  check(input: CheckInput): Promise<Decision> {
    return this.decide(input, false);
  }

  explain(input: CheckInput): Promise<Decision> {
    return this.decide(input, true);
  }

  async can(principal: Principal, permission: Permission, resource?: ResourceRef | object, subject?: unknown): Promise<boolean> {
    return (await this.check({ principal, permission, resource, subject })).allowed;
  }

  async assert(principal: Principal, permission: Permission, resource?: ResourceRef | object, subject?: unknown): Promise<Decision> {
    const d = await this.check({ principal, permission, resource, subject });
    if (!d.allowed) throw new AccessDenied(d);
    return d;
  }

  async checkMany(principal: Principal, permissions: readonly Permission[], resource?: ResourceRef | object): Promise<ReadonlyMap<Permission, Decision>> {
    const out = new Map<Permission, Decision>();
    for (const permission of permissions) out.set(permission, await this.check({ principal, permission, resource }));
    return out;
  }

  async filter(principal: Principal, permission: Permission, type: ResourceType): Promise<ResourceFilter> {
    return simplify((await this.check({ principal, permission, resource: { type } })).residual);
  }

  filterNow(principal: Principal, permission: Permission, type: ResourceType): ResourceFilter | undefined {
    const def = this.s.kit.permissions.require(permission);
    if (principal === SYSTEM) return TRUE;
    if (principal === UNATTENDED) return FALSE;
    if (principal.onBehalfOf) return undefined;
    const c = principal.ceiling;
    if (c?.permissions && !c.permissions.some((g) => compilePermissionGlob(g)(permission))) return FALSE;
    if (c?.expiresAt && this.s.kit.clock.now().getTime() >= c.expiresAt.getTime()) return FALSE;
    const ref = { type };
    const { models, route } = this.routed(def, type);
    const ctx = this.s.kit.context({ domain: this.domain });
    const votes: Effective[] = [];
    for (const m of models) {
      const sync = m.capabilities.sync;
      if (sync === 'never' || (sync === 'after-preload' && !this.s.preloaded.has(principalKey(principal)))) return undefined;
      let v: Vote | Promise<Vote>;
      try {
        v = m.evaluate({ principal, permission, resource: ref }, ctx);
      } catch (e) {
        votes.push(effective(indeterminate(m.name, String(e))));
        continue;
      }
      if (v instanceof Promise) {
        v.catch(() => undefined);
        return undefined;
      }
      votes.push(effective(v.error !== undefined ? indeterminate(m.name, v.error) : v));
    }
    return simplify(bindRefs(combineVotes(route.algorithm, votes), { principal, env: {} }));
  }

  async preload(principal: Principal): Promise<void> {
    this.s.preloaded.add(principalKey(principal));
    const ctx = this.s.kit.context({ domain: this.domain });
    for (const m of this.list) await m.preload?.(principal, ctx);
  }

  invalidate(tags: readonly string[]): void {
    this.cache.clear();
    for (const m of this.list) m.invalidate?.(tags);
  }

  private routed(def: PermissionDef, type: ResourceType): { models: AuthorizationModel[]; route: CombineRoute } {
    const route = this.combine.types?.[type] ?? this.combine.default;
    const models = route.models.map((n) => this.list.find((m) => m.name === n)).filter((m): m is AuthorizationModel => !!m && m.applies(def, type));
    return { models, route };
  }

  private async decide(input: CheckInput, explain: boolean): Promise<Decision> {
    const started = Date.now();
    const p = input.principal;
    const def = this.s.kit.permissions.require(input.permission);
    const ref = await this.resolve(input.resource, def);
    if (!def.types.includes(ref.type) && ref.type !== GLOBAL.type) throw new AuthzConfigError(`[${this.domain}] ${def.name} cannot be checked on type ${ref.type} (types: ${def.types.join(', ')})`);

    const base = { permission: def.name, resource: ref, principal: refOf(p), domain: this.domain, fields: { read: [] as string[], write: [] as string[] }, roles: {} };
    if (p === SYSTEM) {
      await this.s.kit.audit.record({ kind: 'system', principal: refOf(p), permission: def.name, resource: ref });
      return { ...base, allowed: true, residual: TRUE };
    }
    if (p === UNATTENDED) return { ...base, allowed: false, residual: FALSE, reason: { code: 'unattended' } };

    let depth = 0;
    for (let q = p; q.onBehalfOf; q = q.onBehalfOf) depth++;
    const maxDelegation = this.s.world.config?.engine?.maxDelegation ?? 2;
    if (depth > maxDelegation) throw new AuthzConfigError(`[${this.domain}] delegation of ${principalKey(p)} is ${depth} deep, more than maxDelegation ${maxDelegation}`);

    const now = this.s.kit.clock.now();
    const key = input.subject === undefined && !explain ? this.cacheKey(p, def.name, ref, input.env) : undefined;
    const hit = key ? this.cache.get(key) : undefined;
    if (hit && hit.until > now.getTime()) return hit.decision;

    const ctx = this.s.kit.context({ domain: this.domain });
    const o = await this.outcome(p, input.actor, def, ref, input, ctx);
    let allow = simplify(o.allow);
    const reasons: DenyReason[] = [];
    if (!isFalse(allow) && input.subject !== undefined) {
      const r = await evaluateFilter(allow, input.subject, { principal: o.principal, actor: o.actor, ref, env: input.env, context: ctx });
      if (r === true) allow = TRUE;
      else {
        allow = FALSE;
        reasons.push({ code: 'residual_false' });
      }
    }

    const allowed = !isFalse(allow);
    const contributors = o.votes.filter((_, i) => o.contributes[i]).map((e) => e.vote);
    const decision: Decision = {
      ...base,
      allowed,
      residual: allow,
      ...(o.actor ? { actor: refOf(o.actor) } : {}),
      fields: allowed ? this.fields(o) : base.fields,
      roles: Object.assign({}, ...o.votes.map((e) => e.vote.roles ?? {})),
      ...(allowed ? validUntil(contributors) : {}),
      ...(allowed ? {} : { reason: [...reasons, ...(await this.reasons(o, input, ref, ctx))].sort(compareDenyReasons)[0] ?? { code: 'no_access' } }),
      ...(explain ? { trace: { domain: this.domain, algorithm: o.algorithm, models: o.models, votes: o.votes.map((e) => e.vote), steps: [], durationMs: Date.now() - started } } : {}),
    };

    if (key && o.votes.every((e) => e.vote.cacheable)) {
      const ttl = (this.s.world.config?.cache?.ttlSeconds ?? 60) * 1000;
      const until = Math.min(now.getTime() + ttl, decision.validUntil?.getTime() ?? Infinity);
      this.cache.set(key, { decision, until });
    }
    return decision;
  }

  // A ceiling deny still asks the models: one of them may report a lower priority (D-F5-1).
  private async outcome(p: Principal, actor: Principal | undefined, def: PermissionDef, ref: ResourceRef, input: CheckInput, ctx: EvaluationContext): Promise<Outcome> {
    const ceiling = await this.ceilingDenies(p, def.name, ref, ctx);
    const o = await this.uncapped(p, actor, def, ref, input, ctx);
    return ceiling ? { ...o, allow: FALSE, core: [...o.core, ceiling] } : o;
  }

  private async uncapped(p: Principal, actor: Principal | undefined, def: PermissionDef, ref: ResourceRef, input: CheckInput, ctx: EvaluationContext): Promise<Outcome> {
    const delegate = p.onBehalfOf;
    if (delegate && p.delegation === 'inherit') return this.outcome(delegate, p, def, ref, input, ctx);
    const own = await this.vote(p, actor, def, ref, input, ctx);
    if (!delegate || isFalse(own.allow)) return own;
    const theirs = await this.outcome(delegate, undefined, def, ref, input, ctx);
    if (isFalse(theirs.allow)) return { ...own, allow: FALSE, core: [...own.core, { code: 'delegate', priority: 200 }] };
    return { ...own, allow: and(own.allow, theirs.allow) };
  }

  private async vote(p: Principal, actor: Principal | undefined, def: PermissionDef, ref: ResourceRef, input: CheckInput, ctx: EvaluationContext): Promise<Outcome> {
    const { models, route } = this.routed(def, ref.type);
    const req: DecisionRequest = { principal: p, ...(actor ? { actor } : {}), permission: def.name, resource: ref, ...(input.subject !== undefined ? { subject: input.subject } : {}), ...(input.env ? { env: input.env } : {}) };
    const votes = (await Promise.all(models.map((m) => this.evaluate(m, req, ctx)))).map(effective);
    const allow = bindRefs(combineVotes(route.algorithm, votes), { principal: p, env: input.env ?? {} });
    return { allow, principal: p, actor, algorithm: route.algorithm, models: models.map((m) => m.name), votes, contributes: contributions(route.algorithm, votes), core: [] };
  }

  private async evaluate(m: AuthorizationModel, req: DecisionRequest, ctx: EvaluationContext): Promise<Vote> {
    const timeoutMs = this.s.world.config?.engine?.modelTimeoutMs ?? 2000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const v = await Promise.race([
        Promise.resolve().then(() => m.evaluate(req, ctx)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
      if (v.error !== undefined) return indeterminate(m.name, v.error);
      const missing = req.resource.id == null ? undefined : await missingScopeRef(v, req.resource, ctx);
      return missing ? indeterminate(m.name, `missing scope attribute ${missing}`) : v;
    } catch (e) {
      return indeterminate(m.name, e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  private async reasons(o: Outcome, input: CheckInput, ref: ResourceRef, ctx: EvaluationContext): Promise<DenyReason[]> {
    const out = [...o.core];
    const holds = async (when: ResourceFilter) => {
      const f = simplify(when);
      if (f.op === 'true') return true;
      if (f.op === 'false' || input.subject === undefined) return false;
      return (await evaluateFilter(f, input.subject, { principal: o.principal, actor: o.actor, ref, env: input.env, context: ctx })) === true;
    };
    for (const e of o.votes) {
      for (const d of e.vote.denies ?? []) if (await holds(d.when)) out.push(d.reason);
      if (isFalse(e.P) && e.vote.reason) out.push(e.vote.reason);
    }
    return out;
  }

  private fields(o: Outcome): { read: string[]; write: string[] } {
    const contributors = o.votes.filter((_, i) => o.contributes[i]).map((e) => e.vote);
    const hide = unionFieldGlobs(...o.votes.filter((e) => !isFalse(e.D)).map((e) => e.vote.fields?.hide ?? []));
    const neverRead = this.s.world.config?.fields?.neverRead ?? ['Password'];
    // A vote without fields contributes every field (D-F5-2).
    const pick = (k: 'read' | 'write') => subtractFieldGlobs(subtractFieldGlobs(unionFieldGlobs(...contributors.map((v) => (v.fields ? v.fields[k] ?? [] : ['*']))), hide), neverRead);
    return { read: pick('read'), write: pick('write') };
  }

  private async ceilingDenies(p: Principal, permission: Permission, ref: ResourceRef, ctx: EvaluationContext): Promise<DenyReason | undefined> {
    const c = p.ceiling;
    if (!c) return undefined;
    const reason = { code: c.reason ?? 'ceiling', priority: 200 };
    if (c.permissions && !c.permissions.some((g) => compilePermissionGlob(g)(permission))) return reason;
    if (c.expiresAt && this.s.kit.clock.now().getTime() >= c.expiresAt.getTime()) return reason;
    if (c.resources && ref.id != null) {
      const chain = (await ctx.ancestors(ref)) ?? [];
      if (!c.resources.some((r) => chain.some((a) => sameRef(a, r)))) return reason;
    }
    return undefined;
  }

  private async resolve(resource: CheckInput['resource'], def: PermissionDef): Promise<ResourceRef> {
    if (resource === undefined) return { type: def.resource };
    const adapter = this.s.kit.adapters.find((a) => a.accepts(resource));
    return adapter ? adapter.refOf(resource as never) : (resource as ResourceRef);
  }

  private cacheKey(p: Principal, permission: Permission, ref: ResourceRef, env: CheckInput['env']): string {
    const chain: string[] = [];
    for (let q: Principal | undefined = p; q; q = q.onBehalfOf) chain.push(`${principalKey(q)}/${ceilingHash(q.ceiling)}/${q.delegation ?? ''}`);
    const versions = this.list.map((m) => `${m.name}@${m.version?.() ?? ''}`).join(',');
    return JSON.stringify([this.domain, chain, permission, resourceKey(ref), env ?? null, versions]);
  }
}

function indeterminate(model: string, error: string): Vote {
  return { model, permitWhen: FALSE, denyWhen: TRUE, error, reason: { code: 'model_error', model }, cacheable: false };
}

function effective(vote: Vote): Effective {
  return vote.error !== undefined ? { vote, P: FALSE, D: TRUE } : { vote, P: simplify(vote.permitWhen), D: simplify(vote.denyWhen) };
}

function combineVotes(algorithm: CombiningAlgorithm, votes: readonly Effective[]): ResourceFilter {
  switch (algorithm) {
    case 'deny-overrides':
      return and(or(...votes.map((v) => v.P)), not(or(...votes.map((v) => v.D))));
    case 'permit-overrides':
      return or(...votes.map((v) => and(v.P, not(v.D))));
    case 'first-applicable': {
      const terms: ResourceFilter[] = [];
      const before: ResourceFilter[] = [];
      for (const v of votes) {
        terms.push(and(v.P, not(v.D), ...before));
        before.push(not(or(v.P, v.D)));
      }
      return or(...terms);
    }
    default:
      throw new AuthzConfigError(`unknown algorithm ${algorithm}`);
  }
}

function contributions(algorithm: CombiningAlgorithm, votes: readonly Effective[]): boolean[] {
  if (algorithm === 'deny-overrides') return votes.map((v) => !isFalse(v.P));
  if (algorithm === 'permit-overrides') return votes.map((v) => !isFalse(and(v.P, not(v.D))));
  const before: ResourceFilter[] = [];
  return votes.map((v) => {
    const term = and(v.P, not(v.D), ...before);
    before.push(not(or(v.P, v.D)));
    return !isFalse(term);
  });
}

function validUntil(votes: readonly Vote[]): { validUntil?: Date } {
  const times = votes.map((v) => v.validUntil?.getTime()).filter((t): t is number => t !== undefined);
  return times.length ? { validUntil: new Date(Math.min(...times)) } : {};
}

/** The first `scope.<type>.<path>` ref of the vote whose attribute is missing on the resource's path. */
async function missingScopeRef(v: Vote, resource: ResourceRef, ctx: EvaluationContext): Promise<string | undefined> {
  const refs: string[] = [];
  const walk = (f: ResourceFilter): void => {
    if (f.op === 'and' || f.op === 'or') (f as { args: readonly ResourceFilter[] }).args.forEach(walk);
    else if (f.op === 'not') walk((f as { arg: ResourceFilter }).arg);
    else if (f.op === 'cmp') {
      const value = (f as { value?: unknown }).value as { ref?: unknown } | undefined;
      if (value && typeof value.ref === 'string' && value.ref.startsWith('scope.')) refs.push(value.ref);
    }
  };
  walk(v.permitWhen);
  walk(v.denyWhen);
  for (const d of v.denies ?? []) walk(d.when);
  for (const r of refs) {
    const [, type, ...path] = r.split('.');
    const nearest = (await ctx.ancestors(resource))?.find((a) => a.type === type);
    const attributes = nearest ? await ctx.attributes(nearest) : null;
    if (readPath(attributes, path) == null) return r;
  }
  return undefined;
}

const ALGORITHMS = new Set(['deny-overrides', 'permit-overrides', 'first-applicable']);

class Oracle {
  readonly root: Engine;
  private readonly engines = new Map<string, Engine>();
  private readonly shared: Shared;

  constructor(private readonly kit: KitWorld, private readonly world: World) {
    this.shared = { kit, world, als: new AsyncLocalStorage<Principal>(), preloaded: new Set() };
    this.root = new Engine(this.shared, 'root', kit.models, world.combine);
    this.engines.set('root', this.root);
  }

  /** init() of every model, the child domains, then the boot checks of §6.5 (rules 1-5). */
  async boot(): Promise<void> {
    const natives = new Map<string, NativeFilter>(this.kit.nativeFilters.map((n) => [n.op, n]));
    const init = async (models: readonly AuthorizationModel[], domain: string) => {
      for (const m of models) {
        const ctx = fakeModelInitContext({ domain, permissions: this.kit.permissions, model: m.name, config: this.world.config?.[m.name] as Record<string, unknown> | undefined });
        await m.init(ctx);
        for (const n of ctx.registered.nativeFilters) natives.set(n.op, n);
      }
    };
    await init(this.kit.models, 'root');
    this.validate('root', this.kit.models, this.world.combine, natives);

    const pending = Object.keys(this.world.domains ?? {});
    while (pending.length > 0) {
      const at = pending.findIndex((n) => this.engines.has(this.world.domains![n].parent ?? 'root'));
      if (at < 0) throw new AuthzConfigError(`domains ${pending.join(', ')} have no known parent`);
      const [name] = pending.splice(at, 1);
      const d = this.world.domains![name];
      const parent = this.engines.get(d.parent ?? 'root')!;
      const own = this.kit.domainModels.get(name) ?? [];
      await init(own, name);
      const merged = parent.models().map((m) => own.find((x) => x.name === m.name) ?? m);
      const models = [...merged, ...own.filter((m) => !merged.includes(m))].filter((m) => !(d.disable ?? []).includes(m.name));
      const combine = d.combine ?? parent.combine;
      this.validate(name, own, combine, natives, models);
      this.engines.set(name, new Engine(this.shared, name, models, combine));
    }
  }

  private validate(domain: string, level: readonly AuthorizationModel[], combine: CombineConfig, natives: ReadonlyMap<string, NativeFilter>, all: readonly AuthorizationModel[] = level): void {
    const fail = (msg: string): never => {
      throw new AuthzConfigError(`[${domain}] ${msg}`);
    };
    const seen = new Set<string>();
    for (const m of level) {
      if (seen.has(m.name)) fail(`two models are named ${m.name} in domain ${domain}`);
      seen.add(m.name);
    }
    const adapters = new Map<string, string>();
    for (const a of this.kit.adapters) {
      for (const t of a.types) {
        if (adapters.has(t)) fail(`type ${t} is claimed by two adapters (${adapters.get(t)}, ${a.kind}) in domain ${domain}`);
        adapters.set(t, a.kind);
      }
    }
    const routes: [string, CombineRoute][] = [['default', combine.default], ...Object.entries(combine.types ?? {})];
    for (const [type, route] of routes) {
      if (!ALGORITHMS.has(route.algorithm)) fail(`route ${type}: unknown algorithm ${route.algorithm}`);
      for (const n of route.models) {
        const m = all.find((x) => x.name === n) ?? fail(`combine route ${type} names model ${n}, which domain ${domain} does not register`);
        if (route.algorithm === 'first-applicable' && m.capabilities.effects.length === 0) fail(`model ${n} has no effects and cannot sit in first-applicable route ${type} of domain ${domain}`);
      }
    }
    for (const def of this.kit.permissions.all()) {
      for (const type of def.types) {
        const route = combine.types?.[type] ?? combine.default;
        const adapter = this.kit.adapters.find((a) => a.types.includes(type));
        for (const n of route.models) {
          const m = all.find((x) => x.name === n)!;
          if (!m.applies(def, type)) continue;
          for (const op of m.capabilities.residuals) {
            if (op.startsWith('native:') && !natives.has(op)) fail(`model ${m.name} may emit ${op} on type ${type} (permission ${def.name}) in domain ${domain}, and no NativeFilter evaluates it`);
            if (adapter?.compiles && !adapter.compiles.includes(op)) fail(`model ${m.name} may emit ${op} on list-scoped type ${type} (permission ${def.name}) in domain ${domain}, which its adapter does not compile`);
          }
        }
      }
    }
  }

  readonly domains: BehaviourDomains = {
    service: (name) => this.engines.get(name) ?? fail(`no domain ${name}`),
    names: () => [...this.engines.keys()].filter((n) => n !== 'root'),
    dispose: async (name) => {
      const engine = this.engines.get(name) ?? fail(`no domain ${name}`);
      engine.close();
      this.engines.delete(name);
      for (const m of this.kit.domainModels.get(name) ?? []) await m.dispose?.();
    },
  };

  dispose(): void {
    for (const e of this.engines.values()) e.close();
  }
}

const fail = (msg: string): never => {
  throw new Error(msg);
};

/** The reference engine as a behaviour harness. */
export function oracleHarness(facets: readonly Facet[] = ORACLE_FACETS): BehaviourHarness & { readonly sessions: number; readonly disposed: number } {
  const counts = { sessions: 0, disposed: 0 };
  return {
    facets,
    get sessions() {
      return counts.sessions;
    },
    get disposed() {
      return counts.disposed;
    },
    async setup(world: World): Promise<HarnessSession> {
      const kit = instantiateWorld(world);
      const oracle = new Oracle(kit, world);
      await oracle.boot();
      counts.sessions++;
      return {
        authz: oracle.root,
        kit,
        clock: kit.clock,
        audit: kit.audit,
        bus: kit.bus,
        domains: oracle.domains,
        async dispose() {
          counts.disposed++;
          oracle.dispose();
        },
      };
    },
  };
}
