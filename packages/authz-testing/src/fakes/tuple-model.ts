import { AuthorizationModel, AuthzConfigError, CORE_FILTER_OPS, FALSE, GLOBAL, NativeFilter, TRUE, principalKey, resourceKey } from '@spinajs/authz';
import type { DecisionRequest, EvaluationContext, FilterOp, ModelCapabilities, ModelInitContext, ModelSummary, Permission, PermissionDef, Principal, PrincipalRef, ResourceFilter, ResourceRef, ResourceType, Vote } from '@spinajs/authz';

import { TupleStore } from '../rebac.js';
import type { Tuple } from '../rebac.js';
import { samePrincipal, sameRef } from '../util.js';

export const FAKE_TUPLE_OP = 'native:fake.tuple' as const;

type Userset = { readonly object: ResourceRef; readonly relation: string };

const isUserset = (s: Tuple['subject']): s is Userset => 'object' in s;

const tupleKey = (t: Tuple): string => JSON.stringify([resourceKey(t.object), t.relation, isUserset(t.subject) ? [resourceKey(t.subject.object), t.subject.relation] : principalKey(t.subject)]);

export interface TupleWrite {
  readonly add: readonly Tuple[];
  readonly remove: readonly Tuple[];
  readonly actor: PrincipalRef;
  readonly version: string;
}

export class FakeTupleStore extends TupleStore {
  readonly writes: TupleWrite[] = [];
  private readonly tuples = new Map<string, Tuple>();
  private readonly listeners = new Set<(version: string) => void>();
  private revision = 0;

  async read(object: ResourceRef, relation: string): Promise<readonly Tuple[]> {
    return [...this.tuples.values()].filter((t) => t.relation === relation && sameRef(t.object, object));
  }

  async reverse(subject: PrincipalRef, relation: string, objectType: ResourceType): Promise<readonly ResourceRef[]> {
    const out = new Map<string, ResourceRef>();
    for (const t of this.tuples.values()) {
      if (t.relation === relation && t.object.type === objectType && !isUserset(t.subject) && samePrincipal(t.subject, subject)) out.set(resourceKey(t.object), t.object);
    }
    return [...out.values()];
  }

  async write(add: readonly Tuple[], remove: readonly Tuple[], actor: PrincipalRef): Promise<string> {
    for (const t of remove) this.tuples.delete(tupleKey(t));
    for (const t of add) this.tuples.set(tupleKey(t), t);
    const version = String(++this.revision);
    this.writes.push({ add, remove, actor, version });
    for (const fn of [...this.listeners]) fn(version);
    return version;
  }

  /** Every object of `type` that some tuple names as its object. */
  async objects(type: ResourceType): Promise<readonly ResourceRef[]> {
    const out = new Map<string, ResourceRef>();
    for (const t of this.tuples.values()) if (t.object.type === type) out.set(resourceKey(t.object), t.object);
    return [...out.values()];
  }

