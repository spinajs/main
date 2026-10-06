import { createHash } from 'node:crypto';
import { AuthorizationModel, AuthzConfigError, BUILTIN_CONDITION_FUNCTIONS, ConditionFunction, DefaultConditionCompiler, FALSE, GLOBAL, TRUE, and, or, subtractFieldGlobs, unionFieldGlobs } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import type { AuthzContribution, CompiledCondition, ConditionPath, DecisionRequest, Policy, DenyReason, EvaluationContext, FieldSet, ModelCapabilities, ModelInitContext, ModelSummary, ParsedCondition, PermissionDef, PermissionRegistry, Principal, ResourceFilter, ResourceRef, ResourceType, Vote } from '@spinajs/authz';

import { PolicyStore } from '../contracts.js';
import { PolicyIndex, loadPolicy, scopeFilter, targets, targetsPrincipal } from './policies.js';
import type { LoadedPolicy } from './policies.js';
import { ABAC_DEFAULT_CONNECTION, ABAC_DEFAULT_STORES, ABAC_STORE_NAMES } from './schema.js';
import { ConfigPolicyStore } from './stores/config.js';
import { DbPolicyStore } from './stores/db.js';

export interface AbacModelOptions {
  /** Default 'abac'; the model reads `authz.<name>.*`. */
  readonly name?: string;
  /**
   * Default: the stores named in `authz.<name>.stores` (design §8.3; 'ConfigPolicyStore' over
   * `authz.<name>.policies`, 'DbPolicyStore' on the connection `authz.<name>.connection`, else
   * 'default'), and without that key a ConfigPolicyStore.
   */
  readonly stores?: readonly PolicyStore[];
  /** Functions a policy condition may call, for the checks at load; default every ConditionFunction registered in root DI (the built-ins included). */
  readonly functions?: readonly ConditionFunction[];
  /** After a failed reload, the first retry waits this long (default 1000 ms), doubling up to 60 s. */
  readonly retryMs?: number;
}

