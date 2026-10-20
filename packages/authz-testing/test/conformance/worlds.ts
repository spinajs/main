import * as fc from 'fast-check';

import { CORE_FILTER_OPS, FALSE, GLOBAL, TRUE, or } from '@spinajs/authz';
import type { DenyReason, PrincipalRef, ResourceFilter, ResourceRef } from '@spinajs/authz';

import { FAKE_TUPLE_OP, FakeAdapter, FakeRbacModel, FakeTupleModel, FakeTupleStore, StaticModel, servicePrincipal, userPrincipal, withCompanions, worldRows } from '../../src/index.js';
import type { AdapterSetup, FakeRow, ModelFactory, ModelSetup, Tuple, VoteFn } from '../../src/index.js';
import { tupleGraph } from '../../src/arbitraries/index.js';
import type { TupleGraph } from '../../src/arbitraries/index.js';

const ADMIN: PrincipalRef = { type: 'user', id: 'admin' };

// ---- ReBAC: FakeTupleModel over random bounded tuple graphs ----

export const TUPLE_PERMISSIONS = ['doc:read', 'doc:edit', 'folder:read', 'user:read'];

export const tupleGraphs = tupleGraph({ folderDepth: 3, groupDepth: 2, width: 3 });

export function tupleAdapter(g: TupleGraph): FakeAdapter {
  return new FakeAdapter({ types: ['doc', 'folder'], rows: g.rows, parents: g.parents, compiles: [...CORE_FILTER_OPS, FAKE_TUPLE_OP] });
}

export const tupleFactory: ModelFactory<TupleGraph> = async ({ seed: g, shuffle }): Promise<ModelSetup> => {
  const d0: ResourceRef = { type: 'doc', id: 'd0' };
  const leaver: Tuple = { object: d0, relation: 'viewer', subject: { type: 'user', id: 'leaver' } };
  const store = new FakeTupleStore();
  await store.write(shuffle([...g.tuples, leaver]), [], ADMIN);
  const model = new FakeTupleModel({ store, schema: g.schema, permissions: g.permissions });
  const adapter = tupleAdapter(g);
  const row = adapter.all('doc')[0];
  return {
    model,
    world: {
      principals: [...g.users.map((u) => userPrincipal(u.id)), userPrincipal('leaver'), userPrincipal('nobody')],
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
        tags: ['subject:user:newcomer'],
        freshness: 'live',
      },
      {
        title: 'unshare d0 with the leaver',
        request: { principal: userPrincipal('leaver'), permission: 'doc:read', resource: d0, subject: row },
        after: false,
        apply: async () => {
          await store.write([], [leaver], ADMIN);
        },
        freshness: 'version',
      },
    ],
  };
};

// ---- RBAC: FakeRbacModel over random assignments ----

const p1: ResourceRef = { type: 'project', id: 'p1' };
const p2: ResourceRef = { type: 'project', id: 'p2' };

export const rbacRoles = {
  viewer: ['file:read'],
  editor: ['file:*'],
  owner: [
    { permission: 'file:read', relation: 'owner' },
    { permission: 'file:delete', relation: 'owner' },
  ],
};

export function rbacAdapter(): FakeAdapter {
  return new FakeAdapter({
    types: ['file'],
    rows: {
      file: [
        { id: 'a', owner: 'alice' },
        { id: 'b', owner: 'bob' },
        { id: 'c', owner: 'alice' },
        { id: 'd', owner: 'dave' },
      ],
    },
    parents: [
      [{ type: 'file', id: 'a' }, p1],
      [{ type: 'file', id: 'b' }, p1],
      [{ type: 'file', id: 'c' }, p2],
      [{ type: 'file', id: 'd' }, p2],
    ],
    relations: [{ type: 'file', relation: 'owner', column: 'owner' }],
  });
}

export type RbacSeed = readonly (readonly [string, string, ResourceRef])[];

