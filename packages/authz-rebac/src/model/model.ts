import { AuthorizationModel, AuthzConfigError, CORE_FILTER_OPS, DefaultConditionCompiler, FALSE, NativeFilter, TRUE, UnknownPermission } from '@spinajs/authz';
import type { DecisionRequest, EvaluationContext, FilterOp, IRCompileContext, ListPlanRequest, ListSupport, ModelCapabilities, ModelInitContext, ModelListPlan, PermissionDef, PermissionRegistry, Principal, PrincipalRef, ResourceFilter, ResourceRef, ResourceType, Vote, DenyReason } from '@spinajs/authz';
import type { CaveatDef, IRFragment } from '@spinajs/authz-ir';

import type { CaveatConfig, NamespaceConfig, PermissionMap, RebacLimits, Tuple, TupleCaveat } from '../contracts.js';
import { TupleStore } from '../contracts.js';
import { caveatKey, isSubjectSet, objectKey } from '../keys.js';
import { NamespaceSchema, admitsTuple } from '../namespace/compile.js';
import type { CompiledRewrite } from '../namespace/compile.js';
import { REBAC_DEFAULT_LIMITS, REBAC_DEFAULT_STORE, REBAC_STORE_NAMES } from '../namespace/schema.js';
import { DbTupleStore } from '../stores/db.js';
import { MemoryTupleStore } from '../stores/memory.js';
import { rebacListPlan, rebacListSupport } from './filter.js';
import { RebacCaveats, overlayContext, pickCaveatInput, travels } from './caveats.js';
import type { CaveatRequest, CaveatTruth } from './caveats.js';
import { rebacToIR } from '../ir.js';
import { RebacWalk, expand } from '../expand.js';
import type { UsersetTree } from '../expand.js';
import { listSubjects } from '../list-subjects.js';
import type { SubjectList } from '../list-subjects.js';

export const REBAC_CHECK_OP = 'native:rebac.check' as const;

/** A check's answer; `unknown` when a limit stopped the search for a proof. */
export type Membership = 'member' | 'not' | 'unknown';

export interface RebacModelOptions {
  /** Default 'rebac'; the model reads `authz.<name>.*`. */
  readonly name?: string;
  /** Default: the domain container's TupleStore, else the store `authz.<name>.store` names. */
  readonly store?: TupleStore;
  /** Default `authz.<name>.namespaces`. */
  readonly namespaces?: NamespaceConfig;
  /** Default `authz.<name>.permissions`. */
  readonly permissions?: PermissionMap;
  /** Default `authz.<name>.limit`, then maxDepth 8 and maxCalls 10000. */
  readonly limit?: RebacLimits;
  /** Default `authz.<name>.caveats`. */
  readonly caveats?: CaveatConfig;
}

/** A check ran past `limit.maxCalls`. */
export class RebacLimitExceeded extends Error {}

const RESIDUALS: readonly FilterOp[] = Object.freeze([...CORE_FILTER_OPS, REBAC_CHECK_OP] as FilterOp[]);

interface Result {
  readonly m: Membership;
  /** A node on the current path answered `not` to end a cycle somewhere below: the answer holds for this path only. */
  readonly cut: boolean;
}

const NOT: Result = Object.freeze({ m: 'not', cut: false });
const MEMBER: Result = Object.freeze({ m: 'member', cut: false });

interface Walk {
  readonly principal: PrincipalRef;
  readonly maxDepth: number;
  readonly maxCalls: number;
  readonly read: (object: ResourceRef, relation: string) => Promise<readonly Tuple[]>;
  readonly caveat: (c: TupleCaveat) => Promise<CaveatTruth>;
  readonly memo: Map<string, Membership>;
  readonly path: Set<string>;
  calls: number;
  tooDeep?: string;
  cacheable: boolean;
  /** Caveats a branch could not decide. */
  readonly undecided: Set<string>;
}

/**
 * ReBAC (design ARCH-7): tuples in a TupleStore, namespaces with relations and rewritten permissions.
 * A concrete resource gets a definite vote, or an indeterminate one when a limit stops the check; a
 * type-level request gets the residual `{ op: 'native:rebac.check', args: { relation, principal } }`.
 */
export class RebacModel extends AuthorizationModel {
  readonly name: string;
  readonly nativeFilter: NativeFilter;

