import { Container, Inject, Injectable, PerChildInstance, ResolveType, Service, isFactory } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';

import { AccessDenied, AuthzConfigError } from '../contracts/errors.js';
import { AuthorizationModel, Combinator, NativeFilter } from '../contracts/model.js';
import type { ModelInitContext } from '../contracts/model.js';
import { RelationResolver, ResourceAdapter, ScopeAttributeStore, ScopeResolver } from '../contracts/adapter.js';
import type { ScopeAttributeSchema } from '../contracts/adapter.js';
import { AuthzAdmin } from '../contracts/admin.js';
import { AuthzDomains, AuthzService, ChangeBus, DecisionAudit, DecisionCache } from '../contracts/service.js';
import type { AccessSummary, AuthzChange, CheckInput } from '../contracts/service.js';
import { SYSTEM, UNATTENDED } from '../contracts/principal.js';
import type { Principal, ResourceRef, ResourceType } from '../contracts/principal.js';
import type { Permission, PermissionDef } from '../contracts/permission.js';
import type { ResourceFilter } from '../contracts/filter.js';
import type { Decision } from '../contracts/decision.js';
import { ConditionCompiler } from '../conditions/contracts.js';
import { Authorizer } from '../engine/authorizer.js';
import type { EngineLog } from '../engine/authorizer.js';
import { PermissionRegistryImpl } from '../engine/registry.js';
import type { PermissionInput } from '../engine/registry.js';
import { validateBoot } from '../engine/validate.js';
import type { PermissionRefDecl, RelationRefDecl, ScopeRefDecl } from '../engine/validate.js';
import { checkLegacyKeys } from './config/legacy-keys.js';
import { readDomainConfig } from './config/domain-config.js';
import type { DomainConfig } from './config/domain-config.js';
import { AuthzContributor } from './contributor.js';
import type { AuthzContribution } from './contributor.js';
import { DefaultAuthzDomains } from './domains.js';
import { AuthzClock } from './clock.js';
import { engineLog } from './log.js';
import { currentPrincipal, requestScope, runWithPrincipal } from './storage.js';
// The default ChangeBus, DecisionAudit, DecisionCache and AuthzClock registrations.
import './bus.js';
import './audit.js';
import './cache.js';

interface Registration {
  readonly defs: readonly PermissionInput[];
  readonly source: string;
}

/** What a model registered in its init; replayed into every other domain that lists the model. */
interface ModelInit {
  readonly permissions: readonly (readonly PermissionInput[])[];
  readonly nativeFilters: readonly NativeFilter[];
  readonly relations: readonly RelationResolver[];
}

interface Booted {
  readonly name: string;
  readonly domains: DefaultAuthzDomains;
  readonly cfg: DomainConfig;
  /** The `disable` list of every level of the lineage, root first. */
  readonly disables: readonly (readonly string[])[];
  readonly registrations: readonly Registration[];
  readonly models: readonly AuthorizationModel[];
  /** Models this service holds a use of (DI disposes the ones it cached itself). */
  readonly used: readonly AuthorizationModel[];
  readonly authorizer: Authorizer;
  readonly audit: DecisionAudit | undefined;
  readonly admin: AuthzAdmin | undefined;
  readonly cache: DecisionCache | undefined;
  readonly unsubscribe: (() => void) | undefined;
}

// Once per model instance in the process; dropped when the last domain using the model releases it.
const inits = new WeakMap<AuthorizationModel, Promise<ModelInit>>();
// Services (booted or booting) that use a model; the last one to release it disposes it.
const users = new WeakMap<AuthorizationModel, Set<DefaultAuthzService>>();
// Every DecisionCache an Authorizer ever used: a rebuilt Authorizer must never adopt one (it may hold the old entries).
const usedCaches = new WeakSet<object>();

