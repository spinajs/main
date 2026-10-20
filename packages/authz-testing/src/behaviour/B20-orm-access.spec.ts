import { SYSTEM } from '@spinajs/authz';
import type { Permission } from '@spinajs/authz';

import type { ListPlanScript, VoteTable } from '../fakes/index.js';
import { userPrincipal } from '../principals.js';
import { allRows, combine, fixture, noRows, ownedRows, permit, relation, staticModel } from './dsl.js';
import { as, orm, ormRows } from './lane.js';
import type { OrmModelSpec, OrmQuery } from './lane.js';
import type { Case, World } from './types.js';

export const alice = userPrincipal('alice');
export const bob = userPrincipal('bob');
const admin = userPrincipal('admin');

/** `@AccessResource('task')` with `@Owner() owner`. alice owns t1 and t3, bob t2. */
export const TASK: OrmModelSpec = {
  name: 'Task',
  type: 'task',
  owner: 'owner',
  columns: ['title', 'owner'],
  rows: [
    { id: 't1', title: 'a', owner: 'alice' },
    { id: 't2', title: 'b', owner: 'bob' },
    { id: 't3', title: 'c', owner: 'alice' },
  ],
};

export const ALL = ['t1', 't2', 't3'];

const LIST_PERMISSIONS = ['task:read', 'task:update', 'task:delete'];

/** One kit model m1; task:read, task:update and task:delete are list permissions, each planned as no rows unless `lists` scripts it (boot rule 12 refuses a list permission without a plan). */
export const ormWorld = (votes: VoteTable, lists: Readonly<Record<Permission, ListPlanScript>> = {}, models: readonly OrmModelSpec[] = [TASK], extra: Partial<World> = {}): World => ({
  permissions: [...LIST_PERMISSIONS.map((name) => ({ name, list: true })), 'task:create'],
  principals: { alice, bob, admin },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes, lists: { ...Object.fromEntries(LIST_PERMISSIONS.map((p) => [p, noRows()])), ...lists } })],
  lane: { orm: { models } },
  ...extra,
});

const select = (accessible?: Permission): OrmQuery => ({ op: 'select', model: 'Task', ...(accessible ? { accessible } : {}) });
const OWNER_READ = { 'task:read': permit(relation('owner')) };
const OWNER_READ_LIST = { 'task:read': ownedRows() };
const NOT_CALLED = { calls: { model: 'm1', count: 0 } } as const;
const NOT_PLANNED = { calls: { model: 'm1', method: 'listPlan', count: 0 } } as const;

const selects: Case[] = [
  { name: 'select: a permit without a condition lists every row', world: ormWorld({ 'task:read': permit() }, { 'task:read': allRows() }), steps: [as('alice', orm(select('task:read'), { ids: ALL }))] },
  {
    name: 'select: an owner permit lists the rows whose owner column holds the principal',
    world: ormWorld(OWNER_READ, OWNER_READ_LIST),
    steps: [as('alice', orm(select('task:read'), { ids: ['t1', 't3'] })), as('bob', orm(select('task:read'), { ids: ['t2'] }))],
  },
  { name: 'select: no permit at all throws AccessDenied, not an empty list (H16)', world: ormWorld({}, { 'task:read': noRows() }), steps: [as('alice', orm(select('task:read'), { throws: 'AccessDenied', reason: 'no_access' }))] },
  { name: '.accessible() of a permission that is not list: true throws AuthzConfigError', world: ormWorld({ 'task:create': permit() }), steps: [as('alice', orm(select('task:create'), { throws: 'AuthzConfigError' }))] },
  { name: 'select: without .accessible() a query as a principal is refused by the runtime guard', world: ormWorld(OWNER_READ, OWNER_READ_LIST), steps: [as('alice', orm(select(), { throws: 'AuthzConfigError' })), NOT_CALLED, NOT_PLANNED] },
  {
    name: 'select: under runAs(SYSTEM) a query without .accessible() reads every row and consults no model',
    world: ormWorld(OWNER_READ, OWNER_READ_LIST),
    steps: [{ runAs: { as: SYSTEM, reason: 'test' }, steps: [orm(select(), { ids: ALL })] }, NOT_CALLED, NOT_PLANNED],
  },
  {
    name: 'select: .withAccess() carries per row what a check of the row answers',
    world: ormWorld({ 'task:read': permit(), 'task:update': permit(relation('owner')) }, { 'task:read': allRows(), 'task:update': ownedRows() }),
    steps: [as('alice', orm({ op: 'select', model: 'Task', accessible: 'task:read', withAccess: ['task:update'] }, { ids: ALL, access: { t1: { 'task:update': true }, t2: { 'task:update': false }, t3: { 'task:update': true } } }))],
  },
];

