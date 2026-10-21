import 'mocha';
import { CORE_FILTER_OPS } from '@spinajs/authz';
import type { PrincipalRef, ResourceRef } from '@spinajs/authz';
import { FakeAdapter, arb, runModelConformance, servicePrincipal, userPrincipal, worldRows } from '@spinajs/authz-testing';
import type { FakeTupleSchema, ModelFactory, ModelSetup } from '@spinajs/authz-testing';

import { MemoryTupleStore, REBAC_CHECK_OP, RebacModel } from '../src/index.js';
import type { NamespaceConfig, Rewrite, Tuple } from '../src/index.js';
import { NAMESPACES, PERMISSIONS, TUPLES, d1, tuple, user } from './support/world.js';

const ADMIN: PrincipalRef = { type: 'user', id: 'admin' };

/** The kit's string schema ('user | group#member', 'viewer | parent->view') as namespaces. */
function namespacesOf(schema: FakeTupleSchema): NamespaceConfig {
  const split = (s: string) => s.split('|').map((x) => x.trim());
  return Object.fromEntries(
    Object.entries(schema).map(([type, ns]) => [
      type,
      {
        relations: Object.fromEntries(Object.entries(ns.relations ?? {}).map(([r, subjects]) => [r, split(subjects)])),
        permissions: Object.fromEntries(Object.entries(ns.permissions ?? {}).map(([p, expr]): [string, Rewrite] => [p, { union: split(expr) }])),
      },
    ]),
  );
}

const TUPLE_PERMISSIONS = ['doc:read', 'doc:edit', 'folder:read', 'user:read'];

const graphFactory: ModelFactory<arb.TupleGraph> = async (input): Promise<ModelSetup> => {
  const g = input.seed;
  const d0: ResourceRef = { type: 'doc', id: 'd0' };
  const leaver: Tuple = { object: d0, relation: 'viewer', subject: { type: 'user', id: 'leaver' } };
  const store = new MemoryTupleStore();
  await store.write(input.shuffle([...g.tuples, leaver]), [], ADMIN);
  const adapter = new FakeAdapter({ types: ['doc', 'folder'], rows: g.rows, parents: g.parents, compiles: [...CORE_FILTER_OPS, REBAC_CHECK_OP] });
  const row = adapter.all('doc')[0];
  return {
    model: new RebacModel({ store, namespaces: namespacesOf(g.schema), permissions: g.permissions }),
    world: {
      principals: [...g.users.map((u) => userPrincipal(u.id)), userPrincipal('leaver'), userPrincipal('nobody'), servicePrincipal('u0')],
      permissions: TUPLE_PERMISSIONS,
      rows: worldRows(adapter),
      context: { adapters: [adapter], permissions: TUPLE_PERMISSIONS },
    },
    mutations: [
      {
        title: 'share d0 with a newcomer',
        request: { principal: userPrincipal('newcomer'), permission: 'doc:read', resource: d0, subject: row },
        after: true,
        apply: async () => {
          await store.write([{ object: d0, relation: 'viewer', subject: { type: 'user', id: 'newcomer' } }], [], ADMIN);
        },
        tags: ['rebac:doc'],
        freshness: 'live',
      },
      {
        title: 'unshare d0 with the leaver',
        request: { principal: userPrincipal('leaver'), permission: 'doc:read', resource: d0, subject: row },
        after: false,
        apply: async () => {
          await store.write([], [leaver], ADMIN);
        },
        freshness: 'live',
      },
    ],
  };
};

const PERMISSION_INPUTS = [...['doc:read', 'doc:edit', 'doc:view'].map((name) => ({ name, types: ['doc'] })), { name: 'folder:read', types: ['folder'] }];

/** The hand-written world: intersection, exclusion, nested groups, folder chains and a group cycle. */
const rewritesFactory: ModelFactory = (input): ModelSetup => {
  const store = new MemoryTupleStore(input.shuffle(TUPLES));
  const adapter = new FakeAdapter({
    types: ['doc', 'folder'],
    rows: { doc: ['d1', 'd2', 'd3', 'd4'].map((id) => ({ id })), folder: ['f0', 'f1'].map((id) => ({ id })) },
    compiles: [...CORE_FILTER_OPS, REBAC_CHECK_OP],
  });
  return {
    model: new RebacModel({ store, namespaces: NAMESPACES, permissions: PERMISSIONS }),
    world: {
      principals: ['alice', 'bob', 'carol', 'frank', 'olga', 'eve'].map((id) => userPrincipal(id)),
      permissions: ['doc:read', 'doc:edit', 'doc:view', 'folder:read'],
      rows: worldRows(adapter),
      context: { adapters: [adapter], permissions: PERMISSION_INPUTS },
    },
    mutations: [
      {
        title: 'ban olga from d1',
        request: { principal: userPrincipal('olga'), permission: 'doc:view', resource: d1, subject: { id: 'd1' } },
        after: false,
        apply: async () => {
          await store.write([tuple(d1, 'banned', user('olga'))], [], ADMIN);
        },
        freshness: 'live',
      },
    ],
  };
};

describe('authz-rebac: model conformance', () => {
  runModelConformance('RebacModel over random tuple graphs', graphFactory, { seeds: arb.tupleGraph({ folderDepth: 3, groupDepth: 2, width: 3 }), timeoutMs: 120_000 });
  runModelConformance('RebacModel over the rewrites world', rewritesFactory, { timeoutMs: 120_000 });
});