  private compiled?: NamespaceSchema;
  private tuples?: TupleStore;
  private limits: Required<RebacLimits> = { ...REBAC_DEFAULT_LIMITS };
  private registry?: PermissionRegistry;
  private permissionsChecked = false;
  private generation = 0;
  private unsubscribe?: () => void;
  private unbindSchema?: () => void;

  constructor(private readonly opts: RebacModelOptions = {}) {
    super();
    this.name = opts.name ?? 'rebac';
    this.nativeFilter = new RebacCheckFilter(this);
  }

  get capabilities(): ModelCapabilities {
    const types = this.compiled ? [...new Set([...this.compiled.targets.values()].map((t) => t.type))].sort() : undefined;
    return { effects: ['permit'], residuals: RESIDUALS, sync: 'never', fields: false, needsSubject: false, resourceTypes: types ?? '*' };
  }

  async init(ctx: ModelInitContext): Promise<void> {
    this.limits = readLimits({ ...REBAC_DEFAULT_LIMITS, ...ctx.config<RebacLimits>('limit', {}), ...this.opts.limit });
    this.compiled = this.compileFrom(ctx);
    this.registry = ctx.permissions;
    this.permissionsChecked = false;
    this.tuples = this.opts.store ?? (ctx.container.hasRegistered(TupleStore) ? await ctx.container.resolve(TupleStore) : storeFromConfig(this.name, ctx));
    // A store that drops `caveat` would turn conditional grants into unconditional ones.
    const conditional = [...this.compiled.namespaces.values()].some((ns) => [...ns.relations.values()].some((r) => r.conditional.length > 0));
    if (conditional && !this.tuples.caveats) throw new AuthzConfigError(`${this.name}: the namespaces declare conditional subject types, but the tuple store ${this.tuples.name} keeps no caveats`);
    this.unsubscribe?.();
    this.unsubscribe = this.tuples instanceof MemoryTupleStore ? this.tuples.onWrite(() => this.generation++) : undefined;
    this.unbindSchema?.();
    this.unbindSchema = this.tuples instanceof DbTupleStore ? this.tuples.checkAgainst(() => this.schema()) : undefined;
    ctx.registerNativeFilter(this.nativeFilter);
  }

  /** Static routing: the permission map targets `type`. The first call checks that every mapped permission is registered. */
  applies(permission: PermissionDef, type: ResourceType): boolean {
    const schema = this.schema();
    if (!this.permissionsChecked && this.registry) {
      for (const name of schema.targets.keys()) if (!this.registry.get(name)) throw new UnknownPermission(`${this.name}: authz.${this.name}.permissions maps ${JSON.stringify(name)}, which no one registered`);
      this.permissionsChecked = true;
    }
    return schema.targets.get(permission.name)?.type === type;
  }

  async evaluate(req: DecisionRequest, ctx: EvaluationContext): Promise<Vote> {
    const target = this.schema().targets.get(req.permission);
    if (!target || target.type !== req.resource.type) return this.vote(FALSE);
    const principal: PrincipalRef = { type: req.principal.type, id: req.principal.id };
    const request: CaveatRequest = { principal: req.principal, permission: req.permission, resource: req.resource, env: req.env ?? {} };
    if (req.resource.id == null) {
      const reachable = this.schema().caveatsReachable(target.type, target.name);
      if (reachable.length === 0) return this.vote({ op: REBAC_CHECK_OP, args: { relation: target.name, principal } });
      const caveats = new RebacCaveats(this.schema().caveats);
      // A condition function may read anything of the request, which a vote cannot carry: its rows are never in the
      // residual. A caveat whose parameter values cannot travel in the vote is left undecided too.
      const undecided = reachable.filter((name) => caveats.callsFunction([name]) || caveats.paramsOf([name]).some((p) => !travels(p, request)));
      const decided = reachable.filter((name) => !undecided.includes(name));
      const args = { relation: target.name, principal, caveatInput: pickCaveatInput(caveats.paramsOf(decided), request), ...(undecided.length > 0 ? { undecided } : {}) };
      return this.vote({ op: REBAC_CHECK_OP, args }, false);
    }
    try {
      const { membership, tooDeep, cacheable, undecided } = await this.walk(req.resource, target.name, principal, ctx, request);
      if (membership === 'member') return this.vote(TRUE, cacheable);
      if (membership === 'not') return this.vote(FALSE, cacheable);
      // A no-permit, not an error vote: an error would veto other models' permits over a missing env value.
      if (tooDeep === undefined && undecided.length > 0) return this.vote(FALSE, cacheable, { code: 'caveat_unknown', model: this.name, caveats: undecided });
      return this.error(`${this.name}: maxDepth ${this.limits.maxDepth} exceeded at ${tooDeep ?? objectKey(req.resource)}`, cacheable);
    } catch (e) {
      if (e instanceof RebacLimitExceeded) return this.error(e.message);
      throw e;
    }
  }

