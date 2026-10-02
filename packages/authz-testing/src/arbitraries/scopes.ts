import * as fc from 'fast-check';

import type { ResourceRef } from '@spinajs/authz';

import type { FakeRow } from '../fakes/adapter.js';
import type { FakeScopeNode } from '../fakes/scope-resolver.js';
import { DEFAULT_TYPES } from './common.js';

export interface ScopeTreeOptions {
  /** Types by level, top first. Default `DEFAULT_TYPES` (org, project, file, dir). */
  readonly types?: readonly string[];
  /** Levels used, at most `types.length`. Default all of them. */
  readonly depth?: number;
  /** Maximum children per node. Default 3. */
  readonly width?: number;
  /** Minimum top-level nodes, at most `width`. Default 1; 0 allows empty trees. */
  readonly minRoots?: number;
}

/**
 * Node ids are `<type><n>` (org0, project1, ...) and never meet the default id pool (a..d): filters,
 * rules and assignments built from defaults touch a generated tree only when given `scopes: tree.nodes`.
 */
export interface ScopeTree {
  /** Every node, parents before children. Ids are `<type><n>` and unique. */
  readonly nodes: readonly ResourceRef[];
  /** Top-level nodes: their parent is GLOBAL, which the fakes add on their own, so they have no entry in `parents`. */
  readonly roots: readonly ResourceRef[];
  /** `[child, parent]` pairs for FakeAdapter's `parents`. */
  readonly parents: readonly (readonly [child: ResourceRef, parent: ResourceRef])[];
  /** One row per node, for FakeAdapter's `rows`: the adapter answers `ancestors` only for known rows. */
  readonly rows: Readonly<Record<string, FakeRow[]>>;
  /** Ready for FakeScopeResolver's `nodes`. */
  readonly scopeNodes: readonly FakeScopeNode[];
}

type Shape = readonly Shape[];

export function scopeTree(opts: ScopeTreeOptions = {}): fc.Arbitrary<ScopeTree> {
  const types = opts.types ?? DEFAULT_TYPES;
  if (types.length === 0) throw new Error('arbitraries: types is empty');
  const depth = Math.max(1, Math.min(opts.depth ?? types.length, types.length));
  const width = opts.width ?? 3;
  const minRoots = Math.min(opts.minRoots ?? 1, width);

  const level = (left: number, min: number): fc.Arbitrary<Shape> => fc.array(left <= 1 ? fc.constant([] as Shape) : level(left - 1, 0), { minLength: min, maxLength: width });

  return level(depth, minRoots).map((roots) => {
    const nodes: ResourceRef[] = [];
    const parents: [ResourceRef, ResourceRef][] = [];
    const scopeNodes: FakeScopeNode[] = [];
    const rootRefs: ResourceRef[] = [];
    const rows: Record<string, FakeRow[]> = {};
    let n = 0;

    const walk = (children: Shape, at: number, parent?: ResourceRef): void => {
      for (const child of children) {
        const id = `${types[at]}${n++}`;
        const ref: ResourceRef = { type: types[at], id };
        nodes.push(ref);
        (rows[types[at]] ??= []).push({ id });
        scopeNodes.push(parent ? { ref, parent } : { ref });
        if (parent) parents.push([ref, parent]);
        else rootRefs.push(ref);
        walk(child, at + 1, ref);
      }
    };
    walk(roots, 0);

    return { nodes, roots: rootRefs, parents, rows, scopeNodes };
  });
}
