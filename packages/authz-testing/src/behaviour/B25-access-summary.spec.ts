import { GLOBAL } from '@spinajs/authz';

import { userPrincipal, withCeiling } from '../principals.js';
import { assignment, combine, fixture, later, role } from './dsl.js';
import { accessOfFlow, flow, http } from './lane.js';
import type { KitModelSpec, World } from './types.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const HOUR = 3_600_000;

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const admin = userPrincipal('admin');
const narrowed = withCeiling(alice, { permissions: ['file:read'] });

const ACCESS = { method: 'GET', path: '/user/access' } as const;

const fakeRbac: KitModelSpec = {
  kind: 'fake-rbac',
  roles: { editor: ['file:read', { permission: 'file:write', relation: 'owner' }], viewer: ['file:read'], admin: ['*'] },
  assignments: [
    { subject: alice, role: 'editor' },
    { subject: bob, role: 'viewer' },
    { subject: admin, role: 'admin' },
  ],
};

const kitWorld = (anonymous: boolean): World => ({
  permissions: ['file:read', 'file:write', 'file:delete', 'user:impersonate'],
  principals: { alice, bob, admin, narrowed },
  combine: combine('deny-overrides', 'rbac'),
  models: [fakeRbac],
  config: { principals: { anonymous: { enabled: anonymous } } },
  lane: { http: {} },
});

const rbacWorld: World = {
  now: NOW,
  permissions: ['file:read', { name: 'user:read', fields: true }],
  principals: { alice },
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [role('editor', ['file:read', { permission: 'user:read', fields: { read: ['name', 'email'] } }])],
    assignments: [assignment('a1', alice, 'editor', GLOBAL, { expiresAt: later(NOW, HOUR) })],
  },
  lane: { http: {} },
};

export const B25 = fixture('B25', [
  {
    name: 'http',
    facets: ['engine', 'http'],
    lanes: ['L5'],
    note: 'AccessSummary (design §5.7) over a FakeRbacModel. Ladder ranks have no field in AccessSummary or ModelSummary yet; L1b/L5 propose their place by RFC.',
    world: kitWorld(true),
    cases: [
      {
        name: 'GET /user/access returns the principal, its roles with scope, and GLOBAL permissions with conditional',
        steps: [
          http(
            { ...ACCESS, as: 'alice' },
            {
              status: 200,
              body: {
                principal: { type: 'user', id: 'alice' },
                models: [{ model: 'rbac', roles: [{ role: 'editor', scope: { type: '$global' } }] }],
                permissions: [
                  { name: 'file:read', conditional: false },
                  { name: 'file:write', conditional: true },
                ],
              },
              none: [{ at: 'permissions', match: { name: 'file:delete' } }],
            },
          ),
        ],
      },
      { name: 'GET /user/access returns the ceiling', steps: [http({ ...ACCESS, as: 'narrowed' }, { status: 200, body: { principal: { type: 'user', id: 'alice' }, ceiling: { permissions: ['file:read'] } } })] },
      { name: 'GET /user/access answers an anonymous request with the anonymous principal', steps: [http(ACCESS, { status: 200, body: { principal: { type: 'anonymous' } } })] },
      { name: 'GET /user/access answers 401 without a principal when anonymous is disabled', world: kitWorld(false), steps: [http(ACCESS, { status: 401 })] },
    ],
  },
  {
    name: 'rbac',
    facets: ['engine', 'rbac', 'http'],
    lanes: ['C3'],
    world: rbacWorld,
    cases: [
      {
        name: 'roles carry their expiry and permissions their fields',
        steps: [
          http(
            { ...ACCESS, as: 'alice' },
            {
              status: 200,
              body: {
                models: [{ model: 'rbac', roles: [{ role: 'editor', scope: { type: '$global' }, expiresAt: later(NOW, HOUR).toISOString() }] }],
                permissions: [{ name: 'user:read', conditional: false, fields: { read: ['name', 'email'] } }],
              },
            },
          ),
        ],
      },
    ],
  },
  {
    name: 'authn',
    facets: ['engine', 'http', 'authn'],
    lanes: ['C3'],
    note: 'Each flow answer carries Access, equal to GET /user/access for the principal the session then yields (design §11.4, §22.11).',
    world: kitWorld(false),
    cases: [
      { name: 'the login response carries Access', steps: [flow('login', { kind: 'login', as: 'alice' }), accessOfFlow('login')] },
      { name: 'the MFA completion response carries Access', steps: [flow('mfa', { kind: 'mfa', as: 'alice' }), accessOfFlow('mfa')] },
      { name: 'the role switch response carries Access', steps: [flow('switch', { kind: 'roleSwitch', as: 'alice', role: 'editor' }), accessOfFlow('switch')] },
      { name: 'the impersonation response carries Access', steps: [flow('imp', { kind: 'impersonation', as: 'admin', target: 'bob' }, { principal: { type: 'user', id: 'bob' } }), accessOfFlow('imp')] },
    ],
  },
]);
