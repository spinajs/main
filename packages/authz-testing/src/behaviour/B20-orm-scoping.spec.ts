import { and, or } from '@spinajs/authz';

import type { VoteTable } from '../fakes/index.js';
import { userPrincipal, withAttributes } from '../principals.js';
import { cmp, combine, fixture, permit, ref, relation, staticModel, under } from './dsl.js';
import { as, orm, ormRows } from './lane.js';
import type { OrmModelSpec, OrmScopeSpec } from './lane.js';
import type { Case, World } from './types.js';

export const alice = withAttributes(userPrincipal('alice'), { team: 'red' });
export const bob = withAttributes(userPrincipal('bob'), { team: 'blue' });
const admin = userPrincipal('admin');

/** `@AccessResource('task')` with `@Owner() owner`. alice owns t1 and t3, bob t2; only t2 is public. */
export const TASK: OrmModelSpec = {
  name: 'Task',
  type: 'task',
  owner: 'owner',
  columns: ['title', 'status', 'owner', 'team', 'visibility'],
  rows: [
    { id: 't1', title: 'a', status: 'open', owner: 'alice', team: 'red', visibility: 'private' },
    { id: 't2', title: 'b', status: 'open', owner: 'bob', team: 'blue', visibility: 'public' },
    { id: 't3', title: 'c', status: 'closed', owner: 'alice', team: 'blue', visibility: 'private' },
  ],
};

/** The ORM adapter registers task:read|create|update|delete (design §5.2 source 'adapter:orm', §12.1). */
export const ormWorld = (votes: VoteTable, models: readonly OrmModelSpec[] = [TASK], extra: Partial<World> = {}): World => ({
  permissions: [],
  principals: { alice, bob, admin },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes })],
  lane: { orm: { models } },
  ...extra,
});

/** TASK under project p1 through `@ScopeColumn('project_id', 'project')`. */
const PROJECT_TASK: OrmModelSpec = { ...TASK, columns: [...TASK.columns, 'project_id'], scopeColumns: [{ column: 'project_id', type: 'project' }], rows: (TASK.rows ?? []).map((r) => ({ ...r, project_id: 'p1' })) };

const TEAM = (opts: Partial<OrmScopeSpec>): OrmModelSpec => ({ ...TASK, scopes: [{ relation: 'team', column: 'team', attribute: 'team', ...opts }] });

const OWNER = permit(relation('owner'));
const select = { op: 'select', model: 'Task' } as const;
const update = (id: string, values: Record<string, unknown>) => ({ op: 'update', model: 'Task', where: { id }, values } as const);
const del = (id: string) => ({ op: 'delete', model: 'Task', where: { id } } as const);
const insert = (values: Record<string, unknown>) => ({ op: 'insert', model: 'Task', values: { id: 't9', title: 'new', status: 'open', visibility: 'private', ...values } } as const);
const DENIED = { throws: 'AccessDenied' } as const;
const FORBIDDEN = { throws: 'Forbidden' } as const;
const ALL = ['t1', 't2', 't3'];

const selects: Case[] = [
  { name: 'select: TRUE adds no WHERE', world: ormWorld({ 'task:read': permit() }), steps: [as('alice', orm(select, { ids: ALL, where: false }))] },
  {
    name: 'select: a residual becomes a WHERE that keeps its OR and AND',
    world: ormWorld({ 'task:read': permit(or(and(cmp('status', 'eq', 'open'), relation('owner')), cmp('visibility', 'eq', 'public'))) }),
    steps: [as('alice', orm(select, { ids: ['t1', 't2'], where: true })), as('bob', orm(select, { ids: ['t2'] }))],
  },
  { name: "select: the residual ANDs with the query's own where", world: ormWorld({ 'task:read': OWNER }), steps: [as('alice', orm({ ...select, where: { status: 'open' } }, { ids: ['t1'] }))] },
  { name: 'select: a residual no row meets is an empty list, not a 403', world: ormWorld({ 'task:read': permit(cmp('status', 'eq', 'archived')) }), steps: [as('alice', orm(select, { ids: [] }))] },
  { name: 'select: FALSE (no permit at all) is AccessDenied, not an empty list (H16)', world: ormWorld({}), steps: [as('alice', orm(select, DENIED))] },
];

