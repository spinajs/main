import type { FieldSet } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { assignment, cmp, combine, deny, fixture, permit, ref, role, staticModel } from './dsl.js';
import type { Case, StaticModelSpec, World } from './types.js';

const alice = userPrincipal('alice');
const u1 = ref('user', 'u1');
const READ = { name: 'user:read', fields: true };
const FIELDS_MODEL = { capabilities: { fields: true } } as const;

const permitting = (name: string, fields: FieldSet): StaticModelSpec => staticModel(name, { ...FIELDS_MODEL, votes: { 'user:read': permit(undefined, { fields }) } });

const world = (models: StaticModelSpec[], extra: Partial<World> = {}): World => ({
  permissions: [READ],
  principals: { alice },
  combine: combine('deny-overrides', ...models.map((m) => m.name)),
  models,
  ...extra,
});

const core: Case[] = [
  {
    name: 'read and write are the union over the permitting votes',
    world: world([permitting('m1', { read: ['a', 'b'], write: ['a'] }), permitting('m2', { read: ['c'], write: ['c'] })]),
    steps: [{ check: { as: 'alice', permission: 'user:read', resource: u1 }, expect: { allowed: true, fields: { read: { allows: ['a', 'b', 'c'], denies: ['d'] }, write: { allows: ['a', 'c'], denies: ['b', 'd'] } } } }],
  },
  {
    name: 'a model that does not permit adds no fields',
    world: world([permitting('m1', { read: ['a'] }), staticModel('m2', { ...FIELDS_MODEL, votes: { 'user:read': { fields: { read: ['b'] } } } })]),
    steps: [{ check: { as: 'alice', permission: 'user:read', resource: u1 }, expect: { allowed: true, fields: { read: { allows: ['a'], denies: ['b'] } } } }],
  },
  {
    name: 'hide from a model whose deny is not FALSE is removed from read and write',
    world: world([permitting('m1', { read: ['a', 'b'], write: ['a', 'b'] }), staticModel('m2', { ...FIELDS_MODEL, votes: { 'user:read': deny(undefined, cmp('status', 'eq', 'locked'), { fields: { hide: ['b'] } }) } })]),
    steps: [{ check: { as: 'alice', permission: 'user:read' }, expect: { allowed: true, residual: 'conditional', fields: { read: { allows: ['a'], denies: ['b'] }, write: { allows: ['a'], denies: ['b'] } } } }],
  },
  {
    name: 'authz.fields.neverRead (default Password) is removed',
    world: world([permitting('m1', { read: ['*'], write: ['*'] })]),
    steps: [{ check: { as: 'alice', permission: 'user:read', resource: u1 }, expect: { allowed: true, fields: { read: { allows: ['name'], denies: ['Password'] }, write: { allows: ['name'], denies: ['Password'] } } } }],
  },
  {
    name: 'authz.fields.neverRead from config is removed from read and write',
    world: world([permitting('m1', { read: ['*'], write: ['*'] })], { config: { fields: { neverRead: ['secret'] } } }),
    steps: [{ check: { as: 'alice', permission: 'user:read', resource: u1 }, expect: { allowed: true, fields: { read: { allows: ['name'], denies: ['secret'] }, write: { allows: ['name'], denies: ['secret'] } } } }],
  },
  {
    name: '!X negations and A.* globs work',
    world: world([permitting('m1', { read: ['*', '!internal'], write: ['profile.*'] })]),
    steps: [{ check: { as: 'alice', permission: 'user:read', resource: u1 }, expect: { allowed: true, fields: { read: { allows: ['name', 'profile.age'], denies: ['internal'] }, write: { allows: ['profile.age'], denies: ['name'] } } } }],
  },
  // D-F5-2: a permitting vote without fields contributes every field.
  {
    name: 'a permitting vote without fields contributes every field, before hide and neverRead',
    world: world([staticModel('m1', { votes: { 'user:read': permit() } }), permitting('m2', { read: ['a'] }), staticModel('m3', { ...FIELDS_MODEL, votes: { 'user:read': deny(undefined, cmp('status', 'eq', 'locked'), { fields: { hide: ['b'] } }) } })]),
    steps: [{ check: { as: 'alice', permission: 'user:read' }, expect: { allowed: true, residual: 'conditional', fields: { read: { allows: ['a', 'name', 'profile.age'], denies: ['b', 'Password'] }, write: { allows: ['a', 'name'], denies: ['b', 'Password'] } } } }],
  },
];

const rbacWorld: World = {
  permissions: [READ],
  principals: { alice },
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [role('reader', [{ permission: 'user:read', fields: { read: ['name', 'email'] } }]), role('avatars', [{ permission: 'user:read', fields: { read: ['avatar'] } }])],
    assignments: [assignment('a1', alice, 'reader'), assignment('a2', alice, 'avatars')],
  },
};

const abacWorld: World = {
  permissions: [READ],
  principals: { alice },
  combine: combine('deny-overrides', 'abac'),
  abac: {
    policies: [
      { id: 'read', effect: 'permit', permissions: ['user:read'], fields: { read: ['name', 'email'] }, source: 'test' },
      { id: 'locked', effect: 'deny', permissions: ['user:read'], when: { attr: 'resource.status', eq: 'locked' }, fields: { hide: ['email'] }, source: 'test' },
    ],
  },
};

export const B17 = fixture('B17', [
  { name: 'core', facets: ['engine'], lanes: ['F3'], cases: core },
  {
    name: 'rbac',
    facets: ['engine', 'rbac'],
    lanes: ['L1'],
    world: rbacWorld,
    cases: [{ name: 'grant field sets of every held role are united', steps: [{ check: { as: 'alice', permission: 'user:read', resource: u1 }, expect: { allowed: true, fields: { read: { allows: ['name', 'email', 'avatar'], denies: ['salary'] } } } }] }],
  },
  {
    name: 'abac',
    facets: ['engine', 'abac', 'conditions'],
    lanes: ['L3'],
    world: abacWorld,
    cases: [{ name: 'a conditional deny policy hides its fields', steps: [{ check: { as: 'alice', permission: 'user:read' }, expect: { allowed: true, residual: 'conditional', fields: { read: { allows: ['name'], denies: ['email'] } } } }] }],
  },
  { name: 'http', facets: ['http'], lanes: ['L5'], note: 'Output filtering to readable fields, and input outside write stripped (400 in reject mode); L5 proposes the cases.', cases: [] },
  { name: 'users', facets: ['http'], lanes: ['C2'], note: 'User profile fields through users-http; C2 proposes the cases.', cases: [] },
]);