  onWrite(fn: (version: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Design §8.4 shape. */
export interface FakeTupleNamespace {
  /** relation → allowed direct subjects ('user | group#member'); a tuple's subject may also be a userset. */
  readonly relations?: Readonly<Record<string, string>>;
  /** permission → union of terms: a relation or permission of the same object, or 'tupleset->relation' (arrow). */
  readonly permissions?: Readonly<Record<string, string>>;
}

export type FakeTupleSchema = Readonly<Record<ResourceType, FakeTupleNamespace>>;

export interface FakeTupleModelOptions {
  readonly name?: string;
  readonly store: FakeTupleStore;
  readonly schema: FakeTupleSchema;
  /** permission → '<type>#<relation or permission>', e.g. 'file:read': 'file#view'. */
  readonly permissions: Readonly<Record<Permission, string>>;
  /** Default 8 (design §6.3). Depth = nested relation evaluations, the requested one at 0; a node counts at its shortest distance. */
  readonly maxDepth?: number;
}

type Term = { readonly kind: 'self'; readonly name: string } | { readonly kind: 'arrow'; readonly tupleset: string; readonly target: string };

interface Namespace {
  readonly relations: ReadonlyMap<string, readonly ResourceType[]>;
  readonly permissions: ReadonlyMap<string, readonly Term[]>;
}

class DepthExceeded extends Error {}

/**
 * In-memory ReBAC over a FakeTupleStore: proves the model contract admits ReBAC (G1 item 4).
 * A concrete resource gets a definite vote; a type-level request gets the residual
 * `{ op: 'native:fake.tuple', args: { relation, principal } }`, answered per row by the NativeFilter
 * that init() registers, with the same walk. Cycles contribute nothing. When no proof lies within
 * maxDepth and the walk would go deeper, the vote is indeterminate (error, B04) and the native filter
 * answers false (never put this residual under `not`). Check and list then agree for this model's vote
 * alone: combined with other models, design §7 reads the error as D = TRUE, so under deny-overrides or
 * first-applicable the check refuses a row that another model's residual still lists. Keep graphs
 * within maxDepth where models are combined (the `tupleGraph` arbitrary does).
 *
 * An adapter that serves the types this model routes must list FAKE_TUPLE_OP in `compiles`, e.g.
 * `compiles: [...CORE_FILTER_OPS, FAKE_TUPLE_OP]`: FakeAdapter's default (CORE_FILTER_OPS) leaves it
 * out, so a host running the boot capability check (design §6.5.4) would refuse a list-scoped type.
 */
export class FakeTupleModel extends AuthorizationModel {
  readonly name: string;
  readonly capabilities: ModelCapabilities;
  readonly invalidations: (readonly string[])[] = [];
  readonly nativeFilter: NativeFilter;

  private readonly store: FakeTupleStore;
  private readonly maxDepth: number;
  private readonly namespaces = new Map<ResourceType, Namespace>();
  private readonly mapping = new Map<Permission, { readonly type: ResourceType; readonly name: string }>();
  private revision = 0;
  private readonly unsubscribe: () => void;

  constructor(opts: FakeTupleModelOptions) {
    super();
    this.name = opts.name ?? 'rebac';
    this.store = opts.store;
    this.maxDepth = opts.maxDepth ?? 8;
    this.compile(opts.schema, opts.permissions);
    this.capabilities = {
      effects: ['permit'],
      residuals: Object.freeze([...CORE_FILTER_OPS, FAKE_TUPLE_OP]) as readonly FilterOp[],
      sync: 'never',
      fields: false,
      needsSubject: false,
      resourceTypes: [...new Set([...this.mapping.values()].map((m) => m.type))],
    };
    this.unsubscribe = this.store.onWrite(() => {
      this.revision++;
    });
    this.nativeFilter = new FakeTupleFilter(this);
  }

  init(ctx: ModelInitContext): void {
    ctx.registerNativeFilter(this.nativeFilter);
  }

  applies(permission: PermissionDef, type: ResourceType): boolean {
    return this.mapping.get(permission.name)?.type === type;
  }

  async evaluate(req: DecisionRequest, _ctx: EvaluationContext): Promise<Vote> {
    const target = this.mapping.get(req.permission);
    if (!target || target.type !== req.resource.type) return this.vote(FALSE);
    const principal = { type: req.principal.type, id: req.principal.id };
    if (req.resource.id == null) return this.vote({ op: FAKE_TUPLE_OP, args: { relation: target.name, principal } });
    try {
      return this.vote((await this.holds(req.resource, target.name, principal)) ? TRUE : FALSE);
    } catch (e) {
      if (!(e instanceof DepthExceeded)) throw e;
      return { model: this.name, permitWhen: FALSE, denyWhen: FALSE, error: e.message, reason: { code: 'model_error', model: this.name }, cacheable: true };
    }
  }

  /**
   * Every mapped permission the principal holds on some object at or below `at`. A proof starts
   * with a tuple of the object, so only objects some tuple names can hold anything; each is walked
   * as evaluate walks it. An entry is unconditional only when `at` is the object itself: a tuple
   * grants per object, not on every row below `at`. A walk past maxDepth counts as held, and an
   * object whose ancestors are unknown as below `at` (both conditional), so covers can only refuse more.
   */
  async summarize(principal: Principal, at: ResourceRef, ctx: EvaluationContext): Promise<ModelSummary> {
    const who = { type: principal.type, id: principal.id };
    const conditional = new Map<Permission, boolean>();
    const verdicts = new Map<string, Promise<boolean | 'too-deep'>>();
    const verdict = (object: ResourceRef, name: string): Promise<boolean | 'too-deep'> => {
      const key = `${resourceKey(object)}#${name}`;
      let v = verdicts.get(key);
      if (!v) verdicts.set(key, (v = this.holds(object, name, who).catch((e: unknown) => (e instanceof DepthExceeded ? ('too-deep' as const) : Promise.reject(e)))));
      return v;
    };
    for (const [permission, target] of this.mapping) {
      for (const object of await this.store.objects(target.type)) {
        const placed = await placement(object, at, ctx);
        if (placed === 'outside') continue;
        const held = await verdict(object, target.name);
        if (held === false) continue;
        const firm = placed === 'at' && held === true;
        conditional.set(permission, (conditional.get(permission) ?? true) && !firm);
      }
    }
    return { model: this.name, permissions: [...conditional].map(([name, c]) => ({ name, conditional: c })) };
  }

  invalidate(tags: readonly string[]): void {
    this.invalidations.push(tags);
  }

  version(): string {
    return String(this.revision);
  }

  async dispose(): Promise<void> {
    this.unsubscribe();
  }

  /**
   * Does `principal` hold `name` (relation or permission) on `object`? Breadth-first, each object#name
   * once per call, so cycles end and a dense graph costs one read per node. TRUE when a node within
   * maxDepth proves it; otherwise throws if the walk would go past maxDepth; otherwise FALSE.
   */
  async holds(object: ResourceRef, name: string, principal: PrincipalRef): Promise<boolean> {
    const reads = new Map<string, Promise<readonly Tuple[]>>();
    const read = (o: ResourceRef, relation: string): Promise<readonly Tuple[]> => {
      const key = `${resourceKey(o)}#${relation}`;
      let tuples = reads.get(key);
      if (!tuples) reads.set(key, (tuples = this.store.read(o, relation)));
      return tuples;
    };
    const seen = new Set([`${resourceKey(object)}#${name}`]);
    let tooDeep: string | undefined;
    let level: { readonly object: ResourceRef; readonly name: string }[] = [{ object, name }];

    for (let depth = 0; level.length > 0; depth++) {
      const next: typeof level = [];
      const visit = (o: ResourceRef, n: string) => {
        const key = `${resourceKey(o)}#${n}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (depth + 1 > this.maxDepth) tooDeep ??= key;
        else next.push({ object: o, name: n });
      };
      for (const node of level) {
        const ns = this.namespaces.get(node.object.type);
        const terms = ns?.permissions.get(node.name);
        if (terms) {
          for (const t of terms) {
            if (t.kind === 'self') visit(node.object, t.name);
            else for (const tp of await read(node.object, t.tupleset)) visit(isUserset(tp.subject) ? tp.subject.object : { type: tp.subject.type, id: tp.subject.id }, t.target);
          }
        } else if (ns?.relations.has(node.name)) {
          for (const tp of await read(node.object, node.name)) {
            if (!isUserset(tp.subject)) {
              if (samePrincipal(tp.subject, principal)) return true;
            } else visit(tp.subject.object, tp.subject.relation);
          }
        }
      }
      level = next;
    }
    if (tooDeep) throw new DepthExceeded(`fake.tuple: max depth ${this.maxDepth} exceeded at ${tooDeep}`);
    return false;
  }

  private vote(permitWhen: ResourceFilter): Vote {
    return { model: this.name, permitWhen, denyWhen: FALSE, ...(permitWhen === FALSE ? { reason: { code: 'no_access', model: this.name } } : {}), cacheable: true };
  }

  private compile(schema: FakeTupleSchema, permissions: Readonly<Record<Permission, string>>): void {
    const fail = (msg: string): never => {
      throw new AuthzConfigError(`FakeTupleModel: ${msg}`);
    };
    for (const [type, ns] of Object.entries(schema)) {
      const relations = new Map(Object.entries(ns.relations ?? {}).map(([r, subjects]) => [r, subjects.split('|').map((s) => s.trim().split('#')[0])] as const));
      const perms = new Map(Object.entries(ns.permissions ?? {}).map(([p, expr]) => [p, expr.split('|').map((term) => parseTerm(term.trim()))] as const));
      this.namespaces.set(type, { relations, permissions: perms });
    }
    const has = (type: ResourceType, name: string) => this.namespaces.get(type)?.relations.has(name) || this.namespaces.get(type)?.permissions.has(name);

    for (const [type, ns] of this.namespaces) {
      for (const [p, terms] of ns.permissions) {
        if (ns.relations.has(p)) fail(`${type}#${p} is both a relation and a permission`);
        for (const t of terms) {
          if (t.kind === 'self' && !has(type, t.name)) fail(`${type}#${p} names unknown ${t.name}`);
          if (t.kind === 'arrow') {
            const targets = ns.relations.get(t.tupleset) ?? fail(`${type}#${p}: arrow over unknown relation ${t.tupleset}`);
            for (const tt of targets) if (this.namespaces.has(tt) && !has(tt, t.target)) fail(`${type}#${p}: ${tt} has no ${t.target}`);
          }
        }
      }
    }
    for (const [permission, ref] of Object.entries(permissions)) {
      const [type, name] = ref.split('#');
      if (!name || !has(type, name)) fail(`${permission} maps to unknown ${ref}`);
      this.mapping.set(permission, { type, name });
    }
  }
}

/** Where `object` lies against `at`: the node itself, below it, outside it, or unknown (no ancestors). */
async function placement(object: ResourceRef, at: ResourceRef, ctx: EvaluationContext): Promise<'at' | 'below' | 'outside' | 'unknown'> {
  if (sameRef(object, at)) return 'at';
  if (sameRef(at, GLOBAL)) return 'below';
  if (at.id == null && object.type === at.type) return 'below';
  const chain = await ctx.ancestors(object);
  if (chain == null) return 'unknown';
  const inside = at.id == null ? chain.some((a) => a.type === at.type && a.id != null) : chain.some((a) => sameRef(a, at));
  return inside ? 'below' : 'outside';
}

function parseTerm(term: string): Term {
  const at = term.indexOf('->');
  return at < 0 ? { kind: 'self', name: term } : { kind: 'arrow', tupleset: term.slice(0, at).trim(), target: term.slice(at + 2).trim() };
}

class FakeTupleFilter extends NativeFilter {
  readonly op = FAKE_TUPLE_OP;
  // The walk reads the principal from args only, never the request principal or ctx.cache.
  readonly principalInArgs = true;

  constructor(private readonly model: FakeTupleModel) {
    super();
  }

  async matches(args: unknown, _subject: unknown, ref: ResourceRef): Promise<boolean> {
    const { relation, principal } = args as { relation: string; principal: PrincipalRef };
    try {
      return await this.model.holds(ref, relation, principal);
    } catch (e) {
      if (e instanceof DepthExceeded) return false;
      throw e;
    }
  }
}
