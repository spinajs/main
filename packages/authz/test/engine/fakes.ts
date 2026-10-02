import { AuthorizationModel, CORE_FILTER_OPS, DecisionAudit, FALSE, GLOBAL, NativeFilter, RelationResolver, ResourceAdapter, ScopeResolver, TRUE, resourceKey } from '../../src/index.js';
import type { DecisionRequest, EvaluationContext, ModelCapabilities, PermissionDef, Principal, PrincipalType, ResourceFilter, ResourceRef, ResourceType, Trace, Vote } from '../../src/index.js';
import { PermissionRegistryImpl } from '../../src/engine/registry.js';
import type { PermissionInput } from '../../src/engine/registry.js';
import type { EngineLog } from '../../src/engine/authorizer.js';

export type VoteSpec = Partial<Vote> | ((req: DecisionRequest, ctx: EvaluationContext) => unknown);

export interface StaticModelOptions {
  readonly capabilities?: Partial<ModelCapabilities>;
  readonly applies?: (def: PermissionDef, type: ResourceType) => boolean;
  /** A vote (merged over a FALSE/FALSE cacheable default) or a function whose result is returned as is. */
  readonly vote?: VoteSpec;
  /** Resolve the vote after this many ms (a promise is returned). */
  readonly delayMs?: number;
  /** Return the vote through a resolved promise. */
  readonly async?: boolean;
  /** Throw this from evaluate. */
  readonly throws?: unknown;
}

export const DEFAULT_CAPABILITIES: ModelCapabilities = Object.freeze({ effects: Object.freeze(['permit', 'deny'] as const), residuals: CORE_FILTER_OPS, sync: 'always', fields: false, needsSubject: false });

export class StaticModel extends AuthorizationModel {
  readonly capabilities: ModelCapabilities;
  readonly calls: { readonly req: DecisionRequest; readonly ctx: EvaluationContext }[] = [];
  readonly preloads: Principal[] = [];
  readonly invalidations: (readonly string[])[] = [];
  preloadImpl?: (p: Principal) => Promise<void>;
  invalidateImpl?: (tags: readonly string[]) => void;

  constructor(readonly name: string, private readonly options: StaticModelOptions = {}) {
    super();
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  }

  init(): void {}

  applies(def: PermissionDef, type: ResourceType): boolean {
    return this.options.applies ? this.options.applies(def, type) : true;
  }

  evaluate(req: DecisionRequest, ctx: EvaluationContext): Vote | Promise<Vote> {
    this.calls.push({ req, ctx });
    if (this.options.throws !== undefined) throw this.options.throws;
    const spec = this.options.vote ?? {};
    const vote = (typeof spec === 'function' ? spec(req, ctx) : { model: this.name, permitWhen: FALSE, denyWhen: FALSE, cacheable: true, ...spec }) as Vote;
    if (this.options.delayMs !== undefined) {
      return new Promise((resolve) => setTimeout(() => resolve(vote), this.options.delayMs));
    }
    return this.options.async ? Promise.resolve(vote) : vote;
  }

  async preload(p: Principal): Promise<void> {
    this.preloads.push(p);
    if (this.preloadImpl) await this.preloadImpl(p);
  }

  invalidate(tags: readonly string[]): void {
    this.invalidations.push(tags);
    this.invalidateImpl?.(tags);
  }
}

export const permit = (when: ResourceFilter = TRUE, extra: Partial<Vote> = {}): Partial<Vote> => ({ permitWhen: when, ...extra });
export const deny = (when: ResourceFilter = TRUE, extra: Partial<Vote> = {}): Partial<Vote> => ({ denyWhen: when, ...extra });

/** A row an adapter accepts; attributes are own properties. */
export class FakeRow {
  [k: string]: unknown;
  constructor(readonly $type: ResourceType, readonly id: string, attributes: Record<string, unknown> = {}, readonly $parent?: ResourceRef) {
    Object.assign(this, attributes);
  }
}

export interface FakeAdapterOptions {
  readonly kind?: string;
  readonly rows?: readonly FakeRow[];
  /** Extra nodes (not rows) with parent links, keyed by resourceKey. */
  readonly nodes?: Readonly<Record<string, ResourceRef | null>>;
  readonly attribute?: (subject: unknown, field: string) => unknown;
  readonly relations?: readonly RelationResolver[];
  readonly scopeAttributes?: Readonly<Record<string, Readonly<Record<string, unknown>> | null>>;
  readonly asyncRefOf?: boolean;
}

export class FakeAdapter extends ResourceAdapter<FakeRow> {
  readonly kind: string;
  readonly ancestorCalls: ResourceRef[] = [];
  readonly refOfCalls: FakeRow[] = [];
  readonly attributeCalls: ResourceRef[] = [];
  private readonly parents = new Map<string, ResourceRef | null>();
  attribute?: (subject: unknown, field: string) => unknown;

  constructor(readonly types: readonly ResourceType[], private readonly options: FakeAdapterOptions = {}) {
    super();
    this.kind = options.kind ?? 'fake';
    for (const row of options.rows ?? []) this.add(row);
    for (const [key, parent] of Object.entries(options.nodes ?? {})) this.parents.set(key, parent);
    if (options.attribute) this.attribute = options.attribute;
  }

  add(row: FakeRow): void {
    this.parents.set(resourceKey({ type: row.$type, id: row.id }), row.$parent ?? null);
  }

  accepts(target: unknown): target is FakeRow {
    return target instanceof FakeRow && this.types.includes(target.$type);
  }