  /** Lists can be planned for every rewrite but exclusion (design §6.2). */
  listSupport(permission: PermissionDef, type: ResourceType): ListSupport {
    return rebacListSupport(this.schema(), permission.name, type);
  }

  async listPlan(req: ListPlanRequest, ctx: EvaluationContext): Promise<ModelListPlan> {
    const caveats = new RebacCaveats(this.schema().caveats);
    const request: CaveatRequest = { principal: req.principal, permission: req.permission.name, resource: { type: req.type }, env: req.env ?? {} };
    const caveat = async (c: TupleCaveat): Promise<CaveatTruth> => (await caveats.evaluate(c, request, ctx)).truth;
    return rebacListPlan({ schema: this.schema(), store: this.store(), principal: { type: req.principal.type, id: req.principal.id }, permission: req.permission.name, type: req.type, maxDepth: this.limits.maxDepth, caveat, now: ctx.now });
  }

  /** Tuple changes (`rebac`, `rebac:<namespace>`, `model:<name>`, the host's `*`) move the version. */
  invalidate(tags: readonly string[]): void {
    if (tags.some((t) => t === '*' || t === 'rebac' || t.startsWith('rebac:') || t === `model:${this.name}`)) this.generation++;
  }

  version(): string {
    return `${this.compiled?.hash() ?? '-'}#${this.generation}`;
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unbindSchema?.();
    this.unbindSchema = undefined;
  }

  /** This model's part of the policy IR; before init it compiles the namespaces from config. */
  toIR(ctx: IRCompileContext): IRFragment {
    const schema = this.compiled ?? this.compileFrom(ctx);
    return rebacToIR(schema, { model: this.name, ...(ctx.permissions === undefined ? {} : { permissions: ctx.permissions }) });
  }

  private compileFrom(ctx: Pick<ModelInitContext, 'config'>): NamespaceSchema {
    return NamespaceSchema.compile(this.opts.namespaces ?? ctx.config<NamespaceConfig>('namespaces', {}), this.opts.permissions ?? ctx.config<PermissionMap>('permissions', {}), this.opts.caveats ?? ctx.config<CaveatConfig>('caveats', {}));
  }

  /** The compiled namespaces. @throws AuthzConfigError before init */
  schema(): NamespaceSchema {
    return this.compiled ?? this.uninitialised();
  }

  /** The store the model reads. @throws AuthzConfigError before init */
  store(): TupleStore {
    return this.tuples ?? this.uninitialised();
  }

  /** The limits in force. */
  limit(): Required<RebacLimits> {
    return this.limits;
  }

  /** Zanzibar's expand of `name` (a relation or permission) on `object`. @throws RebacLimitExceeded past maxCalls */
  expand(object: ResourceRef, name: string): Promise<UsersetTree> {
    return expand(this.walker(object, name), object, name);
  }

  /**
   * The subjects of `subjectType` holding `name` (a relation or permission) on `object`. Caveats are evaluated against
   * `request` (through `request.ctx`, else the default condition compiler at the current instant); without one, or
   * when a caveat cannot be decided, its holders are `conditional`. @throws RebacLimitExceeded past maxCalls
   */
  listSubjects(object: ResourceRef, name: string, subjectType: ResourceType, request?: { readonly env?: Readonly<Record<string, unknown>>; readonly principal?: Principal; readonly ctx?: EvaluationContext }): Promise<SubjectList> {
    const walk = this.walker(object, name);
    if (request === undefined) return listSubjects(walk, object, name, subjectType, () => Promise.resolve('unknown'));
    const caveats = new RebacCaveats(this.schema().caveats);
    // The listed subjects are not the request's principal: without one given, principal.* caveats stay unknown.
    const caveatRequest: CaveatRequest = { principal: request.principal ?? syntheticPrincipal({ type: subjectType, id: '' }), permission: '', resource: object, env: request.env ?? {} };
    const ctx = request.ctx ?? this.caveatContext();
    const undecidable = (c: TupleCaveat): boolean => request.principal === undefined && (readsAbsentPrincipal(this.schema().caveats.get(c.name), c) || caveats.callsFunction([c.name]));
    return listSubjects(walk, object, name, subjectType, async (c) => (undecidable(c) ? 'unknown' : (await caveats.evaluate(c, caveatRequest, ctx)).truth));
  }

