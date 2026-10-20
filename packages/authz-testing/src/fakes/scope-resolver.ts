import { GLOBAL, ScopeResolver, resourceKey } from '@spinajs/authz';
import type { ResourceRef, ResourceType } from '@spinajs/authz';

import { clonePlain, deepFreeze, deepMerge } from '../util.js';

export interface FakeScopeNode {
  readonly ref: ResourceRef;
  readonly parent?: ResourceRef;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface FakeScopeResolverOptions {
  /** Default: every type added as a node or a parent. */
  readonly types?: readonly ResourceType[];
  readonly nodes?: readonly FakeScopeNode[];
  /** Per type; node attributes are deep-merged over them (ScopeResolver.attributes "must fill defaults"). */
  readonly defaults?: Readonly<Record<ResourceType, Readonly<Record<string, unknown>>>>;
}

/** A tree of scope nodes. A node is known once added or named as a parent; unknown nodes give null. */
export class FakeScopeResolver extends ScopeResolver {
  private readonly nodes = new Map<string, { ref: ResourceRef; parent?: ResourceRef; attributes: Readonly<Record<string, unknown>> }>();
  private readonly fixedTypes?: readonly ResourceType[];
  private readonly defaults: Readonly<Record<ResourceType, Readonly<Record<string, unknown>>>>;

  constructor(opts: FakeScopeResolverOptions = {}) {
    super();
    this.fixedTypes = opts.types;
    this.defaults = opts.defaults ?? {};
    for (const n of opts.nodes ?? []) this.add(n.ref, n.parent, n.attributes);
  }

  get types(): readonly ResourceType[] {
    return this.fixedTypes ?? [...new Set([...this.nodes.values()].map((n) => n.ref.type))];
  }

  add(ref: ResourceRef, parent?: ResourceRef, attributes: Readonly<Record<string, unknown>> = {}): this {
    if (parent && !this.nodes.has(resourceKey(parent))) this.nodes.set(resourceKey(parent), { ref: parent, attributes: {} });
    const existing = this.nodes.get(resourceKey(ref));
    this.nodes.set(resourceKey(ref), { ref, parent: parent ?? existing?.parent, attributes: clonePlain({ ...existing?.attributes, ...attributes }) });
    return this;
  }

  async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    if (!this.nodes.has(resourceKey(ref))) return null;
    const out: ResourceRef[] = [];
    const seen = new Set<string>();
    for (let at: ResourceRef | undefined = ref; at; at = this.nodes.get(resourceKey(at))?.parent) {
      if (seen.has(resourceKey(at))) throw new Error(`FakeScopeResolver: parent cycle at ${resourceKey(at)}`);
      seen.add(resourceKey(at));
      out.push(at);
    }
    out.push(GLOBAL);
    return out;
  }

  async attributes(ref: ResourceRef): Promise<Readonly<Record<string, unknown>> | null> {
    const node = this.nodes.get(resourceKey(ref));
    if (!node) return null;
    return deepFreeze(clonePlain(deepMerge(this.defaults[ref.type] ?? {}, node.attributes)));
  }
}