const q = (v: unknown): string => {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : String(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
};
const describeError = (e: unknown): string => (e instanceof Error ? e.message : q(e));
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const typeName = (t: unknown): string => (typeof t === 'function' && typeof t.name === 'string' ? t.name : '');
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
const modelName = (m: unknown): string | undefined => (isObject(m) && typeof m.name === 'string' ? m.name : undefined);

function inCache(container: IContainer, value: unknown): boolean {
  for (const entry of container.Cache) if (entry.value === value) return true;
  return false;
}

@PerChildInstance()
@Injectable(AuthzService)
@Inject(Container)
export class DefaultAuthzService extends AuthzService {
  private booted: Booted | undefined;
  private name: string | undefined;
  private disposed = false;
  private domainsRef: DefaultAuthzDomains | undefined;
  /** The bus subscription while booting; the booted state owns it afterwards. */
  private bootSubscription: (() => void) | undefined;
  /** Tags of the changes published while booting, applied once the boot ends. */
  private buffered: (readonly string[])[] | undefined;
  private readonly log: EngineLog = engineLog('authz');

  constructor(private readonly container: IContainer) {
    super();
  }

  get domain(): string {
    return this.state().name;
  }

  async resolve(): Promise<void> {
    if (this.booted) return;
    if (this.disposed) throw new AuthzConfigError(`AuthzService of domain ${q(this.name)} is disposed`);
    const claimed: AuthorizationModel[] = [];
    const fresh: AuthorizationModel[] = [];
    let state: Booted;
    try {
      state = await this.boot(claimed, fresh);
    } catch (e) {
      this.abandonBoot();
      await this.release(claimed, fresh);
      throw this.bootError(e);
    }
    this.booted = state;
    this.bootSubscription = undefined;
    const pending = this.buffered;
    this.buffered = undefined;
    if (this.disposed) {
      await this.dispose();
      throw new AuthzConfigError(`AuthzService of domain ${q(this.name)} was disposed while it booted`);
    }
    if (pending !== undefined && pending.length > 0) this.invalidate([...new Set(pending.flat())]);
    await super.resolve();
  }

  current(): Principal {
    this.state();
    return currentPrincipal();
  }

  async runAs<T>(principal: Principal, reason: string, fn: () => Promise<T>): Promise<T> {
    const s = this.state();
    if (!isObject(principal)) throw new AuthzConfigError(`Authz domain ${q(s.name)}: runAs needs a principal object`);
    if (typeof reason !== 'string' || reason.trim() === '') throw new AuthzConfigError(`Authz domain ${q(s.name)}: runAs needs a non-empty reason`);
    if (typeof fn !== 'function') throw new AuthzConfigError(`Authz domain ${q(s.name)}: runAs needs a function to run`);
    if (s.cfg.audit.runAs && s.audit) this.record(s, { kind: 'runAs', principal: { type: principal.type, id: principal.id }, reason });
    return runWithPrincipal(principal, async () => {
      if (principal !== SYSTEM && principal !== UNATTENDED) await s.authorizer.preload(principal, requestScope());
      return fn();
    });
  }

  async check(req: CheckInput): Promise<Decision> {
    const s = this.state();
    return s.authorizer.check(this.withPrincipal(req), requestScope());
  }

  async can(principal: Principal, permission: Permission, resource?: ResourceRef | object, subject?: unknown): Promise<boolean> {
    const s = this.state();
    return (await s.authorizer.check(input(principal, permission, resource, subject), requestScope())).allowed;
  }

  async assert(principal: Principal, permission: Permission, resource?: ResourceRef | object, subject?: unknown): Promise<Decision> {
    const s = this.state();
    const decision = await s.authorizer.check(input(principal, permission, resource, subject), requestScope());
    if (!decision.allowed) throw new AccessDenied(decision);
    return decision;
  }

  async checkMany(principal: Principal, permissions: readonly Permission[], resource?: ResourceRef | object): Promise<ReadonlyMap<Permission, Decision>> {
    return this.state().authorizer.checkMany(principal, permissions, resource, requestScope());
  }

  async filter(principal: Principal, permission: Permission, type: ResourceType): Promise<ResourceFilter> {
    return this.state().authorizer.filter(principal, permission, type, requestScope());
  }

  filterNow(principal: Principal, permission: Permission, type: ResourceType): ResourceFilter | undefined {
    return this.state().authorizer.filterNow(principal, permission, type, requestScope());
  }

  async explain(req: CheckInput): Promise<Decision> {
    const s = this.state();
    return s.authorizer.explain(this.withPrincipal(req), requestScope());
  }

  async summary(principal: Principal, at?: ResourceRef): Promise<AccessSummary> {
    return this.state().authorizer.summary(principal, at, requestScope());
  }

  async covers(holder: Principal, target: Principal, at?: ResourceRef): Promise<boolean> {
    return this.state().authorizer.covers(holder, target, at, requestScope());
  }

  async preload(principal: Principal): Promise<void> {
    return this.state().authorizer.preload(principal, requestScope());
  }

  invalidate(tags: readonly string[]): void {
    this.state().authorizer.invalidate(tags);
  }

  models(): readonly AuthorizationModel[] {
    return this.state().models;
  }

  admin(): AuthzAdmin {
    const s = this.state();
    if (!s.admin) throw new AuthzConfigError(`no AuthzAdmin is registered in domain ${q(s.name)}`);
    return s.admin;
  }

  async dispose(): Promise<void> {
    const s = this.booted;
    this.disposed = true;
    if (!s) {
      // Still booting: stop listening now, an init may never finish.
      this.dropSubscription();
      return;
    }
    this.booted = undefined;
    try {
      s.unsubscribe?.();
    } catch (e) {
      this.log.error(`Authz domain ${q(s.name)}: unsubscribing from the change bus failed: ${describeError(e)}`);
    }
    s.domains.detach(s.name, this);
    await this.release(s.used, []);
  }

  private state(): Booted {
    if (this.booted) return this.booted;
    throw new AuthzConfigError(this.disposed ? `AuthzService of domain ${q(this.name)} is disposed` : `AuthzService of domain ${this.name === undefined ? '<unknown>' : q(this.name)} is not resolved; await its resolve first`);
  }

  private withPrincipal(req: CheckInput): CheckInput {
    if (!isObject(req)) return req;
    // Only a request without any principal key (own or inherited) runs as current(); an explicit undefined meets the engine gate.
    return 'principal' in (req as object) ? req : { ...req, principal: this.current() };
  }

  private record(s: Booted, entry: Parameters<DecisionAudit['record']>[0]): void {
    const fail = (e: unknown) => this.log.error(`Authz domain ${q(s.name)}: audit of ${entry.kind} failed: ${describeError(e)}`);
    try {
      const r: unknown = s.audit!.record(entry);
      if (isObject(r) && typeof r.then === 'function') (r as unknown as Promise<void>).then(undefined, fail);
    } catch (e) {
      fail(e);
    }
  }

  private dropSubscription(): void {
    try {
      this.bootSubscription?.();
    } catch (e) {
      this.log.error(`Authz domain ${q(this.name)}: unsubscribing from the change bus failed: ${describeError(e)}`);
    }
    this.bootSubscription = undefined;
    this.buffered = undefined;
  }

  private abandonBoot(): void {
    this.dropSubscription();
    if (this.domainsRef && this.name !== undefined) this.domainsRef.detach(this.name, this);
  }

  private bootError(e: unknown): AuthzConfigError {
    const name = this.name;
    if (e instanceof AuthzConfigError && (name === undefined || e.message.includes(q(name)))) return e;
    return new AuthzConfigError(`Authz ${name === undefined ? 'service' : `domain ${q(name)}`} failed to boot: ${describeError(e)}`, { cause: e });
  }

  /**
   * Drops this service's use of the models (never DI-cached ones: DI disposes
   * those). A model no service uses any more is disposed when its init ran,
   * and is initialised again if a domain lists it later.
   */
  private async release(models: readonly AuthorizationModel[], fresh: readonly AuthorizationModel[]): Promise<void> {
    for (const model of models) {
      const set = users.get(model);
      if (!set?.delete(this) || set.size > 0) continue;
      users.delete(model);
      const initialised = inits.has(model) || fresh.includes(model);
      inits.delete(model);
      if (!initialised || typeof model.dispose !== 'function') continue;
      try {
        await model.dispose();
      } catch (e) {
        this.log.error(`Authz domain ${q(this.name)}: model ${q(model.name)} failed to dispose: ${describeError(e)}`);
      }
    }
  }

  private async boot(claimed: AuthorizationModel[], fresh: AuthorizationModel[]): Promise<Booted> {
    const container = this.container;
    if (!isObject(container) || typeof container.resolve !== 'function') throw new AuthzConfigError('AuthzService needs the container it is resolved in');

    const domains: unknown = await container.resolve(AuthzDomains);
    if (!(domains instanceof DefaultAuthzDomains)) throw new AuthzConfigError('AuthzService needs DefaultAuthzDomains as the AuthzDomains singleton');
    this.domainsRef = domains;
    const id = domains.enter(container, this);
    if (!id) throw new AuthzConfigError('This container is not an authz domain; create it with AuthzDomains.create');
    const name = id.name;
    this.name = name;
    const where = `Authz domain ${q(name)}`;

    let parent: Booted | undefined;
    if (id.parent !== undefined) {
      const svc = await domains.service(id.parent);
      if (!(svc instanceof DefaultAuthzService) || !svc.booted) throw new AuthzConfigError(`${where}: parent domain ${q(id.parent)} has no booted DefaultAuthzService`);
      parent = svc.booted;
    }

    const configuration = (await container.resolve(Configuration)) as unknown as Configuration;
    if (!isObject(configuration) || typeof configuration.get !== 'function') throw new AuthzConfigError(`${where}: the resolved Configuration has no get()`);
    const get = (path: string[]): unknown => configuration.get(path);
    const lineage = domains.lineage(name);
    if (parent === undefined) checkLegacyKeys(get, this.log);
    const cfg = readDomainConfig(get, lineage);
    const disables = [...(parent?.disables ?? []), cfg.disable];
    const levels = lineage.map((n) => domains.container(n));

    const audit = await this.pick(container, DecisionAudit, cfg.audit.service, 'authz.audit.service', where);
    const bus = await this.pick(container, ChangeBus, cfg.bus.service, 'authz.bus.service', where);
    // Subscribed before the models init, so a change published meanwhile is applied once the boot ends.
    if (bus) {
      this.buffered = [];
      const off: unknown = bus.subscribe((change) => this.onChange(change));
      if (typeof off !== 'function') throw new AuthzConfigError(`${where}: ChangeBus.subscribe did not return an unsubscribe function`);
      this.bootSubscription = off as () => void;
    } else {
      this.log.warn(`${where}: no ChangeBus is registered; published changes will not reach this domain`);
    }

    // Entry i of getTypesChain is the registration of element i of resolveChain.
    const owners = <T>(token: Class<T>) => container.Registry.getTypesChain(token).map((e) => e.container);
    const chain = async <T>(token: Class<T>): Promise<T[]> => [...(await container.resolveChain(token))];
    const modelOwners = owners(AuthorizationModel);
    const chainModels = await chain(AuthorizationModel);
    const adapterOwners = owners(ResourceAdapter);
    const adapters = await chain(ResourceAdapter);
    if (modelOwners.length !== chainModels.length || adapterOwners.length !== adapters.length) throw new AuthzConfigError(`${where}: the DI chain changed while it was resolved`);
    const scopeResolvers = await chain(ScopeResolver);
    const chainRelations = await chain(RelationResolver);
    const chainFilters = await chain(NativeFilter);
    const combinators = await chain(Combinator);
    const contributors = await chain(AuthzContributor);

    const models = mergeModels(where, chainModels, modelOwners, levels, disables, (m) => this.log.warn(m));
    for (const [i, model] of models.entries()) {
      if (!isObject(model) || typeof model.init !== 'function') throw new AuthzConfigError(`${where}: models[${i}] (${q(modelName(model))}) is not an AuthorizationModel`);
    }
    const diManaged = models.filter((m) => m instanceof Service && levels.some((c) => inCache(c, m)));
    for (const model of models) {
      if (diManaged.includes(model) || claimed.includes(model)) continue;
      let set = users.get(model);
      if (!set) users.set(model, (set = new Set()));
      set.add(this);
      claimed.push(model);
    }

    const registry = new PermissionRegistryImpl();
    const registrations: Registration[] = [];
    // Kept for the children's replay, so a later change to the caller's arrays cannot alter it.
    const register = (defs: readonly PermissionInput[], source: string): readonly PermissionInput[] => {
      const copy = deepFreeze(structuredClone(defs));
      registry.register(copy, source);
      registrations.push({ defs: copy, source });
      return copy;
    };
    const step = <T>(what: string, fn: () => T): T => {
      try {
        return fn();
      } catch (e) {
        throw new AuthzConfigError(`${where}: ${what}: ${describeError(e)}`, { cause: e });
      }
    };

    for (const r of parent?.registrations ?? []) step(`copying permissions from ${q(id.parent)}`, () => register(r.defs, r.source));
    step('authz permissions config', () =>
      register(
        Object.entries(cfg.permissions).map(([permission, def]) => ({ ...def, name: permission })),
        'config',
      ),
    );
    const own = container;
    for (const [i, adapter] of adapters.entries()) {
      if (adapterOwners[i] !== own || !isObject(adapter) || typeof adapter.permissions !== 'function') continue;
      step(`permissions of adapter ${q(adapter.kind)}`, () => register(adapter.permissions!(), `adapter:${adapter.kind}`));
    }

    const modelRelations: RelationResolver[] = [];
    const modelFilters: NativeFilter[] = [];
    for (const model of models) {
      const record = await this.initModel(where, name, model, registry, configuration, register, fresh);
      modelRelations.push(...record.relations);
      modelFilters.push(...record.nativeFilters);
    }

    step('permission registry', () => registry.freeze());

    const contributions: AuthzContribution[] = [];
    for (const contributor of contributors) {
      let out: unknown;
      try {
        out = await contributor.contribute(name);
      } catch (e) {
        throw new AuthzConfigError(`${where}: contributor ${q(contributorName(contributor))} failed: ${describeError(e)}`, { cause: e });
      }
      if (!isObject(out)) throw new AuthzConfigError(`${where}: contributor ${q(contributorName(contributor))} returned ${q(out)} instead of an object`);
      contributions.push(out as AuthzContribution);
    }
    const contributed = <K extends keyof AuthzContribution>(key: K): NonNullable<AuthzContribution[K]>[number][] =>
      contributions.flatMap((c) => {
        const list: unknown = c[key];
        if (list === undefined) return [];
        if (!Array.isArray(list)) throw new AuthzConfigError(`${where}: a contributor's ${key} must be an array`);
        return list;
      });
    const permissionRefs: PermissionRefDecl[] = contributed('permissionRefs');
    const relationRefs: RelationRefDecl[] = contributed('relationRefs');
    const scopeRefs: ScopeRefDecl[] = contributed('scopeRefs');
    const joinTypes: ResourceType[] = contributed('joinTypes');
    const schemas: ScopeAttributeSchema[] = contributed('scopeAttributeSchemas');

    const relations = [...new Set([...chainRelations, ...modelRelations])];
    const nativeFilters = [...new Set([...chainFilters, ...modelFilters])];
    const { warnings } = validateBoot({
      domain: name,
      models,
      registry,
      combine: cfg.combine,
      // validateBoot adds the built-in algorithms itself.
      combinators: combinators.map((c) => (isObject(c) ? c.name : c) as string),
      adapters,
      scopeResolvers,
      relations,
      nativeFilters,
      permissionRefs,
      relationRefs,
      scopeRefs,
      joinTypes,
    });
    for (const w of warnings) this.log.warn(w);

    const store = container.hasRegistered(ScopeAttributeStore) ? ((await container.resolve(ScopeAttributeStore)) as ScopeAttributeStore) : undefined;
    const conditions = container.hasRegistered(ConditionCompiler) ? ((await container.resolve(ConditionCompiler)) as ConditionCompiler) : undefined;
    const admin = container.hasRegistered(AuthzAdmin) ? ((await container.resolve(AuthzAdmin)) as AuthzAdmin) : undefined;
    const clock = (await container.resolve(AuthzClock)) as unknown;
    if (!isObject(clock) || typeof clock.now !== 'function') throw new AuthzConfigError(`${where}: the resolved AuthzClock has no now()`);
    const now = () => (clock as unknown as AuthzClock).now();

    let cache: DecisionCache | undefined;
    // maxEntries 0 means no L2 (LruDecisionCache needs at least one entry).
    if (cfg.cache.maxEntries > 0) {
      cache = (await container.resolve(DecisionCache, [{ maxEntries: cfg.cache.maxEntries, clock: now }])) as DecisionCache;
      if (isObject(cache) && usedCaches.has(cache)) throw new AuthzConfigError(`${where}: the resolved DecisionCache was already used by an Authorizer; register DecisionCache as a factory so each domain gets a fresh one`);
    }

    const authorizer = new Authorizer({
      domain: name,
      models,
      registry,
      combine: cfg.combine,
      combinators,
      adapters,
      scopeResolvers,
      relations,
      nativeFilters,
      scopeAttributes: store ? { schemas, store } : { schemas },
      ...(conditions ? { conditions } : {}),
      ...(cache ? { cache } : {}),
      ...(audit ? { audit } : {}),
      clock: now,
      log: this.log,
      config: {
        modelTimeoutMs: cfg.engine.modelTimeoutMs,
        maxDelegation: cfg.engine.maxDelegation,
        neverRead: cfg.fields.neverRead,
        explain: cfg.engine.explain,
        cacheTtlSeconds: cfg.cache.ttlSeconds,
        auditDenials: cfg.audit.denials,
      },
    });

    if (this.disposed) throw new AuthzConfigError(`${where}: the service was disposed while it booted`);
    if (domains.describe(container)?.name !== name || !domains.attach(name, this)) throw new AuthzConfigError(`${where}: the domain was disposed while it booted`);
    if (cache) usedCaches.add(cache);

    return Object.freeze({
      name,
      domains,
      cfg,
      disables: Object.freeze(disables),
      registrations: Object.freeze(registrations),
      models: Object.freeze([...models]),
      used: Object.freeze([...claimed]),
      authorizer,
      audit,
      admin,
      cache,
      unsubscribe: this.bootSubscription,
    });
  }

  private async initModel(where: string, domain: string, model: AuthorizationModel, registry: PermissionRegistryImpl, configuration: Configuration, register: (defs: readonly PermissionInput[], source: string) => readonly PermissionInput[], fresh: AuthorizationModel[]): Promise<ModelInit> {
    const source = `model:${model.name}`;
    const existing = inits.get(model);
    if (existing) {
      let record: ModelInit;
      try {
        record = await existing;
      } catch (e) {
        throw new AuthzConfigError(`${where}: model ${q(model.name)} failed to init in another domain: ${describeError(e)}`, { cause: e });
      }
      try {
        for (const defs of record.permissions) register(defs, source);
      } catch (e) {
        throw new AuthzConfigError(`${where}: permissions of model ${q(model.name)}: ${describeError(e)}`, { cause: e });
      }
      return record;
    }

    const permissions: (readonly PermissionInput[])[] = [];
    const nativeFilters: NativeFilter[] = [];
    const relations: RelationResolver[] = [];
    let open = true;
    const closed = (what: string) => {
      if (!open) throw new AuthzConfigError(`${where}: model ${q(model.name)} called ${what} after its init finished`);
    };
    const ctx: ModelInitContext = Object.freeze({
      domain,
      permissions: registry,
      config: <T>(path: string, dflt?: T): T => configuration.get<T>(['authz', model.name, ...String(path).split('.')], dflt as T),
      registerPermissions(defs: readonly Omit<PermissionDef, 'source'>[]) {
        closed('registerPermissions');
        permissions.push(register(defs, source));
      },
      registerNativeFilter(f: NativeFilter) {
        closed('registerNativeFilter');
        nativeFilters.push(f);
      },
      registerRelation(r: RelationResolver) {
        closed('registerRelation');
        relations.push(r);
      },
    });
    const run = (async (): Promise<ModelInit> => {
      try {
        await model.init(ctx);
      } finally {
        open = false;
      }
      return Object.freeze({ permissions, nativeFilters: Object.freeze(nativeFilters), relations: Object.freeze(relations) });
    })();
    inits.set(model, run);
    fresh.push(model);
    try {
      return await run;
    } catch (e) {
      if (inits.get(model) === run) inits.delete(model);
      throw new AuthzConfigError(`${where}: model ${q(model.name)} failed to init: ${describeError(e)}`, { cause: e });
    }
  }

  /** The registration named by `service` (a class name), else the last registration; undefined when none. */
  private async pick<T>(container: IContainer, token: Class<T>, service: string | undefined, key: string, where: string): Promise<T | undefined> {
    if (service === undefined) {
      if (!container.hasRegistered(token)) return undefined;
      return (await container.resolve(token)) as T;
    }
    // Factories have no usable name: they can only be the unnamed default.
    const entry = container.Registry.getTypesChain(token)
      .filter((e) => !isFactory(e.type) && typeName(e.type) === service)
      .pop();
    if (!entry) throw new AuthzConfigError(`${where}: ${key} names ${q(service)}, but no ${token.name} class of that name is registered`);
    const type = entry.type as Class<T>;
    // Resolved where resolveChain would: per-child classes here, the rest in the registering container.
    const at = container.extractDescriptor(type).resolver === ResolveType.PerChildContainer ? container : entry.container;
    return (await at.resolve(type)) as T;
  }

  private onChange(change: AuthzChange): void {
    const domains = this.domainsRef;
    const name = this.name;
    if (!domains || name === undefined) return;
    try {
      let tags: readonly string[];
      if (!isObject(change)) tags = ['*'];
      else if (!domains.affects(change.domain, name)) return;
      else tags = Array.isArray(change.tags) ? change.tags : ['*'];
      if (this.booted) this.invalidate(tags);
      // Copied: the publisher may reuse its array before the boot ends.
      else this.buffered?.push([...tags]);
    } catch (e) {
      this.log.error(`Authz domain ${q(name)}: applying a published change failed: ${describeError(e)}`);
    }
  }
}

function contributorName(c: unknown): string {
  return isObject(c) ? typeName(c.constructor) || 'AuthzContributor' : q(c);
}

function input(principal: Principal, permission: Permission, resource?: ResourceRef | object, subject?: unknown): CheckInput {
  return {
    principal,
    permission,
    ...(resource === undefined ? {} : { resource }),
    ...(subject === undefined ? {} : { subject }),
  };
}

/**
 * Level by level, root first: drop the names the level disables, then add the
 * level's own models; one whose name an ancestor level placed replaces it in
 * place, a second one of a name within the level is kept for rule 2.
 */
function mergeModels(where: string, chain: readonly AuthorizationModel[], owners: readonly IContainer[], levels: readonly IContainer[], disables: readonly (readonly string[])[], warn: (message: string) => void): AuthorizationModel[] {
  const levelOf = owners.map((c) => levels.indexOf(c));
  if (levelOf.some((l) => l < 0)) throw new AuthzConfigError(`${where}: a model is registered in a container outside the domain lineage`);
  let list: { model: AuthorizationModel; level: number }[] = [];
  for (let level = 0; level < levels.length; level++) {
    const disabled = new Set(disables[level] ?? []);
    // A misspelt name would leave on a model the operator meant to turn off.
    for (const name of disabled) {
      if (!list.some((e) => modelName(e.model) === name)) warn(`${where}: disable lists ${q(name)}, which no ancestor domain registers`);
    }
    list = list.filter((e) => {
      const n = modelName(e.model);
      return n === undefined || !disabled.has(n);
    });
    chain.forEach((model, i) => {
      if (levelOf[i] !== level) return;
      const n = modelName(model);
      const at = n === undefined ? -1 : list.findIndex((e) => e.level < level && modelName(e.model) === n);
      if (at >= 0) list[at] = { model, level };
      else list.push({ model, level });
    });
  }
  return list.map((e) => e.model);
}