const MAX_RETRY_MS = 60_000;

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
  private parser: DefaultConditionCompiler;
  private readonly functions: readonly ConditionFunction[] | undefined;
  private stores: readonly PolicyStore[] | undefined;
  private generation = 0;
  private registry: PermissionRegistry | undefined;
  private loaded: readonly LoadedPolicy[] = [];
  /** The store each loaded policy id came from (`validate`). */
  private storeOf: ReadonlyMap<string, string> = new Map();
  private versions = '';
  private built: PolicyIndex | undefined;
  /** The generation the loaded policies are current for; behind `generation` means a load is due. */
  private loadedGeneration = 0;
  private reload: Promise<void> | undefined;
  /** The last load failed; routing falls back to the last good index until one succeeds. */
  private failed = false;
  private readonly retryMs: number;
  private retryDelay: number;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(options: AbacModelOptions = {}) {
    super();
    this.name = options.name ?? 'abac';
    this.functions = options.functions;
    this.parser = new DefaultConditionCompiler(options.functions ?? BUILTIN_CONDITION_FUNCTIONS);
    this.stores = options.stores;
    this.retryMs = options.retryMs ?? 1000;
    if (!Number.isFinite(this.retryMs) || this.retryMs <= 0) throw new AuthzConfigError(`${this.name}: retryMs must be a positive number of milliseconds`);
    this.retryDelay = this.retryMs;
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
    if (!this.functions) this.parser = new DefaultConditionCompiler(await registeredFunctions());
    this.stores ??= storesFromConfig(this.name, ctx);
    // The registry is complete only after every model's init, so the index waits for the first applies().
    await this.load(false);
  }

  /**
   * Static routing; the first call builds the index, so an unregistered permission fails the boot
   * (B02). While a load is due every pair routes here, so a new policy on a pair this model did
   * not route yet applies at once: `evaluate` waits for the load. After a failed load the last good
   * index routes, so only this model's pairs are indeterminate while its store is down.
   */
  applies(permission: PermissionDef, type: ResourceType): boolean {
    if (this.due()) return true;
    return this.index().candidates(permission.name, type).length > 0;
  }

  /**
   * The loaded policies' hash, the generation of invalidations, and whether a load is due: it moves
   * at an invalidation and again when the load lands or fails, so the host recompiles the routes
   * each time, also when the load brought the same data.
   */
  version(): string {
    return `${this.versions}#${this.generation}${this.due() ? '~' : ''}`;
  }

  private due(): boolean {
    return this.loadedGeneration < this.generation && !this.failed;
  }

  /**
   * A change of policy data (`policy`, `policy:<id>`, `model:<name>`, or the host's catch-all `*`)
   * starts a reload of the stores; requests wait for it. Config stores never change, so a model
   * with nothing else ignores them.
   */
  invalidate(tags: readonly string[]): void {
    if (this.disposed || !this.registry || (this.stores ?? []).every((s) => s instanceof ConfigPolicyStore)) return;
    if (!tags.some((t) => t === '*' || t === 'policy' || t.startsWith('policy:') || t === `model:${this.name}`)) return;
    this.generation++;
    this.failed = false;
    if (!this.reload) this.startLoad();
  }

  async preload(): Promise<void> {
    await this.upTo(this.generation);
  }

  evaluate(req: DecisionRequest, ctx: EvaluationContext): Vote | Promise<Vote> {
    // Current as of the request's arrival: later invalidations do not keep it waiting.
    const target = this.generation;
    if (this.loadedGeneration < target) return this.upTo(target).then(() => this.evaluateNow(req, ctx));
    return this.evaluateNow(req, ctx);
  }

  private evaluateNow(req: DecisionRequest, ctx: EvaluationContext): Vote | Promise<Vote> {
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
      // Decided without the row after all (the unread part sits under a junction that does not matter).
      if (c.filter.op === 'false') continue;
      if (!c.needsSubject || c.filter.op === 'true') {
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
   * conditions bound for the principal and now. `covers` reads a target's summary, so leaving out
   * a permission the target may hold is the unsafe side; an entry is conditional when it may not
   * hold for every row or in every session.
   * - At `$global` each permission is judged per type T of its `types` (`$global` when none), on
   *   the permits indexed for T; a scope other than `$global` holds below its node (conditional).
   *   Listed when some T has a permit, unconditional when every T has an unconditional one.
   * - `fields` (for `fields: true`) is the union over every permit found, conditional ones too
   *   (`*` for a permit without fields).
   * - At any other `at`, on `at`'s type with the scopes decided on the path of `at`.
   * - A permit that fails only on `actorTypes`, matches `principalTypes` only through a
   *   companion the principal carries now, or whose condition is FALSE now but reads the
   *   session (`readsSession`), is listed conditional: an impersonated session has another actor,
   *   other authn facts and a later time.
   * Deny policies add no entry: `summary` and `covers` check every candidate permission, and the
   * checks apply them.
   */
  async summarize(principal: Principal, at: ResourceRef, ctx: EvaluationContext): Promise<ModelSummary> {
    await this.upTo(this.generation);
    const index = this.index();
    const atGlobal = (at.id === undefined || at.id === null) && at.type === GLOBAL.type;
    const ancestors = at.id !== undefined && at.id !== null ? (await ctx.ancestors(at)) ?? undefined : undefined;
    const out: { name: string; conditional: boolean; fields?: FieldSet }[] = [];
    for (const name of [...index.permissions()].sort()) {
      const def = ctx.permissions.get(name);
      if (!def || (!atGlobal && !def.types.includes(at.type))) continue;
      const req: DecisionRequest = { principal, permission: name, resource: at, env: { now: ctx.now } };
      const judged = new Map<LoadedPolicy, boolean | undefined>();
      const perType: { conditional: boolean; p: LoadedPolicy }[][] = [];
      for (const type of atGlobal ? (def.types.length > 0 ? def.types : [GLOBAL.type]) : [at.type]) {
        const found: { conditional: boolean; p: LoadedPolicy }[] = [];
        for (const p of index.candidates(name, type)) {
          if (!judged.has(p)) judged.set(p, await this.summaryJudgement(p, req, ctx, ancestors));
          const conditional = judged.get(p);
          if (conditional !== undefined) found.push({ conditional, p });
        }
        perType.push(found);
      }
      const listed = perType.filter((found) => found.length > 0);
      if (listed.length === 0) continue;
      // Not the vote's rule (union over the unconditional permits): on the rows where a conditional
      // permit holds the target reads its fields too, and the entry must not show fewer.
      const found = listed.flat();
      const permitFields = (k: 'read' | 'write') => unionFieldGlobs(...found.map((f) => (f.p.policy.fields ? f.p.policy.fields[k] ?? [] : ['*'])));
      const conditional = !perType.every((list) => list.some((f) => !f.conditional));
      out.push({ name, conditional, ...(def.fields === true ? { fields: { read: permitFields('read'), write: permitFields('write') } } : {}) });
    }
    return { model: this.name, permissions: out };
  }

  /**
   * For `summarize`: undefined when the permit never holds for the principal, else whether it is
   * conditional. Without ancestors a scope is `under` it, so a scoped permit is conditional at
   * `$global` and at a type ref. A condition that throws rejects the summary.
   */
  private async summaryJudgement(p: LoadedPolicy, req: DecisionRequest, ctx: EvaluationContext, ancestors: readonly ResourceRef[] | undefined): Promise<boolean | undefined> {
    if (p.policy.effect !== 'permit' || !targetsPrincipal(p, req, ctx.now)) return undefined;
    const scope = scopeFilter(p.policy.scope, ancestors);
    if (scope === FALSE) return undefined;
    const throughCompanion = p.principalTypes !== undefined && !p.principalTypes.has(req.principal.type);
    let conditional = scope !== TRUE || throughCompanion || !targets(p, req, ctx.now);
    if (p.when) {
      const c = await this.compile(p, req, ctx);
      if (c.filter.op === 'false') {
        if (c.cacheable && !readsSession(p.when)) return undefined;
        conditional = true;
      } else if (c.filter.op !== 'true') {
        conditional = true;
      }
    }
    return conditional;
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

  /**
   * Checks a policy a write handler is about to store as this model would load it: shape, condition
   * with this model's functions, registered permissions, and an id no other store's policy uses.
   * One bad row would make every reload fail, and the model indeterminate, so the handler (L9's
   * `policy.put`) calls this first.
   */
  validate(policy: Omit<Policy, 'source'>, source = 'db'): void {
    if (!this.registry) throw new AuthzConfigError(`${this.name}: the model is used before init`);
    const p = loadPolicy({ ...policy, source }, 0, { source }, (c, where) => this.parser.parse(c, where));
    const holder = this.storeOf.get(p.policy.id);
    if (holder !== undefined && holder !== source) throw new AuthzConfigError(`${p.where}: the id is already used by a policy from store ${JSON.stringify(holder)}`);
    new PolicyIndex([p], this.registry);
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
    const lists = await Promise.all(stores.map(async (s) => ({ store: s, policies: await s.load() })));
    const loaded: LoadedPolicy[] = [];
    const storeOf = new Map<string, string>();
    for (const { store, policies } of lists) {
      if (!Array.isArray(policies)) throw new AuthzConfigError(`${this.name}: policy store ${JSON.stringify(store.name)} did not load a list`);
      for (const raw of policies) {
        const p = loadPolicy(raw, loaded.length, { source: store.name }, (c, where) => this.parser.parse(c, where));
        loaded.push(p);
        storeOf.set(p.policy.id, store.name);
      }
    }
    const built = index ? new PolicyIndex(loaded, this.registry!) : undefined;
    this.loaded = loaded;
    this.storeOf = storeOf;
    this.built = built;
    // From what was loaded, not a second read of the stores, which a write in between could make disagree.
    this.versions = createHash('sha256')
      .update(JSON.stringify(loaded.map((p) => p.policy)))
      .digest('hex')
      .slice(0, 16);
  }

  /** Waits until the policies are current for `target`, starting loads as needed; rejects when a load fails. */
  private async upTo(target: number): Promise<void> {
    while (this.loadedGeneration < target) {
      if (!this.reload) this.startLoad();
      await this.reload;
    }
  }

  /**
   * One load at a time. It serves the generation current when it starts; if invalidations came
   * meanwhile, the next one starts when it lands, so the data catches up without a request.
   */
  private startLoad(): void {
    const generation = this.generation;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const run = this.load(true).then(
      () => {
        this.loadedGeneration = Math.max(this.loadedGeneration, generation);
        this.failed = false;
        this.retryDelay = this.retryMs;
      },
      (e: unknown) => {
        // A newer change came in meanwhile: the next load (for it) starts below, so this is no outage yet.
        if (generation === this.generation) this.failed = true;
        throw e;
      },
    );
    this.reload = run.finally(() => {
      this.reload = undefined;
      if (this.failed) this.scheduleRetry();
      else if (this.loadedGeneration < this.generation) this.startLoad();
    });
    // Waiters see the failure; nobody else must get an unhandled rejection.
    this.reload.catch(() => undefined);
  }

  /** Retries a failed load on its own, so a change also takes effect when no request of this model comes (backoff to 60 s). */
  private scheduleRetry(): void {
    if (this.retryTimer || this.disposed) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      // `failed` stays set while the retry runs, so routing keeps to the last good index meanwhile.
      if (this.failed && !this.reload && !this.disposed) this.startLoad();
    }, delay);
    this.retryTimer.unref?.();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
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

/**
 * Whether a condition may answer otherwise in another session of the same principal: it reads
 * `actor.*`, `env.*`, `principal.*` beyond id, type and attributes (authn facts and the like), or
 * calls a function (which sees the actor and env). Principal attributes come from the user store
 * and stay the same under impersonation.
 */
function readsSession(c: ParsedCondition): boolean {
  switch (c.kind) {
    case 'all':
    case 'any':
      return c.items.some(readsSession);
    case 'not':
      return readsSession(c.item);
    case 'fn':
      return true;
    case 'cmp':
      return sessionPath(c.attr) || (c.operand.kind === 'ref' && sessionPath(c.operand.ref));
  }
}

function sessionPath(p: ConditionPath): boolean {
  if (p.root === 'actor' || p.root === 'env') return true;
  if (p.root !== 'principal') return false;
  const [head] = p.path;
  if (head === 'attributes') return false;
  return !(p.path.length === 1 && (head === 'id' || head === 'type'));
}

function reasonOf(e: Entry): DenyReason {
  if (e.needsSubject) return { code: 'needs_subject', policy: e.p.policy.id, sortKey: e.p.policy.id };
  return { code: e.p.policy.reason ?? 'policy', policy: e.p.policy.id, priority: e.p.priority, sortKey: e.p.policy.id };
}

const intersectFieldGlobs = (lists: readonly (readonly string[])[]): string[] => lists.slice(1).reduce<string[]>((acc, l) => subtractFieldGlobs(acc, subtractFieldGlobs(acc, l)), [...lists[0]]);

/**
 * One field set per vote, though the engine applies it to every row the vote permits. So read and
 * write are the union over the permits that hold everywhere, and when none does, the intersection
 * over all of them: every permitted row matches one of them, so it gets no field a permit holding
 * there would not give. A permit without fields gives every field ('*'). Hide is the union over
 * the deny policies with fields (hiding more is safe).
 */
function fieldsOf(permits: readonly Entry[], denies: readonly Entry[]): FieldSet | undefined {
  const hides = denies.flatMap((e) => (e.p.policy.fields?.hide ? [e.p.policy.fields.hide] : []));
  const hide = hides.length > 0 ? unionFieldGlobs(...hides) : [];
  if (permits.length === 0 && hide.length === 0) return undefined;
  const unconditional = permits.filter((e) => e.when.op === 'true');
  const pick = (k: 'read' | 'write'): string[] => {
    const sets = (unconditional.length > 0 ? unconditional : permits).map((e) => (e.p.policy.fields ? e.p.policy.fields[k] ?? [] : ['*']));
    if (sets.length === 0) return [];
    return unconditional.length > 0 ? unionFieldGlobs(...sets) : intersectFieldGlobs(sets);
  };
  return { read: pick('read'), write: pick('write'), ...(hide.length > 0 ? { hide } : {}) };
}

/** Every ConditionFunction registered in root DI; the built-ins when DI holds none. */
async function registeredFunctions(): Promise<readonly ConditionFunction[]> {
  const list = (await DI.resolve(Array.chainOf(ConditionFunction))) as readonly ConditionFunction[];
  return list.length > 0 ? list : BUILTIN_CONDITION_FUNCTIONS;
}

/** The stores `authz.<model>.stores` names (design §8.3); DbPolicyStore resolves its connection on first use. */
export function storesFromConfig(model: string, ctx: Pick<ModelInitContext, 'config'>): PolicyStore[] {
  const names = ctx.config<readonly string[]>('stores', ABAC_DEFAULT_STORES);
  const policies = ctx.config<readonly unknown[]>('policies', []);
  return names.map((name) => {
    if (name === 'ConfigPolicyStore') return new ConfigPolicyStore(policies);
    if (name === 'DbPolicyStore') {
      const connection = ctx.config<string>('connection', ABAC_DEFAULT_CONNECTION);
      return new DbPolicyStore(async () => {
        const driver = (await DI.resolve(Orm)).Connections.get(connection);
        if (!driver) throw new AuthzConfigError(`authz.${model}.connection: no ORM connection named ${JSON.stringify(connection)}`);
        return driver;
      });
    }
    // AUTHZ_ABAC_CONFIGURATION_SCHEMA covers authz.abac only; a model under another name reads an unchecked section.
    throw new AuthzConfigError(`authz.${model}.stores names ${JSON.stringify(name)}, which is not a policy store (${ABAC_STORE_NAMES.join(', ')})`);
  });
}
