import { CORE_FILTER_OPS, GLOBAL, RelationResolver, ResourceAdapter, resourceKey } from '@spinajs/authz';
import type { FilterOp, PermissionDef, ResourceFilter, ResourceRef, ResourceType } from '@spinajs/authz';

import { evaluateFilter } from '../filter-eval.js';
import type { FilterEnv } from '../filter-eval.js';
import { readPath } from '../util.js';
import { FakeRelationResolver } from './relation-resolver.js';

export interface FakeRow {
  readonly id: string;
  readonly [field: string]: unknown;
}

/** A relation held when `row[column] === principal.id`. */
export interface FakeColumnRelation {
  readonly type: ResourceType;
  readonly relation: string;
  readonly column: string;
}

export interface FakeAdapterOptions {
  readonly kind?: string;
  readonly types: readonly ResourceType[];
  readonly rows?: Readonly<Record<ResourceType, readonly FakeRow[]>>;
  /** child → parent links; a parent need not be a row of this adapter. */
  readonly parents?: readonly (readonly [child: ResourceRef, parent: ResourceRef])[];
  readonly relations?: readonly (RelationResolver | FakeColumnRelation)[];
  /** Scope attributes per node; a known row without an entry has {}. */
  readonly attributes?: readonly (readonly [ResourceRef, Readonly<Record<string, unknown>>])[];
  /** Default: the core ops, all of which it applies in memory (rows()). Pass undefined for "not list-scoped". */
  readonly compiles?: readonly FilterOp[];
  readonly permissions?: readonly Omit<PermissionDef, 'source'>[];
}

/** In-memory rows per type. */
export class FakeAdapter extends ResourceAdapter<FakeRow> {
  readonly kind: string;
  readonly types: readonly ResourceType[];
  readonly compiles?: readonly FilterOp[];

  private readonly tables = new Map<ResourceType, Map<string, FakeRow>>();
  private readonly owners = new WeakMap<object, ResourceRef>();
  private readonly parentOf = new Map<string, ResourceRef>();
  private readonly attrs = new Map<string, Readonly<Record<string, unknown>>>();
  private readonly resolvers: readonly RelationResolver[];
  private readonly defs?: readonly Omit<PermissionDef, 'source'>[];

  constructor(opts: FakeAdapterOptions) {
    super();
    this.kind = opts.kind ?? 'fake';
    this.types = opts.types;
    this.compiles = 'compiles' in opts ? opts.compiles : CORE_FILTER_OPS;
    this.defs = opts.permissions;
    for (const [type, rows] of Object.entries(opts.rows ?? {})) for (const row of rows) this.add(type, row);
    for (const [child, parent] of opts.parents ?? []) this.parentOf.set(resourceKey(child), parent);
    for (const [ref, a] of opts.attributes ?? []) this.attrs.set(resourceKey(ref), a);
    this.resolvers = (opts.relations ?? []).map((r) => (r instanceof RelationResolver ? r : this.columnRelation(r)));
  }

  add(type: ResourceType, row: FakeRow, parent?: ResourceRef): this {
    let table = this.tables.get(type);
    if (!table) this.tables.set(type, (table = new Map()));
    table.set(row.id, row);
    this.owners.set(row, { type, id: row.id });
    if (parent) this.parentOf.set(resourceKey({ type, id: row.id }), parent);
    return this;
  }

  remove(type: ResourceType, id: string): this {
    this.tables.get(type)?.delete(id);
    this.parentOf.delete(resourceKey({ type, id }));
    return this;
  }

  /** The rows of `type` in insertion order. */
  all(type: ResourceType): FakeRow[] {
    return [...(this.tables.get(type)?.values() ?? [])];
  }

  accepts(target: unknown): target is FakeRow {
    return typeof target === 'object' && target !== null && this.owners.has(target);
  }

  refOf(target: FakeRow): ResourceRef {
    return this.owners.get(target)!;
  }

  async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    if (ref.id == null) return [ref, GLOBAL];
    if (!this.row(ref)) return null;
    const out: ResourceRef[] = [];
    const seen = new Set<string>();
    for (let at: ResourceRef | undefined = ref; at; at = this.parentOf.get(resourceKey(at))) {
      if (seen.has(resourceKey(at))) throw new Error(`FakeAdapter: parent cycle at ${resourceKey(at)}`);
      seen.add(resourceKey(at));
      out.push(at);
    }
    out.push(GLOBAL);
    return out;
  }

  async scopeAttributes(ref: ResourceRef): Promise<Readonly<Record<string, unknown>> | null> {
    const given = this.attrs.get(resourceKey(ref));
    if (given) return given;
    return this.row(ref) ? {} : null;
  }

  async load(ref: ResourceRef): Promise<FakeRow | null> {
    return this.row(ref) ?? null;
  }

  attribute(subject: unknown, field: string): unknown {
    return readPath(subject, field);
  }

  relations(): readonly RelationResolver[] {
    return this.resolvers;
  }

  permissions(): readonly Omit<PermissionDef, 'source'>[] {
    return this.defs ?? [];
  }

  /** The rows of `type` a residual selects, by the reference evaluator: the filter side of check ⇔ filter (B06). */
  async rows(type: ResourceType, filter: ResourceFilter, env: Omit<FilterEnv, 'ref'>): Promise<FakeRow[]> {
    const out: FakeRow[] = [];
    for (const row of this.all(type)) {
      const ref = { type, id: row.id };
      const result = await evaluateFilter(filter, row, {
        ...env,
        ref,
        ancestors: env.ancestors ?? ((r) => (env.context ? env.context.ancestors(r) : this.ancestors(r))),
        attributes: env.attributes ?? ((r) => (env.context ? env.context.attributes(r) : this.scopeAttributes(r))),
        relation: env.relation ?? ((t, n) => env.context?.relation(t, n) ?? this.resolvers.find((r) => r.type === t && r.relation === n)),
        attribute: env.attribute ?? ((s, f) => this.attribute(s, f)),
      });
      if (result === true) out.push(row);
    }
    return out;
  }

  private row(ref: ResourceRef): FakeRow | undefined {
    return ref.id == null ? undefined : this.tables.get(ref.type)?.get(ref.id);
  }

  private columnRelation(r: FakeColumnRelation): RelationResolver {
    return new FakeRelationResolver(r.type, r.relation, async (principal, ref, subject) => {
      const row = subject ?? (await this.load(ref));
      return row != null && readPath(row, r.column) === principal.id;
    });
  }
}
