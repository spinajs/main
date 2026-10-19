import { userPrincipal } from '../principals.js';
import { assignment, combine, fixture, ref, relation, role } from './dsl.js';
import type { Case, World } from './types.js';

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const dave = userPrincipal('dave');

const files = [
  { id: 'f1', owner: 'alice', member: 'bob' },
  { id: 'f2', owner: 'bob', member: 'alice' },
  { id: 'f3', owner: 'carol', member: null },
  { id: 'f4', owner: 'dave', member: 'carol' },
];

const world: World = {
  permissions: ['file:read', 'job:read', 'user:read'],
  principals: { alice, bob, carol, dave },
  adapters: [
    {
      types: ['file'],
      rows: { file: files },
      relations: [
        { type: 'file', relation: 'owner', column: 'owner' },
        { type: 'file', relation: 'member', column: 'member' },
      ],
    },
  ],
  relations: [
    { type: 'job', relation: 'initiator', holds: (p, _ref, subject) => (subject as { initiator?: string } | undefined)?.initiator === p.id },
    { type: 'user', relation: 'self', holds: (p, r) => r.id === p.id },
  ],
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [
      role('owner-reader', [{ permission: 'file:read', relation: 'owner' }]),
      role('either', [{ permission: 'file:read', relation: ['owner', 'member'] }]),
      role('two-grants', [
        { permission: 'file:read', relation: 'owner' },
        { permission: 'file:read', relation: 'member' },
      ]),
      role('reader', ['file:read']),
      role('job-owner', [{ permission: 'job:read', relation: 'initiator' }]),
      role('self', [{ permission: 'user:read', relation: 'self' }]),
    ],
    assignments: [assignment('a1', alice, 'owner-reader'), assignment('a2', alice, 'job-owner'), assignment('a3', alice, 'self'), assignment('b1', bob, 'either'), assignment('c1', carol, 'two-grants'), assignment('d1', dave, 'owner-reader'), assignment('d2', dave, 'reader')],
  },
};

const row = (as: string, id: string) => ({ as, permission: 'file:read', resource: ref('file', id), subject: 'row' as const });

const cases: Case[] = [
  {
    name: 'a grant with relation R gives the residual relation(R)',
    steps: [
      { check: { as: 'alice', permission: 'file:read' }, expect: { allowed: true, residual: { equals: relation('owner') } } },
      { filter: { as: 'alice', permission: 'file:read', type: 'file' }, expect: { selects: ['f1'] } },
    ],
  },
  {
    name: "with a subject the relation resolves through the type's RelationResolver",
    steps: [
      { check: row('alice', 'f1'), expect: { allowed: true, residual: 'TRUE' } },
      { check: row('alice', 'f2'), expect: { allowed: false, residual: 'FALSE' } },
    ],
  },
  {
    name: 'several relations in one grant are OR-ed',
    steps: [
      { filter: { as: 'bob', permission: 'file:read', type: 'file' }, expect: { selects: ['f1', 'f2'] } },
      { check: row('bob', 'f1'), expect: { allowed: true } },
      { check: row('bob', 'f3'), expect: { allowed: false } },
    ],
  },
  {
    name: 'grants with different relations for one permission are OR-ed',
    steps: [
      { filter: { as: 'carol', permission: 'file:read', type: 'file' }, expect: { selects: ['f3', 'f4'] } },
      { check: row('carol', 'f4'), expect: { allowed: true } },
    ],
  },
  {
    name: 'a grant without relation is unconditional, also next to a relation grant',
    steps: [
      { check: { as: 'dave', permission: 'file:read' }, expect: { allowed: true, residual: 'TRUE' } },
      { filter: { as: 'dave', permission: 'file:read', type: 'file' }, expect: 'TRUE' },
    ],
  },
  {
    name: "another type's relation resolves through that type's resolver (job initiator)",
    steps: [
      { check: { as: 'alice', permission: 'job:read', resource: ref('job', 'j1'), subject: { id: 'j1', initiator: 'alice' } }, expect: { allowed: true } },
      { check: { as: 'alice', permission: 'job:read', resource: ref('job', 'j2'), subject: { id: 'j2', initiator: 'bob' } }, expect: { allowed: false } },
    ],
  },
  {
    name: 'the self relation resolves through the user type resolver',
    steps: [
      { check: { as: 'alice', permission: 'user:read', resource: ref('user', 'alice'), subject: { id: 'alice' } }, expect: { allowed: true } },
      { check: { as: 'alice', permission: 'user:read', resource: ref('user', 'bob'), subject: { id: 'bob' } }, expect: { allowed: false } },
    ],
  },
];

export const B15 = fixture('B15', [
  {
    name: 'rbac',
    facets: ['engine', 'rbac'],
    lanes: ['L1'],
    note: "Kit relation resolvers stand in for the lanes' own: the owner column (FakeAdapter), job initiator and self (world.relations). @Owner (authz-orm), self on users (C1), file metadata (L7) and the job owner (authz-queue) are tested by their lanes with their resolvers.",
    world,
    cases,
  },
]);
