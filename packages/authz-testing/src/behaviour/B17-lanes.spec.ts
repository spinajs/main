import type { FieldSet } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { combine, extension, permit, ref, staticModel } from './dsl.js';
import { http } from './lane.js';
import type { RouteSpec } from './lane.js';
import type { World } from './types.js';

const alice = userPrincipal('alice');
const USER = { from: 'param', name: 'id', type: 'user' } as const;
const FIELDS = { capabilities: { fields: true } } as const;

const routes: RouteSpec[] = [
  { method: 'GET', path: '/users/:id', access: { permission: 'user:read', resource: USER, fields: 'filter' }, handler: { returns: ref('user', 'u1') } },
  { method: 'PATCH', path: '/users/:id', access: { permission: 'user:update', resource: USER, fields: 'none' }, handler: 'echo' },
];

const world = (read: FieldSet, write: FieldSet, extra: Partial<World> = {}): World => ({
  permissions: [
    { name: 'user:read', fields: true },
    { name: 'user:update', fields: true },
  ],
  principals: { alice },
  adapters: [{ types: ['user'], rows: { user: [{ id: 'u1', name: 'N', email: 'e@example.com', salary: 9, Password: 'hash' }] } }],
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { ...FIELDS, votes: { 'user:read': permit(undefined, { fields: read }), 'user:update': permit(undefined, { fields: write }) } })],
  lane: { http: { routes } },
  ...extra,
});

const GET = { method: 'GET', path: '/users/u1', as: 'alice' } as const;
const PATCH = { method: 'PATCH', path: '/users/u1', as: 'alice', body: { name: 'M', salary: 10 } } as const;

const users: World = {
  permissions: [{ name: 'user:read', fields: true }],
  principals: { alice },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { ...FIELDS, votes: { 'user:read': permit(undefined, { fields: { read: ['Login', 'Email'] } }) } })],
  lane: { http: { identities: { 'user:alice': { Login: 'alice', Email: 'alice@example.com', Password: 'hash', IsActive: true } } } },
};

export const B17Lanes = extension('B17', [
  {
    name: 'http',
    facets: ['engine', 'http'],
    lanes: ['L5'],
    note: 'Output: AuthzFieldTransformer with decision.fields.read; input: the ArgInputFilter with decision.fields.write (design §11.3).',
    cases: [
      { name: 'the output filter keeps only readable fields', world: world({ read: ['id', 'name', 'email'] }, {}), steps: [http(GET, { status: 200, body: { name: 'N', email: 'e@example.com' }, absent: ['salary', 'Password'] })] },
      { name: 'the output filter drops authz.fields.neverRead even under *', world: world({ read: ['*'] }, {}), steps: [http(GET, { status: 200, body: { name: 'N', salary: 9 }, absent: ['Password'] })] },
      { name: 'input outside fields.write is stripped', world: world({}, { write: ['name'] }), steps: [http(PATCH, { status: 200, body: { name: 'M' }, absent: ['salary'] })] },
      { name: "input outside fields.write is 400 in 'reject' mode", world: world({}, { write: ['name'] }, { config: { fields: { write: { mode: 'reject' } } } }), steps: [http(PATCH, { status: 400 })] },
    ],
  },
  {
    name: 'users',
    facets: ['engine', 'http'],
    lanes: ['C2'],
    note: 'GET /user (users-http) answers the identity record of the principal through the output filter.',
    world: users,
    cases: [{ name: 'GET /user keeps only readable fields of the user record', steps: [http({ method: 'GET', path: '/user', as: 'alice' }, { status: 200, body: { Login: 'alice', Email: 'alice@example.com' }, absent: ['Password', 'IsActive'] })] }],
  },
]);