export const rbacSeeds: fc.Arbitrary<RbacSeed> = fc.array(fc.tuple(fc.constantFrom('alice', 'bob', 'dave', 'erin'), fc.constantFrom('viewer', 'editor', 'owner'), fc.constantFrom(GLOBAL, p1, p2)), { maxLength: 5 });

const RBAC_PERMISSIONS = ['file:read', 'file:write', 'file:delete'];

export const rbacFactory: ModelFactory<RbacSeed> = ({ seed, shuffle }) => {
  const assignments = shuffle([{ subject: userPrincipal('carol'), role: 'editor' }, ...seed.map(([who, role, scope]) => ({ subject: userPrincipal(who), role, scope }))]);
  const model = new FakeRbacModel({ roles: Object.fromEntries(shuffle(Object.entries(rbacRoles))), assignments });
  const adapter = rbacAdapter();
  const fileA = { type: 'file', id: 'a' };
  return {
    model,
    world: {
      principals: ['alice', 'bob', 'carol', 'dave', 'erin', 'nobody'].map((id) => userPrincipal(id)).concat(withCompanions(servicePrincipal('svc'), [{ type: 'user', id: 'alice' }])),
      permissions: RBAC_PERMISSIONS,
      rows: worldRows(adapter),
      context: { adapters: [adapter], permissions: RBAC_PERMISSIONS },
    },
    mutations: [
      {
        title: 'assign a newcomer viewer at p1',
        request: { principal: userPrincipal('newcomer'), permission: 'file:read', resource: fileA, subject: adapter.all('file')[0] },
        after: true,
        apply: () => {
          model.assign({ subject: userPrincipal('newcomer'), role: 'viewer', scope: p1 });
        },
        tags: ['subject:user:newcomer'],
        freshness: 'live',
      },
      {
        title: 'revoke the global editor',
        request: { principal: userPrincipal('carol'), permission: 'file:write', resource: fileA, subject: adapter.all('file')[0] },
        after: false,
        apply: () => {
          model.revoke({ subject: userPrincipal('carol'), role: 'editor' });
        },
        freshness: 'version',
      },
    ],
  };
};

// ---- Scripted: StaticModel with deny reasons and a principalTypes claim ----

export const staticRows: FakeRow[] = [
  { id: 'a', status: 'open', n: 1, owner: 'alice' },
  { id: 'b', status: 'locked', n: 0, owner: 'bob' },
  { id: 'c', status: 'open', n: 3, owner: 'carol' },
  { id: 'd', status: 'draft', n: 1, owner: 'alice' },
  { id: 'e', status: 'locked', n: 5, owner: 'bob' },
];

const cmp = (field: string, op: 'eq' | 'gte', value: string | number): ResourceFilter => ({ op: 'cmp', field, cmp: op, value });

interface Rule {
  readonly when: ResourceFilter;
  readonly holds: (row: FakeRow) => boolean;
  readonly reason: DenyReason;
}

const RULES: readonly Rule[] = [
  { when: cmp('n', 'gte', 2), holds: (r) => (r.n as number) >= 2, reason: { code: 'too_big', priority: 300, sortKey: 'b' } },
  { when: cmp('status', 'eq', 'locked'), holds: (r) => r.status === 'locked', reason: { code: 'locked', priority: 300, sortKey: 'a' } },
  { when: cmp('n', 'gte', 5), holds: (r) => (r.n as number) >= 5, reason: { code: 'huge', priority: 300, sortKey: 'a' } },
];

/** Residuals without a subject; definite constants with one, as a model that reads the row would give. */
export function scripted(rules: readonly Rule[]): VoteFn {
  return (req) => {
    if (req.principal.type !== 'user') return {};
    const row = req.subject as FakeRow | undefined;
    if (!row) return { permitWhen: or(cmp('status', 'eq', 'open'), { op: 'relation', relation: 'owner' }), denies: rules.map((r) => ({ when: r.when, reason: r.reason })), reason: { code: 'no_access' } };
    const permit = row.status === 'open' || row.owner === req.principal.id;
    return { permitWhen: permit ? TRUE : FALSE, denies: rules.map((r) => ({ when: r.holds(row) ? TRUE : FALSE, reason: r.reason })), ...(permit ? {} : { reason: { code: 'no_access' } }) };
  };
}

