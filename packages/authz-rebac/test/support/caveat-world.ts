import { fakeModelInitContext } from '@spinajs/authz-testing';

import { MemoryTupleStore, RebacModel } from '../../src/index.js';
import type { CaveatConfig, NamespaceConfig, Tuple } from '../../src/index.js';
import { d1, d2, d3, f1, ref, set, tuple, user } from './world.js';

export const CAVEATS: CaveatConfig = {
  office_ip: { params: { 'env.ip': 'string' }, expr: { attr: 'env.ip', eq: '10.0.0.1' } },
  not_expired: { params: { 'env.day': 'int', 'env.until': 'int' }, expr: { attr: 'env.day', lt: { ref: 'env.until' } } },
};

export const NS: NamespaceConfig = {
  user: {},
  group: { relations: { member: ['user'] } },
  folder: { relations: { viewer: ['user'] }, permissions: { view: 'viewer' } },
  doc: {
    relations: { viewer: ['user', 'user with office_ip', 'group#member with office_ip'], parent: ['folder with not_expired'], banned: ['user with office_ip'] },
    permissions: { read: { union: ['viewer', 'parent->view'] }, blocked_read: { exclusion: { base: 'read', subtract: 'banned' } } },
  },
};

export const INPUTS = [{ name: 'doc:read', types: ['doc'] }];

/** bob and the eng group view d1 from the office; carl is in eng; d2 sits in f1 until day 20, dora views f1; erin views d3. */
export const CAVEAT_TUPLES: readonly Tuple[] = [
  { ...tuple(d1, 'viewer', user('bob')), caveat: { name: 'office_ip' } },
  { ...tuple(d1, 'viewer', set('group', 'eng', 'member')), caveat: { name: 'office_ip' } },
  tuple(ref('group', 'eng'), 'member', user('carl')),
  { ...tuple(d2, 'parent', { type: 'folder', id: 'f1' }), caveat: { name: 'not_expired', context: { 'env.until': 20 } } },
  tuple(f1, 'viewer', user('dora')),
  tuple(d3, 'viewer', user('erin')),
];

export async function caveatModel(tuples: readonly Tuple[] = CAVEAT_TUPLES): Promise<RebacModel> {
  const model = new RebacModel({ store: new MemoryTupleStore(tuples), namespaces: NS, permissions: { 'doc:read': 'doc#read' }, caveats: CAVEATS });
  await model.init(fakeModelInitContext({ permissions: INPUTS, model: model.name }));
  return model;
}