  refOf(target: FakeRow): ResourceRef | Promise<ResourceRef> {
    this.refOfCalls.push(target);
    const ref = { type: target.$type, id: target.id };
    return this.options.asyncRefOf ? Promise.resolve(ref) : ref;
  }

  async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    this.ancestorCalls.push(ref);
    if (ref.id === undefined) return [ref, GLOBAL];
    const key = resourceKey(ref);
    if (!this.parents.has(key)) return null;
    const out: ResourceRef[] = [ref];
    let parent = this.parents.get(key) ?? null;
    while (parent && out.length < 32) {
      out.push(parent);
      parent = this.parents.get(resourceKey(parent)) ?? null;
    }
    out.push(GLOBAL);
    return out;
  }

  async scopeAttributes(ref: ResourceRef): Promise<Readonly<Record<string, unknown>> | null> {
    this.attributeCalls.push(ref);
    return this.options.scopeAttributes?.[resourceKey(ref)] ?? {};
  }

  relations(): readonly RelationResolver[] {
    return this.options.relations ?? [];
  }
}

export class FakeScopeResolver extends ScopeResolver {
  readonly ancestorCalls: ResourceRef[] = [];
  readonly attributeCalls: ResourceRef[] = [];

  constructor(
    readonly types: readonly ResourceType[],
    /** resourceKey => parent (null = root below GLOBAL); a missing key is an unknown node. */
    private readonly nodes: Readonly<Record<string, ResourceRef | null>> = {},
    private readonly attrs: Readonly<Record<string, Readonly<Record<string, unknown>> | null>> = {},
  ) {
    super();
  }

  async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    this.ancestorCalls.push(ref);
    if (!Object.hasOwn(this.nodes, resourceKey(ref))) return null;
    const out: ResourceRef[] = [ref];
    let parent = this.nodes[resourceKey(ref)];
    while (parent && out.length < 32) {
      out.push(parent);
      parent = this.nodes[resourceKey(parent)] ?? null;
    }
    out.push(GLOBAL);
    return out;
  }

  async attributes(ref: ResourceRef): Promise<Readonly<Record<string, unknown>> | null> {
    this.attributeCalls.push(ref);
    return Object.hasOwn(this.attrs, resourceKey(ref)) ? this.attrs[resourceKey(ref)] : {};
  }
}

export class FakeRelation extends RelationResolver {
  readonly calls: { principal: Principal; ref: ResourceRef; subject: unknown }[] = [];

  constructor(readonly type: ResourceType, readonly relation: string, private readonly fn: (principal: Principal, ref: ResourceRef, subject: unknown) => boolean | Promise<boolean>) {
    super();
  }

  holds(principal: Principal, ref: ResourceRef, subject?: unknown): boolean | Promise<boolean> {
    this.calls.push({ principal, ref, subject });
    return this.fn(principal, ref, subject);
  }
}

export class FakeNativeFilter extends NativeFilter {
  readonly calls: { args: unknown; subject: unknown; ref: ResourceRef }[] = [];

  constructor(readonly op: `native:${string}`, private readonly fn: (args: unknown, subject: unknown, ref: ResourceRef, ctx: EvaluationContext) => boolean | Promise<boolean>) {
    super();
  }

  matches(args: unknown, subject: unknown, ref: ResourceRef, ctx: EvaluationContext): boolean | Promise<boolean> {
    this.calls.push({ args, subject, ref });
    return this.fn(args, subject, ref, ctx);
  }
}

export interface FakeClock {
  readonly clock: () => Date;
  now: Date;
  advance(ms: number): void;
}

export const fakeClock = (start = '2026-10-01T12:00:00.000Z'): FakeClock => {
  const c: FakeClock = {
    now: new Date(start),
    clock: () => new Date(c.now.getTime()),
    advance(ms: number) {
      c.now = new Date(c.now.getTime() + ms);
    },
  };
  return c;
};

export type AuditEntry = Parameters<DecisionAudit['record']>[0];

export class RecordingAudit extends DecisionAudit {
  readonly entries: AuditEntry[] = [];
  mode: 'ok' | 'throw' | 'reject' = 'ok';

  record(e: AuditEntry): void | Promise<void> {
    this.entries.push(e);
    if (this.mode === 'throw') throw new Error('audit down');
    if (this.mode === 'reject') return Promise.reject(new Error('audit down'));
  }

  kinds(): string[] {
    return this.entries.map((e) => e.kind);
  }

  traces(): (Trace | undefined)[] {
    return this.entries.map((e) => e.trace);
  }
}

export interface LogEntry {
  readonly level: 'error' | 'warn' | 'debug';
  readonly message: string;
  readonly args: unknown[];
}

export class RecordingLog implements EngineLog {
  readonly entries: LogEntry[] = [];

  error(message: string, ...args: unknown[]): void {
    this.entries.push({ level: 'error', message, args });
  }

  warn(message: string, ...args: unknown[]): void {
    this.entries.push({ level: 'warn', message, args });
  }

  debug(message: string, ...args: unknown[]): void {
    this.entries.push({ level: 'debug', message, args });
  }

  at(level: LogEntry['level']): LogEntry[] {
    return this.entries.filter((e) => e.level === level);
  }
}

export const principal = (type: PrincipalType, id: string, extra: Partial<Principal> = {}): Principal => ({ type, id, authenticated: true, source: 'session', attributes: {}, ...extra });

/** A frozen registry with the given permissions. */
export const registryOf = (defs: readonly PermissionInput[], source = 'test'): PermissionRegistryImpl => {
  const r = new PermissionRegistryImpl();
  r.register(defs, source);
  r.freeze();
  return r;
};
