import type { VoteFn } from '../fakes/index.js';
import { anonymousPrincipal, userPrincipal } from '../principals.js';
import { assignment, combine, fixture, permit, ref, role, staticModel } from './dsl.js';
import { http } from './lane.js';
import type { RouteSpec } from './lane.js';
import type { Case, World } from './types.js';

const alice = userPrincipal('alice');
const anonymous = anonymousPrincipal();
const f1 = ref('file', 'f1');

const FILE = { from: 'param', name: 'id', type: 'file' } as const;
const guarded: RouteSpec = { method: 'GET', path: '/files/:id', access: { permission: 'file:read', resource: FILE } };
const open: RouteSpec = { ...guarded, path: '/public/:id', anonymous: true };

// Permits file:read for anonymous principals and alice, so a 401 can only come from the route.
const everyone: VoteFn = (req) => (req.principal.type === 'anonymous' || req.principal.id === 'alice' ? permit() : {});

const httpWorld = (enabled: boolean): World => ({
  permissions: ['file:read'],
  principals: { alice },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: everyone })],
  config: { principals: { anonymous: { enabled } } },
  lane: { http: { routes: [guarded, open] } },
});

const NOT_CALLED = { calls: { model: 'm1', count: 0 } } as const;

const httpCases: Case[] = [
  {
    name: '@Access without @AllowAnonymous answers an anonymous request 401 before any model runs',
    world: httpWorld(true),
    steps: [http({ method: 'GET', path: '/files/f1' }, { status: 401 }), NOT_CALLED],
  },
  {
    name: 'with anonymous disabled, an @Access route answers 401 before any model runs',
    world: httpWorld(false),
    steps: [http({ method: 'GET', path: '/files/f1' }, { status: 401 }), NOT_CALLED],
  },
  {
    name: 'an anonymous request to an @AllowAnonymous route runs as the anonymous principal',
    world: httpWorld(true),
    steps: [http({ method: 'GET', path: '/public/f1' }, { status: 200, body: { principal: { type: 'anonymous' } } }), { calls: { model: 'm1', atLeast: 1 } }],
  },
  {
    name: 'with anonymous disabled, an @AllowAnonymous route answers 401',
    world: httpWorld(false),
    steps: [http({ method: 'GET', path: '/public/f1' }, { status: 401 }), NOT_CALLED],
  },
  {
    name: 'an authenticated request to the @Access route reaches the models',
    world: httpWorld(true),
    steps: [http({ method: 'GET', path: '/files/f1', as: 'alice' }, { status: 200, body: { principal: { type: 'user', id: 'alice' } } }), { calls: { model: 'm1', atLeast: 1 } }],
  },
];

const rbacWorld: World = {
  permissions: ['file:read', 'file:write'],
  principals: { alice, anonymous },
  combine: combine('deny-overrides', 'rbac'),
  config: { principals: { anonymous: { enabled: true } }, rbac: { anonymousRoles: ['guest'] } },
  rbac: {
    roles: [role('guest', ['file:read']), role('user', ['file:read', 'file:write'])],
    assignments: [assignment('a1', alice, 'user')],
  },
};

export const B10 = fixture('B10', [
  { name: 'http', facets: ['engine', 'http'], lanes: ['L5'], cases: httpCases },
  {
    name: 'rbac',
    facets: ['engine', 'rbac'],
    lanes: ['C1'],
    note: 'authz.rbac.anonymousRoles are the roles of the anonymous principal (design §8.2, the comment on anonymousRoles in the sample config), so a user does not hold them; the RBAC model (L1) holds them, C1 ships the guest role.',
    world: rbacWorld,
    cases: [
      {
        name: 'the anonymous principal holds authz.rbac.anonymousRoles',
        steps: [
          { check: { as: 'anonymous', permission: 'file:read', resource: f1 }, expect: { allowed: true } },
          { check: { as: 'anonymous', permission: 'file:write', resource: f1 }, expect: { allowed: false } },
        ],
      },
      {
        name: 'a user is not given the anonymous roles on top of its own',
        world: { ...rbacWorld, rbac: { ...rbacWorld.rbac, roles: [role('guest', ['file:write']), role('user', ['file:read'])] } },
        steps: [
          { check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: true } },
          { check: { as: 'alice', permission: 'file:write', resource: f1 }, expect: { allowed: false } },
        ],
      },
    ],
  },
]);
