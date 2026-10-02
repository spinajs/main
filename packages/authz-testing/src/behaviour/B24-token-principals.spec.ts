import { userPrincipal } from '../principals.js';
import { assignment, combine, fixture, ref, role } from './dsl.js';
import { checkKept, flow, token } from './lane.js';
import type { World } from './types.js';

const alice = userPrincipal('alice');
const P1 = ref('project', 'p1');
const P2 = ref('project', 'p2');
const f1 = ref('file', 'f1');
const f2 = ref('file', 'f2');
const ALICE = { type: 'user', id: 'alice' };

/** alice holds viewer, editor and route.export; admin exists but alice lacks it. */
export const tokenWorld: World = {
  permissions: ['file:read', 'file:write', 'report:export', 'user:impersonate'],
  principals: { alice },
  scopes: [
    {
      nodes: [{ ref: P1 }, { ref: P2 }, { ref: f1, parent: P1 }, { ref: f2, parent: P2 }],
    },
  ],
  combine: combine('deny-overrides', 'rbac'),
  config: { token: { excludedRoles: ['route.*'] } },
  rbac: {
    roles: [role('viewer', ['file:read']), role('editor', ['file:write']), role('route.export', ['report:export']), role('admin', ['user:impersonate'])],
    assignments: [assignment('a1', alice, 'viewer'), assignment('a2', alice, 'editor'), assignment('a3', alice, 'route.export')],
  },
};

const read = (resource = f1) => ({ permission: 'file:read', resource } as const);
const write = { permission: 'file:write', resource: f1 } as const;

export const B24 = fixture('B24', [
  {
    name: 'token',
    facets: ['engine', 'rbac', 'token'],
    lanes: ['C5'],
    note: 'A personal access token gives a user principal with ceiling.roles = the token roles and the Scope as ceiling (design §11.1, §22.9).',
    world: tokenWorld,
    cases: [
      {
        name: 'token roles narrow the owner roles',
        steps: [token('t', { owner: 'alice', roles: ['viewer'] }, { type: 'user', id: 'alice', ceiling: { roles: ['viewer'] } }), checkKept('t', read(), { allowed: true }), checkKept('t', write, { allowed: false })],
      },
      {
        name: 'a token role the owner lacks grants nothing',
        steps: [token('t', { owner: 'alice', roles: ['editor', 'admin'] }), checkKept('t', write, { allowed: true }), checkKept('t', { permission: 'user:impersonate' }, { allowed: false })],
      },
      {
        name: 'the role policy removes authz.token.excludedRoles from token principals',
        steps: [{ check: { as: 'alice', permission: 'report:export' }, expect: { allowed: true } }, token('t', { owner: 'alice', roles: ['editor', 'route.export'] }), checkKept('t', { permission: 'report:export' }, { allowed: false }), checkKept('t', write, { allowed: true })],
      },
      {
        name: 'Scope permissions become ceiling permissions',
        steps: [token('t', { owner: 'alice', scope: { permissions: ['file:read'] } }, { ceiling: { permissions: ['file:read'] } }), checkKept('t', read(), { allowed: true }), checkKept('t', write, { allowed: false })],
      },
      {
        name: 'Scope resources become ceiling resources',
        steps: [token('t', { owner: 'alice', scope: { resources: [P1] } }, { ceiling: { resources: [{ type: 'project', id: 'p1' }] } }), checkKept('t', read(f1), { allowed: true }), checkKept('t', read(f2), { allowed: false })],
      },
      {
        name: "an agent token yields an agent acting for the owner, delegation 'inherit', ceiling reason out_of_scope",
        steps: [token('a', { owner: 'alice', scope: { agent: true, permissions: ['file:read'] } }, { type: 'agent', onBehalfOf: ALICE, delegation: 'inherit', ceiling: { permissions: ['file:read'], reason: 'out_of_scope' } }), checkKept('a', read(), { allowed: true }), checkKept('a', write, { allowed: false, reason: 'out_of_scope' })],
      },
      {
        name: 'an agent token is never above its owner',
        steps: [token('a', { owner: 'alice', scope: { agent: true, permissions: ['file:read', 'user:impersonate'] } }), checkKept('a', { permission: 'user:impersonate' }, { allowed: false })],
      },
    ],
  },
  {
    name: 'roleSwitch',
    facets: ['engine', 'rbac', 'authn'],
    lanes: ['C3'],
    note: 'POST /auth/active-role (design §22.11) through the RoleSource of users (C3).',
    world: tokenWorld,
    cases: [
      {
        name: 'a session role switch sets ceiling.roles only',
        steps: [flow('s', { kind: 'roleSwitch', as: 'alice', role: 'viewer' }, { principal: { type: 'user', id: 'alice', ceiling: { roles: ['viewer'] }, ceilingKeys: ['roles'] } }), checkKept('s', read(), { allowed: true }), checkKept('s', write, { allowed: false })],
      },
    ],
  },
]);
