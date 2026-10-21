import { AuthorizationModel, AuthzConfigError, CORE_FILTER_OPS, FALSE, NativeFilter, TRUE, UnknownPermission } from '@spinajs/authz';
import type { DecisionRequest, EvaluationContext, FilterOp, ListPlanRequest, ListSupport, ModelCapabilities, ModelInitContext, ModelListPlan, PermissionDef, PermissionRegistry, PrincipalRef, ResourceFilter, ResourceRef, ResourceType, Vote } from '@spinajs/authz';

import type { NamespaceConfig, PermissionMap, RebacLimits, Tuple } from '../contracts.js';
import { TupleStore } from '../contracts.js';
import { isSubjectSet, objectKey } from '../keys.js';
import { NamespaceSchema } from '../namespace/compile.js';
import type { CompiledRewrite } from '../namespace/compile.js';
import { REBAC_DEFAULT_LIMITS, REBAC_DEFAULT_STORE, REBAC_STORE_NAMES } from '../namespace/schema.js';
import { DbTupleStore } from '../stores/db.js';
import { MemoryTupleStore } from '../stores/memory.js';
import { rebacListPlan, rebacListSupport } from './filter.js';

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

interface Walk {
  readonly principal: PrincipalRef;
  readonly maxDepth: number;
  readonly maxCalls: number;
  readonly read: (object: ResourceRef, relation: string) => Promise<readonly Tuple[]>;
  readonly memo: Map<string, Membership>;
  readonly path: Set<string>;
  calls: number;
  tooDeep?: string;
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
    this.compiled = NamespaceSchema.compile(this.opts.namespaces ?? ctx.config<NamespaceConfig>('namespaces', {}), this.opts.permissions ?? ctx.config<PermissionMap>('permissions', {}));
    this.registry = ctx.permissions;
    this.permissionsChecked = false;
    this.tuples = this.opts.store ?? (ctx.container.hasRegistered(TupleStore) ? await ctx.container.resolve(TupleStore) : storeFromConfig(this.name, ctx));
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
    if (req.resource.id == null) return this.vote({ op: REBAC_CHECK_OP, args: { relation: target.name, principal } });
    try {
      const { membership, tooDeep } = await this.walk(req.resource, target.name, principal, ctx);
      if (membership === 'member') return this.vote(TRUE);
      if (membership === 'not') return this.vote(FALSE);
      return this.error(`${this.name}: maxDepth ${this.limits.maxDepth} exceeded at ${tooDeep ?? objectKey(req.resource)}`);
    } catch (e) {
      if (e instanceof RebacLimitExceeded) return this.error(e.message);
      throw e;
    }
  }

  /** Lists can be planned for every rewrite but exclusion (design §6.2). */
  listSupport(permission: PermissionDef, type: ResourceType): ListSupport {
    return rebacListSupport(this.schema(), permission.name, type);
  }

  async listPlan(req: ListPlanRequest, _ctx: EvaluationContext): Promise<ModelListPlan> {
    return rebacListPlan({ schema: this.schema(), store: this.store(), principal: { type: req.principal.type, id: req.principal.id }, permission: req.permission.name, type: req.type, maxDepth: this.limits.maxDepth });
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

  /** Does `principal` hold `name` (a relation or permission) on `object`? @throws RebacLimitExceeded past maxCalls */
  async check(object: ResourceRef, name: string, principal: PrincipalRef, ctx?: EvaluationContext): Promise<Membership> {
    return (await this.walk(object, name, principal, ctx)).membership;
  }

  private async walk(object: ResourceRef, name: string, principal: PrincipalRef, ctx?: EvaluationContext): Promise<{ membership: Membership; tooDeep?: string }> {
    const store = this.store();
    const local = new Map<string, Promise<readonly Tuple[]>>();
    const cache: Map<string, unknown> = ctx?.cache ?? local;
    const read = (o: ResourceRef, relation: string): Promise<readonly Tuple[]> => {
      const key = `rebac:read:${objectKey(o)}#${relation}`;
      let tuples = cache.get(key) as Promise<readonly Tuple[]> | undefined;
      if (!tuples) cache.set(key, (tuples = store.read(o, relation)));
      return tuples;
    };
    const w: Walk = { principal: { type: principal.type, id: principal.id }, maxDepth: this.limits.maxDepth, maxCalls: this.limits.maxCalls, read, memo: new Map(), path: new Set(), calls: 0 };
    const { m } = await this.node(object, name, 0, w);
    return { membership: m, ...(w.tooDeep ? { tooDeep: w.tooDeep } : {}) };
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
      const s = t.subject;
      if (!isSubjectSet(s)) {
        if (rel.direct.includes(s.type) && s.type === w.principal.type && s.id === w.principal.id) return { m: 'member', cut: false };
        continue;
      }
      if (!rel.sets.some((x) => x.type === s.object.type && x.relation === s.relation)) continue;
      const r = await this.hop(s.object, s.relation, depth, w);
      if (r.m === 'member') return r;
      unknown ||= r.m === 'unknown';
      cut ||= r.cut;
    }
    return { m: unknown ? 'unknown' : 'not', cut };
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
    const objects = (await w.read(object, tupleset)).flatMap((t) => (!isSubjectSet(t.subject) && rel.direct.includes(t.subject.type) && this.schema().namespaces.has(t.subject.type) ? [{ type: t.subject.type, id: t.subject.id }] : []));
    return this.any(objects.map((o) => () => this.hop(o, computed, depth, w)));
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

  private vote(permitWhen: ResourceFilter): Vote {
    return { model: this.name, permitWhen, denyWhen: FALSE, ...(permitWhen === FALSE ? { reason: { code: 'no_access', model: this.name } } : {}), cacheable: true };
  }

  private error(message: string): Vote {
    return { model: this.name, permitWhen: FALSE, denyWhen: FALSE, error: message, reason: { code: 'model_error', model: this.name }, cacheable: true };
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
    const { relation, principal } = args as { relation: string; principal: PrincipalRef };
    try {
      return (await this.model.check(ref, relation, principal, ctx)) === 'member';
    } catch (e) {
      if (e instanceof RebacLimitExceeded) return false;
      throw e;
    }
  }
}
