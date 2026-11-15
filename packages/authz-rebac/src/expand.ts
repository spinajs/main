import type { ResourceRef } from '@spinajs/authz';

import type { RebacLimits, Tuple, TupleStore, TupleSubject } from './contracts.js';
import { isSubjectSet, objectKey } from './keys.js';
import type { CompiledRewrite, NamespaceSchema } from './namespace/compile.js';

/**
 * Zanzibar's expand: who holds `relation` on `object`, as the tree of its rewrite. A `tuples` leaf lists the stored
 * subjects, subject sets included and not followed (expand them in turn); `truncated` marks a cycle or maxDepth.
 */
export type UsersetTree =
  | { readonly kind: 'tuples'; readonly object: ResourceRef; readonly relation: string; readonly subjects: readonly TupleSubject[] }
  | { readonly kind: 'computed'; readonly object: ResourceRef; readonly relation: string; readonly child: UsersetTree }
  | { readonly kind: 'tupleToUserset'; readonly object: ResourceRef; readonly tupleset: string; readonly computed: string; readonly children: readonly UsersetTree[] }
  | { readonly kind: 'union' | 'intersection'; readonly children: readonly UsersetTree[] }
  | { readonly kind: 'exclusion'; readonly base: UsersetTree; readonly subtract: UsersetTree }
  | { readonly kind: 'truncated'; readonly object: ResourceRef; readonly relation: string };

/** What a walk over the namespaces reads: the model's schema, store and limits, with one read per object#relation. */
export class RebacWalk {
  private readonly reads = new Map<string, Promise<readonly Tuple[]>>();
  private readonly path = new Set<string>();
  private calls = 0;

  constructor(
    readonly schema: NamespaceSchema,
    private readonly store: TupleStore,
    readonly limits: Required<RebacLimits>,
    private readonly tooMany: (message: string) => Error,
  ) {}

  read(object: ResourceRef, relation: string): Promise<readonly Tuple[]> {
    const key = `${objectKey(object)}#${relation}`;
    let tuples = this.reads.get(key);
    if (!tuples) this.reads.set(key, (tuples = this.store.read(object, relation)));
    return tuples;
  }

  /** Runs `fn` for object#name unless it is already on the path (a cycle) or past maxDepth; throws past maxCalls. */
  async visit<T>(object: ResourceRef, name: string, depth: number, onCut: (cut: 'cycle' | 'depth') => T, fn: () => Promise<T>): Promise<T> {
    const key = `${objectKey(object)}#${name}`;
    if (this.path.has(key)) return onCut('cycle');
    if (depth > this.limits.maxDepth) return onCut('depth');
    if (++this.calls > this.limits.maxCalls) throw this.tooMany(`maxCalls ${this.limits.maxCalls} exceeded at ${key}`);
    this.path.add(key);
    try {
      return await fn();
    } finally {
      this.path.delete(key);
    }
  }

  /** The objects a tuple-to-userset step reaches through `tupleset`. */
  async targets(object: ResourceRef, tupleset: string): Promise<ResourceRef[]> {
    const rel = this.schema.relation(object.type, tupleset);
    if (!rel) return [];
    return (await this.read(object, tupleset)).flatMap((t) => (!isSubjectSet(t.subject) && rel.direct.includes(t.subject.type) && this.schema.namespaces.has(t.subject.type) ? [{ type: t.subject.type, id: t.subject.id }] : []));
  }
}

export function expand(walk: RebacWalk, object: ResourceRef, relation: string, depth = 0): Promise<UsersetTree> {
  return walk.visit<UsersetTree>(
    object,
    relation,
    depth,
    () => ({ kind: 'truncated', object, relation }),
    async () => {
      const rewrite = walk.schema.permission(object.type, relation);
      return rewrite ? expandRewrite(walk, object, rewrite, depth) : leaf(walk, object, relation);
    },
  );
}

async function leaf(walk: RebacWalk, object: ResourceRef, relation: string): Promise<UsersetTree> {
  const rel = walk.schema.relation(object.type, relation);
  const subjects = rel === undefined ? [] : (await walk.read(object, relation)).map((t) => t.subject).filter((s) => (isSubjectSet(s) ? rel.sets.some((x) => x.type === s.object.type && x.relation === s.relation) : rel.direct.includes(s.type)));
  return { kind: 'tuples', object, relation, subjects };
}

async function expandRewrite(walk: RebacWalk, object: ResourceRef, r: CompiledRewrite, depth: number): Promise<UsersetTree> {
  switch (r.kind) {
    case 'computed':
      return { kind: 'computed', object, relation: r.name, child: await expand(walk, object, r.name, depth) };
    case 'ttu': {
      const children: UsersetTree[] = [];
      for (const o of await walk.targets(object, r.tupleset)) children.push(await expand(walk, o, r.computed, depth + 1));
      return { kind: 'tupleToUserset', object, tupleset: r.tupleset, computed: r.computed, children };
    }
    case 'union':
    case 'intersection': {
      const children: UsersetTree[] = [];
      for (const c of r.children) children.push(await expandRewrite(walk, object, c, depth));
      return { kind: r.kind, children };
    }
    case 'exclusion':
      return { kind: 'exclusion', base: await expandRewrite(walk, object, r.base, depth), subtract: await expandRewrite(walk, object, r.subtract, depth) };
  }
}