export function staticAdapter(): FakeAdapter {
  return new FakeAdapter({ types: ['file'], rows: { file: staticRows }, relations: [{ type: 'file', relation: 'owner', column: 'owner' }] });
}

export const staticFactory: ModelFactory = ({ shuffle }) => {
  const model = new StaticModel({ name: 'scripted', capabilities: { principalTypes: ['user'] }, votes: scripted(shuffle(RULES)) });
  const adapter = staticAdapter();
  const rowB = adapter.all('file')[1];
  const rowA = adapter.all('file')[0];
  return {
    model,
    world: {
      principals: ['alice', 'bob', 'carol', 'nobody'].map((id) => userPrincipal(id)).concat(servicePrincipal('svc')),
      permissions: ['file:read'],
      rows: worldRows(adapter),
      context: { adapters: [adapter], permissions: ['file:read'] },
    },
    mutations: [
      {
        title: 'drop every rule and permit all',
        request: { principal: userPrincipal('bob'), permission: 'file:read', resource: { type: 'file', id: 'b' }, subject: rowB },
        after: true,
        apply: () => {
          model.respond(() => ({ permitWhen: TRUE }));
        },
        freshness: 'live',
      },
      {
        title: 'a new config version permits nothing',
        request: { principal: userPrincipal('alice'), permission: 'file:read', resource: { type: 'file', id: 'a' }, subject: rowA },
        after: false,
        apply: () => {
          model.respond(() => ({})).bump();
        },
        freshness: 'version',
      },
    ],
  };
};

// ---- ABAC shaped like B19: a policy that needs the subject fails closed through its residuals ----

const NEEDS_SUBJECT: DenyReason = { code: 'needs_subject' };

/** file:read is a residual on status; file:edit reads the row (owner, size), so it needs the subject. */
export const b19: VoteFn = (req) => {
  const row = req.subject as FakeRow | undefined;
  if (req.permission === 'file:read') return { permitWhen: row ? (row.status === 'open' ? TRUE : FALSE) : cmp('status', 'eq', 'open') };
  if (!row) return { permitWhen: FALSE, denyWhen: TRUE, denies: [{ when: TRUE, reason: NEEDS_SUBJECT }], reason: NEEDS_SUBJECT };
  const big = (row.n as number) >= 5;
  return { permitWhen: row.owner === req.principal.id ? TRUE : FALSE, denies: [{ when: big ? TRUE : FALSE, reason: { code: 'too_big', priority: 300 } }] };
};

export const b19Factory: ModelFactory = () => {
  const model = new StaticModel({ name: 'abac', capabilities: { needsSubject: true }, votes: b19 });
  const adapter = staticAdapter();
  return {
    model,
    world: {
      principals: ['alice', 'bob', 'nobody'].map((id) => userPrincipal(id)),
      permissions: ['file:read', 'file:edit'],
      rows: worldRows(adapter),
      context: { adapters: [adapter], permissions: ['file:read', 'file:edit'] },
    },
    mutations: [
      {
        title: 'edit opens to everyone',
        request: { principal: userPrincipal('nobody'), permission: 'file:edit', resource: { type: 'file', id: 'a' }, subject: staticRows[0] },
        after: true,
        apply: () => {
          model.respond(() => ({ permitWhen: TRUE }));
        },
        freshness: 'live',
      },
    ],
  };
};

// ---- Adapters ----