  /** What a caveat evaluation outside a decision reads: the clock and the default condition compiler, no scope. */
  private caveatContext(): EvaluationContext {
    return {
      domain: this.name,
      now: new Date(),
      permissions: this.registry ?? this.uninitialised(),
      ancestors: () => Promise.resolve(null),
      attributes: () => Promise.resolve(null),
      conditions: new DefaultConditionCompiler(),
      relation: () => undefined,
      check: () => Promise.reject(new Error(`${this.name}: caveats run no nested checks`)),
      cache: new Map(),
      trace: () => undefined,
    };
  }

  private walker(object: ResourceRef, name: string): RebacWalk {
    const schema = this.schema();
    if (!schema.namespaces.has(object.type) || (schema.relation(object.type, name) === undefined && schema.permission(object.type, name) === undefined)) {
      throw new AuthzConfigError(`${this.name}: ${object.type}#${name} is neither a relation nor a permission of the namespaces`);
    }
    return new RebacWalk(schema, this.store(), this.limits, (message) => new RebacLimitExceeded(`${this.name}: ${message}`));
  }

  /**
   * Does `principal` hold `name` (a relation or permission) on `object`? Caveats read `request`, through `ctx`; without
   * both they are unknown. @throws RebacLimitExceeded past maxCalls
   */
  async check(object: ResourceRef, name: string, principal: PrincipalRef, ctx?: EvaluationContext, request?: { readonly env?: Readonly<Record<string, unknown>>; readonly principal?: Principal; readonly undecided?: readonly string[] }): Promise<Membership> {
    // A caveat reads neither the permission nor the resource (env.* and principal.* only), so neither field matters here.
    const caveatRequest: CaveatRequest | undefined = request && { principal: request.principal ?? syntheticPrincipal(principal), permission: '', resource: object, env: request.env ?? {}, ...(request.undecided ? { undecided: request.undecided } : {}) };
    return (await this.walk(object, name, principal, ctx, caveatRequest)).membership;
  }

  private async walk(object: ResourceRef, name: string, principal: PrincipalRef, ctx?: EvaluationContext, request?: CaveatRequest): Promise<{ membership: Membership; tooDeep?: string; cacheable: boolean; undecided: string[] }> {
    const store = this.store();
    const local = new Map<string, Promise<readonly Tuple[]>>();
    const cache: Map<string, unknown> = ctx?.cache ?? local;
    const read = (o: ResourceRef, relation: string): Promise<readonly Tuple[]> => {
      const key = `rebac:read:${objectKey(o)}#${relation}`;
      let tuples = cache.get(key) as Promise<readonly Tuple[]> | undefined;
      if (!tuples) cache.set(key, (tuples = store.read(o, relation)));
      return tuples;
    };
    const caveats = new RebacCaveats(this.schema().caveats);
    const truths = new Map<string, Promise<CaveatTruth>>();
    const caveat = (c: TupleCaveat): Promise<CaveatTruth> => {
      if (!ctx || !request) {
        w.undecided.add(c.name);
        return Promise.resolve('unknown');
      }
      const key = caveatKey(c);
      let t = truths.get(key);
      if (!t) {
        t = caveats.evaluate(c, request, ctx).then((r) => {
          if (!r.cacheable) w.cacheable = false;
          if (r.truth === 'unknown') w.undecided.add(c.name);
          return r.truth;
        });
        truths.set(key, t);
      }
      return t;
    };
    const w: Walk = { principal: { type: principal.type, id: principal.id }, maxDepth: this.limits.maxDepth, maxCalls: this.limits.maxCalls, read, caveat, memo: new Map(), path: new Set(), calls: 0, cacheable: true, undecided: new Set() };
    const { m } = await this.node(object, name, 0, w);
    return { membership: m, ...(w.tooDeep ? { tooDeep: w.tooDeep } : {}), cacheable: w.cacheable, undecided: [...w.undecided].sort() };
  }