const writes: Case[] = [
  {
    name: 'update: .accessible() limits a bulk update to the rows the plan selects',
    world: ormWorld({ 'task:update': permit(relation('owner')) }, { 'task:update': ownedRows() }),
    steps: [as('alice', orm({ op: 'update', model: 'Task', where: {}, values: { title: 'z' }, accessible: 'task:update' }, {})), ormRows('Task', { rows: [{ id: 't1', title: 'z' }, { id: 't2', title: 'b' }, { id: 't3', title: 'z' }] })],
  },
  {
    name: 'delete: .accessible() limits a bulk delete the same way',
    world: ormWorld({ 'task:delete': permit(relation('owner')) }, { 'task:delete': ownedRows() }),
    steps: [as('bob', orm({ op: 'delete', model: 'Task', where: {}, accessible: 'task:delete' }, {})), ormRows('Task', { ids: ['t1', 't3'] })],
  },
  {
    name: 'insert: the ORM authorizes no insert; the app checks the parent first (design 2026-10-14 §6.1)',
    world: ormWorld({}),
    steps: [as('alice', orm({ op: 'insert', model: 'Task', values: { id: 't9', title: 'n', owner: 'bob' } }, {})), ormRows('Task', { ids: [...ALL, 't9'] }), NOT_CALLED],
  },
];

// configuration-http registers DbConfig with registerAccessResource(DbConfig, 'configuration'); its harness declares configuration:read with list: true.
const configWorld: World = {
  permissions: [],
  principals: { alice, admin },
  combine: combine('deny-overrides', 'm1'),
  models: [
    staticModel('m1', {
      votes: (req) => (req.principal.id === 'admin' && req.permission === 'configuration:read' ? permit() : {}),
      lists: { 'configuration:read': (p) => (p.id === 'admin' ? allRows() : noRows()) },
    }),
  ],
  lane: {
    configuration: {
      rows: [
        { path: 'app.title', value: 'T' },
        { path: 'app.theme', value: 'dark' },
      ],
    },
  },
};

const CONFIG_LIST: OrmQuery = { op: 'select', model: 'DbConfig', accessible: 'configuration:read' };

export const B20 = fixture('B20', [
  {
    name: 'orm',
    facets: ['engine', 'host', 'orm'],
    lanes: ['L5'],
    note: 'Lists through .accessible(), per-row access through .withAccess(), the runtime guard (test env) and runAs(SYSTEM) (design 2026-10-14 §6.2, §8, §10.3).',
    cases: [...selects, ...writes],
  },
  {
    name: 'configuration',
    facets: ['engine', 'host', 'orm', 'configuration'],
    lanes: ['L5'],
    world: configWorld,
    cases: [
      { name: 'DbConfig: no permit is AccessDenied', steps: [as('alice', orm(CONFIG_LIST, { throws: 'AccessDenied' }))] },
      { name: 'DbConfig: configuration:read lists every row', steps: [as('admin', orm(CONFIG_LIST, { count: 2 }))] },
      { name: 'DbConfig: without a principal the list is refused (unattended)', steps: [orm(CONFIG_LIST, { throws: 'AccessDenied', reason: 'unattended' })] },
    ],
  },
]);
