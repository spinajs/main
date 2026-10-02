import { ConditionCompiler, PermissionRegistry, resourceKey } from '@spinajs/authz';
import type { Decision, DecisionRequest, EvaluationContext, ModelInitContext, NativeFilter, PermissionDef, RelationResolver, ResourceAdapter, ResourceRef, ResourceType, ScopeResolver, TraceStep } from '@spinajs/authz';

import { FakePermissionRegistry, toPermissionDef } from './registry.js';
import type { FakePermissionInput } from './registry.js';
import { defaultAncestors, readPath } from './util.js';

export class ThrowingConditionCompiler extends ConditionCompiler {
  async compile(): Promise<never> {
    throw new Error('no condition compiler in this fake: pass `conditions` to fakeEvaluationContext');
  }
}

export interface FakeEvaluationContextOptions {
  readonly domain?: string;
  /** A fixed Date, or a clock read once (EvaluationContext.now is per request). Default: the real now. */
  readonly now?: Date | { now(): Date };
  readonly permissions?: PermissionRegistry | readonly FakePermissionInput[];
  /** Asked first for ancestors and attributes of their types, and for relations. */
  readonly adapters?: readonly ResourceAdapter[];
  readonly scopeResolvers?: readonly ScopeResolver[];
  /** Found before the adapters' relations. */
  readonly relations?: readonly RelationResolver[];
  readonly nativeFilters?: readonly NativeFilter[];
  readonly conditions?: ConditionCompiler;
  readonly check?: (req: Omit<DecisionRequest, 'explain'>) => Promise<Decision>;
  readonly cache?: Map<string, unknown>;
}

export interface MemoStats {
  /** Calls made by the code under test. */
  readonly calls: number;
  /** Calls that reached an adapter or resolver (memo misses). */
  readonly loads: number;
  /** resourceKey of each load, in order. */
  readonly keys: readonly string[];
}

export interface FakeEvaluationContext extends EvaluationContext {
  /** trace() steps, as given. */
  readonly steps: readonly Omit<TraceStep, 'by'>[];
  readonly stats: { readonly ancestors: MemoStats; readonly attributes: MemoStats };
  nativeFilter(op: string): NativeFilter | undefined;
}

class Memo<T> {
  private readonly values = new Map<string, Promise<T>>();
  private counts = { calls: 0, loads: 0, keys: [] as string[] };

  constructor(private readonly load: (ref: ResourceRef) => T | Promise<T>) {}

  get(ref: ResourceRef): Promise<T> {
    this.counts.calls++;
    const key = resourceKey(ref);
    let hit = this.values.get(key);
    if (!hit) {
      this.counts.loads++;
      this.counts.keys.push(key);
      hit = Promise.resolve().then(() => this.load(ref));
      this.values.set(key, hit);
    }
    return hit;
  }

  get stats(): MemoStats {
    return { calls: this.counts.calls, loads: this.counts.loads, keys: [...this.counts.keys] };
  }
}

/**
 * An EvaluationContext for one request. Ancestors and attributes come from the adapter, then the
 * scope resolver that lists the type, else the design's default for an unregistered type:
 * ancestors = [ref, GLOBAL], attributes = {} (§5.6). Both are memoised per context and counted.
 */
export function fakeEvaluationContext(opts: FakeEvaluationContextOptions = {}): FakeEvaluationContext {
  const adapters = opts.adapters ?? [];
  const resolvers = opts.scopeResolvers ?? [];
  const adapterFor = (type: ResourceType) => adapters.find((a) => a.types.includes(type));
  const resolverFor = (type: ResourceType) => resolvers.find((r) => r.types.includes(type));
  const relations = [...(opts.relations ?? []), ...adapters.flatMap((a) => a.relations?.() ?? [])];
  const natives = new Map<string, NativeFilter>();
  for (const n of opts.nativeFilters ?? []) natives.set(n.op, n);

  const ancestors = new Memo<readonly ResourceRef[] | null>((ref) => {
    const source = adapterFor(ref.type) ?? resolverFor(ref.type);
    return source ? source.ancestors(ref) : defaultAncestors(ref);
  });

  const attributes = new Memo<Readonly<Record<string, unknown>> | null>((ref) => {
    const adapter = adapterFor(ref.type);
    if (adapter) return adapter.scopeAttributes ? adapter.scopeAttributes(ref) : {};
    const resolver = resolverFor(ref.type);
    if (resolver?.attributes) return resolver.attributes(ref);
    return {};
  });

  const steps: Omit<TraceStep, 'by'>[] = [];
  const now = opts.now === undefined ? new Date() : opts.now instanceof Date ? new Date(opts.now.getTime()) : opts.now.now();

  return {
    domain: opts.domain ?? 'root',
    now,
    permissions: opts.permissions instanceof PermissionRegistry ? opts.permissions : new FakePermissionRegistry(opts.permissions ?? []),
    conditions: opts.conditions ?? new ThrowingConditionCompiler(),
    cache: opts.cache ?? new Map(),
    steps,
    get stats() {
      return { ancestors: ancestors.stats, attributes: attributes.stats };
    },
    ancestors: (ref) => ancestors.get(ref),
    attributes: (ref) => attributes.get(ref),
    relation: (type, name) => relations.find((r) => r.type === type && r.relation === name),
    check: opts.check ?? (() => Promise.reject(new Error('fakeEvaluationContext: no check delegate: pass `check`'))),
    trace: (step) => {
      steps.push(step);
    },
    nativeFilter: (op) => natives.get(op),
  };
}

export interface FakeModelInitContextOptions {
  readonly domain?: string;
  /** The model's config section (what `authz.<model>.*` holds); config(path) reads a dotted path in it. */
  readonly config?: Readonly<Record<string, unknown>>;
  /** Registered permissions are added here when it is a FakePermissionRegistry. */
  readonly permissions?: PermissionRegistry | readonly FakePermissionInput[];
  /** Source of registered permissions: 'model:<model>'. */
  readonly model?: string;
}

export interface FakeModelInitContext extends ModelInitContext {
  readonly registered: {
    readonly permissions: readonly PermissionDef[];
    readonly nativeFilters: readonly NativeFilter[];
    readonly relations: readonly RelationResolver[];
  };
}

export function fakeModelInitContext(opts: FakeModelInitContextOptions = {}): FakeModelInitContext {
  const registry = opts.permissions instanceof PermissionRegistry ? opts.permissions : new FakePermissionRegistry(opts.permissions ?? []);
  const permissions: PermissionDef[] = [];
  const nativeFilters: NativeFilter[] = [];
  const relations: RelationResolver[] = [];
  const source = `model:${opts.model ?? 'fake'}`;

  return {
    domain: opts.domain ?? 'root',
    permissions: registry,
    config: <T>(path: string, dflt?: T): T => {
      const v = readPath(opts.config ?? {}, path);
      return (v === undefined ? dflt : v) as T;
    },
    registerPermissions(defs) {
      for (const d of defs) {
        const def = toPermissionDef({ ...d, source }, source);
        permissions.push(def);
        if (registry instanceof FakePermissionRegistry) registry.register(def);
      }
    },
    registerNativeFilter: (f) => {
      nativeFilters.push(f);
    },
    registerRelation: (r) => {
      relations.push(r);
    },
    registered: { permissions, nativeFilters, relations },
  };
}