/** Not scoped (no `type`); each note belongs to a task. */
const NOTE: OrmModelSpec = {
  name: 'Note',
  columns: ['task_id'],
  rows: [
    { id: 'n1', task_id: 't1' },
    { id: 'n2', task_id: 't2' },
    { id: 'n3', task_id: 't3' },
  ],
  belongsTo: [{ name: 'task', target: 'Task', column: 'task_id' }],
};
const JOINED_TASK: OrmModelSpec = { ...TASK, relationScope: 'join' };
const populated = { op: 'select', model: 'Note', populate: 'task' } as const;

// RFC L4-1: a populated target's residual goes where its relationScope says.
const joins: Case[] = [
  {
    name: "select: a relationScope 'join' target's residual goes into the JOIN ON; the parent rows stay",
    world: ormWorld({ 'task:read': OWNER }, [JOINED_TASK, NOTE]),
    steps: [as('bob', orm(populated, { ids: ['n1', 'n2', 'n3'], populated: { n1: null, n2: 't2', n3: null }, where: false }))],
  },
  {
    name: "select: a relationScope 'where' target's residual goes into the WHERE; parent rows whose target is hidden drop",
    world: ormWorld({ 'task:read': OWNER }, [TASK, NOTE]),
    steps: [as('bob', orm(populated, { ids: ['n2'], populated: { n2: 't2' }, where: true }))],
  },
  { name: 'select: a populated target with no permit at all is AccessDenied (H16)', world: ormWorld({}, [JOINED_TASK, NOTE]), steps: [as('bob', orm(populated, DENIED))] },
];

const updates: Case[] = [
  { name: 'update: TRUE updates any row', world: ormWorld({ 'task:update': permit() }), steps: [as('alice', orm(update('t2', { title: 'x' }), {})), ormRows('Task', { rows: [{ id: 't2', title: 'x' }] })] },
  {
    name: 'update: a residual limits the rows it changes',
    world: ormWorld({ 'task:update': OWNER }),
    steps: [
      as('alice', orm(update('t2', { title: 'x' }), {}), orm(update('t1', { title: 'y' }), {})),
      ormRows('Task', {
        rows: [
          { id: 't2', title: 'b' },
          { id: 't1', title: 'y' },
        ],
      }),
    ],
  },
  { name: 'update: FALSE is AccessDenied', world: ormWorld({ 'task:read': permit() }), steps: [as('alice', orm(update('t1', { title: 'x' }), DENIED)), ormRows('Task', { rows: [{ id: 't1', title: 'a' }] })] },
  {
    name: 'update under a relation calls authorizeUpdate(values): moving a row out of scope is 403',
    world: ormWorld({ 'task:update': permit(relation('team')) }, [TEAM({ guardUpdate: true })]),
    steps: [as('alice', orm(update('t1', { team: 'blue' }), FORBIDDEN), orm(update('t1', { title: 'y' }), {})), ormRows('Task', { rows: [{ id: 't1', team: 'red', title: 'y' }] })],
  },
];

const deletes: Case[] = [
  { name: 'delete: TRUE deletes any row', world: ormWorld({ 'task:delete': permit() }), steps: [as('alice', orm(del('t2'), {})), ormRows('Task', { ids: ['t1', 't3'] })] },
  { name: 'delete: a residual limits the rows it deletes', world: ormWorld({ 'task:delete': OWNER }), steps: [as('alice', orm(del('t2'), {}), orm(del('t1'), {})), ormRows('Task', { ids: ['t2', 't3'] })] },
  { name: 'delete: FALSE is AccessDenied', world: ormWorld({ 'task:read': permit() }), steps: [as('alice', orm(del('t1'), DENIED)), ormRows('Task', { ids: ALL })] },
];

