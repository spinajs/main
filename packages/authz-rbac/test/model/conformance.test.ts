import { GLOBAL } from '@spinajs/authz';
import type { Assignment, PermissionInput, ResourceRef } from '@spinajs/authz';
import { CONFORMANCE_NOW, FakeAdapter, FakeScopeResolver, runModelConformance, servicePrincipal, userPrincipal, withCeiling, withCompanions, worldRows } from '@spinajs/authz-testing';
import type { ModelFactory } from '@spinajs/authz-testing';
import * as fc from 'fast-check';
import 'mocha';

import { MemoryAssignmentStore, MemoryRoleStore, RbacModel } from '../../src/index.js';
import type { GrantDef, RoleDef } from '../../src/index.js';

const O1: ResourceRef = { type: 'org', id: 'o1' };
const P1: ResourceRef = { type: 'project', id: 'p1' };
const P2: ResourceRef = { type: 'project', id: 'p2' };
const FILE_A: ResourceRef = { type: 'file', id: 'a' };
const HOUR = 3_600_000;

const PERMISSIONS: PermissionInput[] = [
  { name: 'file:read', types: ['file'] },
  { name: 'file:write', types: ['file'] },
  { name: 'file:delete', types: ['file'] },
];
const NAMES = PERMISSIONS.map((p) => p.name);

const role = (name: string, grants: readonly GrantDef[], extend: readonly string[] = []): RoleDef => ({ name, extends: extend, assignable: true, source: 'conformance', grants });

// Fixed roles the mutations rely on; the seed adds random ones on top.
const BASE: RoleDef[] = [
  role('viewer', [{ permission: 'file:read' }]),
  role('editor', [{ permission: 'file:*' }]),
  role('owner', [
    { permission: 'file:read', relation: 'owner' },
    { permission: 'file:delete', relation: 'owner' },
  ]),
];

const GRANT_POOL: GrantDef[] = [{ permission: 'file:read' }, { permission: 'file:write' }, { permission: 'file:delete', relation: 'owner' }, { permission: 'file:write', relation: 'owner' }, { permission: 'file:read', on: [{ type: 'file', id: 'a' }] }, { permission: 'file:write', on: [{ type: 'file', id: 'c*' }] }, { permission: 'file:delete', on: [{ type: 'file' }] }];

const USERS = ['alice', 'bob', 'dave', 'erin'];
const SCOPES: ResourceRef[] = [GLOBAL, O1, P1, P2, FILE_A, { type: 'file' }];

interface ExtraRole {
  readonly grants: readonly number[];
  readonly extends: readonly string[];
}

interface Seed {
  readonly extra: readonly ExtraRole[];
  readonly assignments: readonly { readonly who: string; readonly role: string; readonly scope: number; readonly expiry: 'none' | 'past' | 'future' }[];
}

const ROLE_NAMES = ['viewer', 'editor', 'owner', 'r0', 'r1', 'r2', 'ghost'];

const seeds: fc.Arbitrary<Seed> = fc.record({
  extra: fc.array(fc.record({ grants: fc.subarray([...GRANT_POOL.keys()], { minLength: 1, maxLength: 3 }), extends: fc.subarray(['viewer', 'editor', 'owner'], { maxLength: 2 }) }), { maxLength: 3 }),
  assignments: fc.array(fc.record({ who: fc.constantFrom(...USERS), role: fc.constantFrom(...ROLE_NAMES), scope: fc.nat({ max: SCOPES.length - 1 }), expiry: fc.constantFrom('none' as const, 'past' as const, 'future' as const) }), { maxLength: 6 }),
});

const user = (id: string) => ({ type: 'user', id });

function adapter(): FakeAdapter {
  return new FakeAdapter({
    types: ['file'],
    rows: {
      file: [
        { id: 'a', owner: 'alice' },
        { id: 'b', owner: 'bob' },
        { id: 'c', owner: 'alice' },
        { id: 'cd', owner: 'dave' },
      ],
    },
    parents: [
      [FILE_A, P1],
      [{ type: 'file', id: 'b' }, P1],
      [{ type: 'file', id: 'c' }, P2],
      [{ type: 'file', id: 'cd' }, P2],
    ],
    relations: [{ type: 'file', relation: 'owner', column: 'owner' }],
  });
}

const factory: ModelFactory<Seed> = ({ seed, shuffle }) => {
  const extra = seed.extra.map((r, i) =>
    role(
      `r${i}`,
      r.grants.map((g) => GRANT_POOL[g]),
      r.extends,
    ),
  );
  const temp: Assignment = { id: 'temp', subject: user('temp'), role: 'viewer', scope: GLOBAL, source: 'conformance', expiresAt: new Date(CONFORMANCE_NOW.getTime() + HOUR) };
  const rows: Assignment[] = [
    { id: 'carol', subject: user('carol'), role: 'editor', scope: GLOBAL, source: 'conformance' },
    { id: 'leaver', subject: user('leaver'), role: 'editor', scope: GLOBAL, source: 'conformance' },
    temp,
    ...seed.assignments.map(
      (a, i): Assignment => ({
        id: `s${i}`,
        subject: user(a.who),
        role: a.role,
        scope: SCOPES[a.scope],
        source: 'conformance',
        ...(a.expiry === 'none' ? {} : { expiresAt: new Date(CONFORMANCE_NOW.getTime() + (a.expiry === 'past' ? -HOUR : HOUR)) }),
      }),
    ),
  ];
  const store = new MemoryAssignmentStore(shuffle(rows));
  const model = new RbacModel({ roles: new MemoryRoleStore(shuffle([...BASE, ...extra])), assignments: store, log: { warn: () => undefined } });
  const files = adapter();
  const rowA = files.all('file')[0];
  const probe = (who: string, permission: string) => ({ principal: userPrincipal(who), permission, resource: FILE_A, subject: rowA });
  return {
    model,
    world: {
      principals: [...USERS, 'carol', 'leaver', 'temp', 'nobody'].map((id) => userPrincipal(id)).concat(withCompanions(servicePrincipal('svc'), [user('alice')]), withCeiling(userPrincipal('bob'), { roles: ['viewer', 'r0'] })),
      permissions: NAMES,
      rows: worldRows(files),
      context: { adapters: [files], scopeResolvers: [new FakeScopeResolver({ nodes: [{ ref: P1, parent: O1 }, { ref: P2, parent: O1 }, { ref: O1 }] })], permissions: PERMISSIONS },
    },
    mutations: [
      {
        title: 'assign a newcomer viewer at p1',
        request: probe('newcomer', 'file:read'),
        after: true,
        apply: () => store.add({ id: 'new', subject: user('newcomer'), role: 'viewer', scope: P1, source: 'conformance' }),
        tags: ['subject:user:newcomer'],
        freshness: 'invalidate',
      },
      {
        title: 'revoke the global editor of the leaver',
        request: probe('leaver', 'file:write'),
        after: false,
        apply: () => store.remove('leaver'),
        tags: ['subject:user:leaver'],
        freshness: 'invalidate',
      },
      {
        title: 'expire the viewer assignment of temp',
        request: probe('temp', 'file:read'),
        after: false,
        apply: () => {
          store.remove('temp');
          store.add({ ...temp, expiresAt: new Date(CONFORMANCE_NOW.getTime() - HOUR) });
        },
        tags: ['subject:user:temp'],
        freshness: 'invalidate',
      },
    ],
  };
};

describe('authz-rbac model: conformance', () => {
  runModelConformance('RbacModel over random roles and assignments', factory, { seeds, timeoutMs: 180_000 });
});
