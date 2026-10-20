import * as fc from 'fast-check';

import type { Permission, PrincipalRef, ResourceRef } from '@spinajs/authz';

import type { FakeRow } from '../fakes/adapter.js';
import type { FakeTupleSchema } from '../fakes/tuple-model.js';
import type { Tuple } from '../rebac.js';

/** Groups nest, folders nest under folders, docs sit in a folder; view flows down the parent arrow. */
export const TUPLE_GRAPH_SCHEMA: FakeTupleSchema = Object.freeze({
  group: { relations: { member: 'user | group#member' } },
  folder: { relations: { parent: 'folder', viewer: 'user | group#member', owner: 'user' }, permissions: { view: 'viewer | owner | parent->view' } },
  doc: { relations: { parent: 'folder', viewer: 'user | group#member', editor: 'user' }, permissions: { edit: 'editor', view: 'edit | viewer | parent->view' } },
});

export const TUPLE_GRAPH_PERMISSIONS: Readonly<Record<Permission, string>> = Object.freeze({ 'doc:read': 'doc#view', 'doc:edit': 'doc#edit', 'folder:read': 'folder#view' });

export interface TupleGraphOptions {
  /** Folder levels, default 3. */
  readonly folderDepth?: number;
  /** Group nesting levels, default 2 (0: no groups). */
  readonly groupDepth?: number;
  /** Fan-out: nodes per level and tuples per object#relation, default 3. */
  readonly width?: number;
  /** Default u0..u3. */
  readonly users?: readonly string[];
  /** The model's maxDepth the graph must stay within, default 8 (FakeTupleModel's default). */
  readonly maxDepth?: number;
}

export interface TupleGraph {
  readonly schema: FakeTupleSchema;
  readonly permissions: Readonly<Record<Permission, string>>;
  readonly tuples: readonly Tuple[];
  readonly users: readonly PrincipalRef[];
  /** Rows for FakeAdapter, `{ id }` per folder and doc. */
  readonly rows: Readonly<Record<'folder' | 'doc', FakeRow[]>>;
  /** `[child, parent]` pairs matching the parent tuples, for FakeAdapter's `parents`. */
  readonly parents: readonly (readonly [child: ResourceRef, parent: ResourceRef])[];
  /**
   * The deepest relation evaluation a check can reach (FakeTupleModel depth: the requested node at 0):
   * folderDepth + groupDepth + 1. A walk never tries to go past it, so with maxDepth >= depthBound no
   * vote is indeterminate.
   */
  readonly depthBound: number;
}

type Member = readonly [toGroup: boolean, n: number];

/**
 * Random acyclic tuple graphs under TUPLE_GRAPH_SCHEMA with bounded depth and fan-out: group usersets
 * point one level down, folder parents one level up, so no shortest proof is longer than `depthBound`,
 * which must not exceed `maxDepth`. Cycles are left to hand-written tests.
 */
export function tupleGraph(opts: TupleGraphOptions = {}): fc.Arbitrary<TupleGraph> {
  const folderDepth = Math.max(1, opts.folderDepth ?? 3);
  const groupDepth = Math.max(0, opts.groupDepth ?? 2);
  const width = Math.max(1, opts.width ?? 3);
  const userIds = opts.users ?? ['u0', 'u1', 'u2', 'u3'];
  const maxDepth = opts.maxDepth ?? 8;
  const depthBound = folderDepth + groupDepth + 1;
  if (userIds.length === 0) throw new Error('arbitraries: users is empty');
  if (depthBound > maxDepth) throw new Error(`arbitraries: folderDepth + groupDepth + 1 = ${depthBound} exceeds maxDepth ${maxDepth}`);

  const members = fc.array(fc.tuple(fc.boolean(), fc.nat(99)), { maxLength: width });
  const userPicks = fc.uniqueArray(fc.nat(userIds.length - 1), { maxLength: Math.min(width, userIds.length) });
  const folder = fc.record({ parent: fc.nat(99), viewers: members, owner: fc.option(fc.nat(userIds.length - 1), { nil: undefined }) });
  const doc = fc.record({ parent: fc.option(fc.nat(999), { nil: undefined }), viewers: members, editors: userPicks });

  return fc
    .record({
      folders: fc.array(fc.array(folder, { minLength: 1, maxLength: width }), { minLength: 1, maxLength: folderDepth }),
      groups: fc.array(fc.array(members, { minLength: 1, maxLength: width }), { maxLength: groupDepth }),
      docs: fc.array(doc, { minLength: 1, maxLength: 2 * width }),
    })
    .map(({ folders, groups, docs }): TupleGraph => {
      const users = userIds.map((id): PrincipalRef => ({ type: 'user', id }));
      const tuples: Tuple[] = [];
      const parents: [ResourceRef, ResourceRef][] = [];
      const groupRef = (level: number, i: number): ResourceRef & { id: string } => ({ type: 'group', id: `g${level}_${i}` });
      const folderRef = (level: number, i: number): ResourceRef & { id: string } => ({ type: 'folder', id: `f${level}_${i}` });

      // A group pick at a level without groups falls back to a user, so fan-out stays within width.
      const subject = (m: Member, level: number): Tuple['subject'] => {
        const [toGroup, n] = m;
        if (toGroup && level < groups.length) return { object: groupRef(level, n % groups[level].length), relation: 'member' };
        return users[n % users.length];
      };

      groups.forEach((level, l) => level.forEach((ms, i) => ms.forEach((m) => tuples.push({ object: groupRef(l, i), relation: 'member', subject: subject(m, l + 1) }))));

      const allFolders: ResourceRef[] = [];
      folders.forEach((level, l) =>
        level.forEach((f, i) => {
          const ref = folderRef(l, i);
          allFolders.push(ref);
          if (l > 0) {
            const parent = folderRef(l - 1, f.parent % folders[l - 1].length);
            tuples.push({ object: ref, relation: 'parent', subject: parent as PrincipalRef });
            parents.push([ref, parent]);
          }
          f.viewers.forEach((m) => tuples.push({ object: ref, relation: 'viewer', subject: subject(m, 0) }));
          if (f.owner !== undefined) tuples.push({ object: ref, relation: 'owner', subject: users[f.owner] });
        }),
      );

      const docRows: FakeRow[] = [];
      docs.forEach((d, i) => {
        const ref = { type: 'doc', id: `d${i}` };
        docRows.push({ id: ref.id });
        if (d.parent !== undefined) {
          const parent = allFolders[d.parent % allFolders.length];
          tuples.push({ object: ref, relation: 'parent', subject: parent as PrincipalRef });
          parents.push([ref, parent]);
        }
        d.viewers.forEach((m) => tuples.push({ object: ref, relation: 'viewer', subject: subject(m, 0) }));
        d.editors.forEach((u) => tuples.push({ object: ref, relation: 'editor', subject: users[u] }));
      });

      return {
        schema: TUPLE_GRAPH_SCHEMA,
        permissions: TUPLE_GRAPH_PERMISSIONS,
        tuples,
        users,
        rows: { folder: allFolders.map((f) => ({ id: f.id! })), doc: docRows },
        parents,
        depthBound,
      };
    });
}