export function plainAdapterSetup(): AdapterSetup {
  const adapter = new FakeAdapter({
    types: ['file', 'project'],
    rows: {
      file: [
        { id: 'a', owner: 'alice', status: 'open', n: 1 },
        { id: 'b', owner: 'bob', status: 'locked', n: 2 },
        { id: 'c', owner: 'alice', status: null, n: 3 },
        { id: 'd', owner: 'dave', n: 1 },
      ],
      project: [{ id: 'p1' }, { id: 'p2' }],
    },
    parents: [
      [{ type: 'file', id: 'a' }, p1],
      [{ type: 'file', id: 'b' }, p1],
      [{ type: 'file', id: 'c' }, p2],
      [{ type: 'file', id: 'd' }, p2],
      [p1, { type: 'org', id: 'o1' }],
      [p2, { type: 'org', id: 'o1' }],
    ],
    relations: [{ type: 'file', relation: 'owner', column: 'owner' }],
    attributes: [[p1, { policies: { public_links: true } }]],
  });
  return {
    adapter,
    targets: adapter.types.flatMap((t) => adapter.all(t)),
    principals: ['alice', 'bob', 'nobody'].map((id) => userPrincipal(id)),
    fields: ['owner', 'status', 'n'],
    // LIKE and glob metacharacters next to the column values, so an SQL lane that copies this setup escapes them.
    values: ['alice', 'bob', 'open', 'locked', 'lock%', 'op_n', 'a*', '\\', 1, 2, 3],
    refs: ['principal.id', 'env.owner', 'scope.project.policies.public_links'],
    env: { owner: 'bob' },
    query: async (filter, { principal, type, env }) => (await adapter.rows(type, filter, { principal, env })).map((r) => ({ type, id: r.id })),
  };
}

export async function tupleAdapterSetup(g: TupleGraph): Promise<AdapterSetup> {
  const store = new FakeTupleStore();
  await store.write(g.tuples, [], ADMIN);
  const model = new FakeTupleModel({ store, schema: g.schema, permissions: g.permissions });
  const adapter = tupleAdapter(g);
  const users: PrincipalRef[] = [...g.users, { type: 'user', id: 'nobody' }];
  return {
    adapter,
    targets: adapter.types.flatMap((t) => adapter.all(t)),
    principals: users.map((u) => userPrincipal(u.id)),
    nativeFilters: [model.nativeFilter],
    nativeLeaves: fc.record({ relation: fc.constantFrom('view', 'edit', 'viewer', 'editor', 'owner'), principal: fc.constantFrom(...users) }).map((args): ResourceFilter => ({ op: FAKE_TUPLE_OP, args })),
    query: async (filter, { principal, type, env }) => (await adapter.rows(type, filter, { principal, env, nativeFilters: [model.nativeFilter] })).map((r) => ({ type, id: r.id })),
    dispose: () => model.dispose(),
  };
}

// ---- Deny-only: a model with no permit effect, read as "not denied" ----

const LOCKED: DenyReason = { code: 'locked', priority: 300 };

export const denyOnlyFactory: ModelFactory = () => {
  const model = new StaticModel({
    name: 'deny-only',
    capabilities: { effects: ['deny'] },
    votes: (req) => {
      const row = req.subject as FakeRow | undefined;
      return { denies: [{ when: row ? (row.status === 'locked' ? TRUE : FALSE) : cmp('status', 'eq', 'locked'), reason: LOCKED }] };
    },
  });
  const adapter = staticAdapter();
  return {
    model,
    world: {
      principals: ['alice', 'bob'].map((id) => userPrincipal(id)),
      permissions: ['file:read'],
      rows: worldRows(adapter),
      context: { adapters: [adapter], permissions: ['file:read'] },
    },
    mutations: [
      {
        title: 'unlock every file',
        request: { principal: userPrincipal('alice'), permission: 'file:read', resource: { type: 'file', id: 'b' }, subject: staticRows[1] },
        after: true,
        apply: () => {
          model.respond(() => ({}));
        },
        freshness: 'live',
      },
    ],
  };
};