const inserts: Case[] = [
  { name: 'insert: TRUE inserts as given', world: ormWorld({ 'task:create': permit() }), steps: [as('alice', orm(insert({ owner: 'bob' }), {})), ormRows('Task', { rows: [{ id: 't9', owner: 'bob' }] })] },
  { name: 'insert: the owner relation stamps the @Owner column', world: ormWorld({ 'task:create': OWNER }), steps: [as('alice', orm(insert({}), {})), ormRows('Task', { rows: [{ id: 't9', owner: 'alice' }] })] },
  { name: "insert: another relation goes to its OrmScopePolicy's authorizeCreate (stamp)", world: ormWorld({ 'task:create': permit(relation('team')) }, [TEAM({ onCreate: 'stamp' })]), steps: [as('alice', orm(insert({}), {})), ormRows('Task', { rows: [{ id: 't9', team: 'red' }] })] },
  {
    name: "insert: another relation goes to its OrmScopePolicy's authorizeCreate (reject)",
    world: ormWorld({ 'task:create': permit(relation('team')) }, [TEAM({ onCreate: 'check' })]),
    steps: [as('alice', orm(insert({ team: 'blue' }), FORBIDDEN)), ormRows('Task', { ids: ALL }), as('alice', orm(insert({ team: 'red' }), {})), ormRows('Task', { ids: [...ALL, 't9'] })],
  },
  {
    name: 'insert: a cmp residual checks the inserted values',
    world: ormWorld({ 'task:create': permit(cmp('status', 'eq', 'draft')) }),
    steps: [as('alice', orm(insert({ status: 'open' }), FORBIDDEN)), ormRows('Task', { ids: ALL }), as('alice', orm(insert({ status: 'draft' }), {})), ormRows('Task', { ids: [...ALL, 't9'] })],
  },
  {
    name: 'insert: any other residual (under) is 403, even for a row inside the scope',
    world: ormWorld({ 'task:create': permit(under(ref('project', 'p1'))) }, [PROJECT_TASK]),
    steps: [as('alice', orm(insert({ project_id: 'p1' }), FORBIDDEN)), ormRows('Task', { ids: ALL })],
  },
  { name: 'insert: no permit is 403', world: ormWorld({ 'task:read': permit() }), steps: [as('alice', orm(insert({}), FORBIDDEN)), ormRows('Task', { ids: ALL })] },
];

// configuration-http registers DbConfig with registerAccessResource(DbConfig, 'configuration') (design §14.1, plan C6).
const configWorld: World = {
  permissions: [],
  principals: { alice, admin },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: (req) => (req.principal.id === 'admin' && req.permission === 'configuration:read' ? permit() : {}) })],
  lane: {
    configuration: {
      rows: [
        { path: 'app.title', value: 'T' },
        { path: 'app.theme', value: 'dark' },
      ],
    },
  },
};

export const B20 = fixture('B20', [
  {
    name: 'orm',
    facets: ['engine', 'host', 'orm'],
    lanes: ['L4'],
    note: "The JOIN ON placement of relationScope 'join' is asserted on a belongsTo target populated into a select (RFC L4-1): rows, populated ids and the absence of a WHERE, not the SQL text.",
    cases: [...selects, ...joins, ...updates, ...deletes, ...inserts],
  },
  {
    name: 'configuration',
    facets: ['engine', 'host', 'orm', 'configuration'],
    lanes: ['C6'],
    world: configWorld,
    cases: [
      { name: 'DbConfig rows are scoped: no permit is AccessDenied', steps: [as('alice', orm({ op: 'select', model: 'DbConfig' }, DENIED))] },
      { name: 'DbConfig rows are scoped: configuration:read lists them', steps: [as('admin', orm({ op: 'select', model: 'DbConfig' }, { count: 2 }))] },
    ],
  },
]);
