import type { PrincipalRef, ResourceRef } from '@spinajs/authz';
import { fakeEvaluationContext, fakeModelInitContext } from '@spinajs/authz-testing';
import type { FakeEvaluationContext } from '@spinajs/authz-testing';

import { MemoryTupleStore, RebacModel } from '../../src/index.js';
import type { NamespaceConfig, PermissionMap, RebacLimits, Tuple, TupleSubject } from '../../src/index.js';

/** Groups nest; docs sit in folders, folders in folders; view flows down `parent`. */
export const NAMESPACES: NamespaceConfig = {
  user: {},
  group: { relations: { member: ['user', 'group#member'] } },
  folder: {
    relations: { parent: ['folder'], viewer: ['user', 'group#member'] },
    permissions: { view: { union: ['viewer', 'parent->view'] } },
  },
  doc: {
    relations: { parent: ['folder'], owner: ['user'], viewer: ['user', 'group#member'], editor: ['user'], approved: ['user'], banned: ['user'] },
    permissions: {
      read: { union: ['owner', 'viewer', 'parent->view'] },
      edit: { intersection: ['editor', 'approved'] },
      view: { exclusion: { base: 'read', subtract: 'banned' } },
    },
  },
};

export const PERMISSIONS: PermissionMap = { 'doc:read': 'doc#read', 'doc:edit': 'doc#edit', 'doc:view': 'doc#view', 'folder:read': 'folder#view' };

export const PERMISSION_INPUTS = [...['doc:read', 'doc:edit', 'doc:view'].map((name) => ({ name, types: ['doc'] })), { name: 'folder:read', types: ['folder'] }];

export const ref = (type: string, id: string): ResourceRef => ({ type, id });
export const user = (id: string): PrincipalRef => ({ type: 'user', id });
export const set = (type: string, id: string, relation: string): TupleSubject => ({ object: ref(type, id), relation });
export const tuple = (object: ResourceRef, relation: string, subject: TupleSubject): Tuple => ({ object, relation, subject });

export const d1 = ref('doc', 'd1');
export const d2 = ref('doc', 'd2');
export const d3 = ref('doc', 'd3');
export const f0 = ref('folder', 'f0');
export const f1 = ref('folder', 'f1');

/**
 * alice owns d1, edits it and is approved; bob reads d1 through group eng, edits it unapproved and is banned
 * from it; olga is in ops, a member set of eng; d2 sits in f1, f1 in f0; frank views f1, carol f0; groups a
 * and b name each other, and d3's viewers are a's members.
 */
export const TUPLES: readonly Tuple[] = [
  tuple(d1, 'owner', user('alice')),
  tuple(d1, 'viewer', set('group', 'eng', 'member')),
  tuple(ref('group', 'eng'), 'member', user('bob')),
  tuple(ref('group', 'eng'), 'member', set('group', 'ops', 'member')),
  tuple(ref('group', 'ops'), 'member', user('olga')),
  tuple(d1, 'editor', user('alice')),
  tuple(d1, 'approved', user('alice')),
  tuple(d1, 'editor', user('bob')),
  tuple(d1, 'banned', user('bob')),
  tuple(d2, 'parent', { type: 'folder', id: 'f1' }),
  tuple(f1, 'parent', { type: 'folder', id: 'f0' }),
  tuple(f0, 'viewer', user('carol')),
  tuple(f1, 'viewer', user('frank')),
  tuple(ref('group', 'a'), 'member', set('group', 'b', 'member')),
  tuple(ref('group', 'b'), 'member', set('group', 'a', 'member')),
  tuple(d3, 'viewer', set('group', 'a', 'member')),
];

export interface Setup {
  readonly model: RebacModel;
  readonly store: MemoryTupleStore;
  context(): FakeEvaluationContext;
}

/** A RebacModel over a MemoryTupleStore holding `tuples`, initialised with the namespaces above. */
export async function setup(opts: { readonly tuples?: readonly Tuple[]; readonly limit?: RebacLimits; readonly name?: string } = {}): Promise<Setup> {
  const store = new MemoryTupleStore(opts.tuples ?? TUPLES);
  const model = new RebacModel({ store, namespaces: NAMESPACES, permissions: PERMISSIONS, ...(opts.limit ? { limit: opts.limit } : {}), ...(opts.name ? { name: opts.name } : {}) });
  const init = fakeModelInitContext({ permissions: PERMISSION_INPUTS, model: model.name });
  await model.init(init);
  return { model, store, context: () => fakeEvaluationContext({ permissions: PERMISSION_INPUTS, nativeFilters: init.registered.nativeFilters }) };
}