  private async node(object: ResourceRef, name: string, depth: number, w: Walk): Promise<Result> {
    const key = `${objectKey(object)}#${name}`;
    const memoKey = `${key}@${depth}`;
    const known = w.memo.get(memoKey);
    if (known) return { m: known, cut: false };
    if (w.path.has(key)) return { m: 'not', cut: true };
    if (++w.calls > w.maxCalls) throw new RebacLimitExceeded(`${this.name}: maxCalls ${w.maxCalls} exceeded at ${key}`);
    w.path.add(key);
    try {
      const rewrite = this.schema().permission(object.type, name);
      const out = rewrite ? await this.rewrite(object, rewrite, depth, w) : await this.relation(object, name, depth, w);
      if (!out.cut) w.memo.set(memoKey, out.m);
      return out;
    } finally {
      w.path.delete(key);
    }
  }

  /** "this": the tuples of object#name, a subject set one hop deeper. */
  private async relation(object: ResourceRef, name: string, depth: number, w: Walk): Promise<Result> {
    const rel = this.schema().relation(object.type, name);
    if (!rel) return NOT;
    let unknown = false;
    let cut = false;
    for (const t of await w.read(object, name)) {
      if (!admitsTuple(rel, t)) continue;
      const s = t.subject;
      let r: Result;
      if (isSubjectSet(s)) r = await this.guarded(t, w, () => this.hop(s.object, s.relation, depth, w));
      else if (s.type === w.principal.type && s.id === w.principal.id) r = await this.guarded(t, w, () => Promise.resolve(MEMBER));
      else continue;
      if (r.m === 'member') return r;
      unknown ||= r.m === 'unknown';
      cut ||= r.cut;
    }
    return { m: unknown ? 'unknown' : 'not', cut };
  }

  /** Kleene AND of the tuple's caveat and `inner`, which runs only when the caveat is not false: the IR's `caveated`. */
  private async guarded(t: Tuple, w: Walk, inner: () => Promise<Result>): Promise<Result> {
    if (t.caveat === undefined) return inner();
    const c = await w.caveat(t.caveat);
    if (c === 'deny') return NOT;
    const r = await inner();
    return c === 'allow' || r.m === 'not' ? r : { m: 'unknown', cut: r.cut };
  }

  /** A node one tuple hop below `depth`, or `unknown` when that is past maxDepth. */
  private hop(object: ResourceRef, name: string, depth: number, w: Walk): Promise<Result> {
    if (depth + 1 > w.maxDepth) {
      w.tooDeep ??= `${objectKey(object)}#${name}`;
      return Promise.resolve({ m: 'unknown', cut: false });
    }
    return this.node(object, name, depth + 1, w);
  }

  private async rewrite(object: ResourceRef, r: CompiledRewrite, depth: number, w: Walk): Promise<Result> {
    switch (r.kind) {
      case 'computed':
        return this.node(object, r.name, depth, w);
      case 'ttu':
        return this.arrow(object, r.tupleset, r.computed, depth, w);
      case 'union':
        return this.any(r.children.map((c) => () => this.rewrite(object, c, depth, w)));
      case 'intersection':
        return this.all(r.children.map((c) => () => this.rewrite(object, c, depth, w)));
      case 'exclusion': {
        const base = await this.rewrite(object, r.base, depth, w);
        if (base.m === 'not') return base;
        const subtract = await this.rewrite(object, r.subtract, depth, w);
        const cut = base.cut || subtract.cut;
        if (subtract.m === 'member') return { m: 'not', cut };
        return { m: base.m === 'member' && subtract.m === 'not' ? 'member' : 'unknown', cut };
      }
    }
  }

  /** Tuple-to-userset: `computed` on every object the tupleset's tuples name, one hop deeper. */
  private async arrow(object: ResourceRef, tupleset: string, computed: string, depth: number, w: Walk): Promise<Result> {
    const rel = this.schema().relation(object.type, tupleset);
    if (!rel) return NOT;
    const branches: (() => Promise<Result>)[] = [];
    for (const t of await w.read(object, tupleset)) {
      const s = t.subject;
      if (isSubjectSet(s) || !admitsTuple(rel, t) || !this.schema().namespaces.has(s.type)) continue;
      branches.push(() => this.guarded(t, w, () => this.hop({ type: s.type, id: s.id }, computed, depth, w)));
    }
    return this.any(branches);
  }

  private async any(branches: readonly (() => Promise<Result>)[]): Promise<Result> {
    let unknown = false;
    let cut = false;
    for (const b of branches) {
      const r = await b();
      if (r.m === 'member') return r;
      unknown ||= r.m === 'unknown';
      cut ||= r.cut;
    }
    return { m: unknown ? 'unknown' : 'not', cut };
  }

  private async all(branches: readonly (() => Promise<Result>)[]): Promise<Result> {
    let unknown = false;
    let cut = false;
    for (const b of branches) {
      const r = await b();
      cut ||= r.cut;
      if (r.m === 'not') return { m: 'not', cut };
      unknown ||= r.m === 'unknown';
    }
    return { m: unknown ? 'unknown' : 'member', cut };
  }

  private vote(permitWhen: ResourceFilter, cacheable = true, reason?: DenyReason): Vote {
    const why = reason ?? (permitWhen === FALSE ? { code: 'no_access', model: this.name } : undefined);
    return { model: this.name, permitWhen, denyWhen: FALSE, ...(why ? { reason: why } : {}), cacheable };
  }

  private error(message: string, cacheable = true): Vote {
    return { model: this.name, permitWhen: FALSE, denyWhen: FALSE, error: message, reason: { code: 'model_error', model: this.name }, cacheable };
  }

  private uninitialised(): never {
    throw new AuthzConfigError(`${this.name}: the model is used before init`);
  }
}

function readLimits(l: RebacLimits): Required<RebacLimits> {
  for (const key of ['maxDepth', 'maxCalls'] as const) {
    const v = l[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new AuthzConfigError(`rebac: limit.${key} must be a positive integer, got ${JSON.stringify(v)}`);
  }
  return { maxDepth: l.maxDepth!, maxCalls: l.maxCalls! };
}

/** The principal a check by reference stands for; its caveats read no attribute it would not have. */
const syntheticPrincipal = (p: PrincipalRef): Principal => ({ type: p.type, id: p.id, authenticated: true, source: 'rebac', attributes: {} });

const IDENTITY = new Set(['principal.type', 'principal.id', 'principal.authenticated', 'principal.source']);

/** Whether the caveat reads the principal's identity, or a principal value its tuple context does not fix. */
const readsAbsentPrincipal = (def: CaveatDef | undefined, c: TupleCaveat): boolean => Object.keys(def?.params ?? {}).some((p) => p.startsWith('principal.') && (IDENTITY.has(p) || !Object.hasOwn(c.context ?? {}, p)));

/** The residual's principal: identity from args, `authenticated` and `source` as the request had them. */
function residualPrincipal(p: PrincipalRef, input: Readonly<Record<string, unknown>>): Principal {
  const { authenticated, source } = { authenticated: input['principal.authenticated'], source: input['principal.source'] };
  return { ...syntheticPrincipal(p), ...(typeof authenticated === 'boolean' ? { authenticated } : {}), ...(typeof source === 'string' ? { source } : {}) };
}

/** The store `authz.<model>.store` names. */
function storeFromConfig(model: string, ctx: Pick<ModelInitContext, 'config'>): TupleStore {
  const name = ctx.config<string>('store', REBAC_DEFAULT_STORE);
  if (name === 'MemoryTupleStore') return new MemoryTupleStore();
  if (name === 'DbTupleStore') return new DbTupleStore();
  throw new AuthzConfigError(`authz.${model}.store names ${JSON.stringify(name)}, which is not a tuple store (${REBAC_STORE_NAMES.join(', ')})`);
}

/** Answers the type-level residual per row with the model's check; `unknown` and a call limit answer false. */
class RebacCheckFilter extends NativeFilter {
  readonly op = REBAC_CHECK_OP;
  // The check reads the principal from args only, and ctx.cache only for tuple reads.
  readonly principalInArgs = true;

  constructor(private readonly model: RebacModel) {
    super();
  }

  async matches(args: unknown, _subject: unknown, ref: ResourceRef, ctx: EvaluationContext): Promise<boolean> {
    const { relation, principal, caveatInput, undecided } = args as { relation: string; principal: PrincipalRef; caveatInput?: Readonly<Record<string, unknown>>; undecided?: readonly string[] };
    const request = caveatInput === undefined ? undefined : { ...overlayContext({ principal: residualPrincipal(principal, caveatInput), env: {} }, caveatInput), undecided: undecided ?? [] };
    try {
      return (await this.model.check(ref, relation, principal, ctx, request)) === 'member';
    } catch (e) {
      if (e instanceof RebacLimitExceeded) return false;
      throw e;
    }
  }
}
