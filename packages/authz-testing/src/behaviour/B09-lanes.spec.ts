import assert from 'node:assert/strict';

import { SYSTEM, UNATTENDED } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { allRows, combine, extension, ownedRows, permit, ref, relation, staticModel } from './dsl.js';
import { as, emitted, handled, http, laneCall, laneHandle, orm } from './lane.js';
import type { OrmQuery } from './lane.js';
import { TASK, ormWorld } from './B20-orm-access.spec.js';
import { fsGrants, fsWorld } from './B28-fs-guard.spec.js';
import type { StepContext } from './harness.js';
import type { FixturePart, World } from './types.js';

const f1 = ref('file', 'f1');
const ALL = ['t1', 't2', 't3'];
const SELECT: OrmQuery = { op: 'select', model: 'Task' };
const ACCESSIBLE: OrmQuery = { op: 'select', model: 'Task', accessible: 'task:read' };
const NOT_PLANNED = { calls: { model: 'm1', method: 'listPlan', count: 0 } } as const;
const NOT_CALLED = { calls: { model: 'm1', count: 0 } } as const;
const UNATTENDED_DENIED = { throws: 'AccessDenied', reason: 'unattended' } as const;
// The audit steps rely on these keys; only the sample config of design §8.1 turns them on.
const AUDIT = { audit: { denials: true, runAs: true, unscoped: true } } as const;

const ormPart: FixturePart = {
  name: 'orm',
  facets: ['engine', 'host', 'audit', 'orm'],
  lanes: ['L5'],
  world: ormWorld({ 'task:read': permit(relation('owner')) }, { 'task:read': ownedRows() }, [TASK], { config: AUDIT }),
  cases: [
    { name: '.accessible() without a principal throws AccessDenied (unattended) and asks no model', steps: [orm(ACCESSIBLE, UNATTENDED_DENIED), NOT_CALLED, NOT_PLANNED] },
    {
      name: 'under runAs(SYSTEM, reason) a select reads every row, consults no model and the bypass is audited',
      steps: [{ runAs: { as: SYSTEM, reason: 'cli' }, steps: [orm(SELECT, { ids: ALL })] }, NOT_CALLED, NOT_PLANNED, { audit: { kind: 'runAs', reason: 'cli' } }],
    },
  ],
};

const httpWorld: World = {
  ...ormWorld({ 'task:read': permit(relation('owner')) }, { 'task:read': ownedRows() }, [TASK], { config: AUDIT }),
  lane: {
    orm: { models: [TASK] },
    http: { routes: [{ method: 'GET', path: '/tasks', access: { permission: 'task:read' }, handler: { orm: ACCESSIBLE } }] },
  },
};

const httpPart: FixturePart = {
  name: 'http',
  facets: ['engine', 'audit', 'http', 'orm'],
  lanes: ['L5'],
  world: httpWorld,
  cases: [{ name: "a route's .accessible() list runs as the request principal", steps: [http({ method: 'GET', path: '/tasks', as: 'alice' }, { status: 200, body: { ids: ['t1', 't3'] }, none: [{ at: 'ids', match: 't2' }] })] }],
};

const queueWorld: World = {
  permissions: ['file:read'],
  principals: { alice: userPrincipal('alice') },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: { '*': permit() } })],
  config: AUDIT,
  lane: {
    queue: {
      jobs: [
        { name: 'cleanup', runAs: 'system', checks: [{ permission: 'file:read', resource: f1 }] },
        { name: 'plain', checks: [{ permission: 'file:read', resource: f1 }] },
      ],
    },
  },
};

const queuePart: FixturePart = {
  name: 'queue',
  facets: ['engine', 'host', 'audit', 'queue'],
  lanes: ['L6'],
  world: queueWorld,
  cases: [
    {
      name: "@Job({ runAs: 'system' }) runs as SYSTEM, consults no model, and runAs is audited with job:<name>",
      steps: [as('alice', emitted('m', 'cleanup')), handled('m', { principal: SYSTEM, decisions: [{ allowed: true, residual: 'TRUE' }] }), NOT_CALLED, { audit: { kind: 'runAs', reason: 'job:cleanup' } }],
    },
    { name: 'a job without runAs runs unattended: its checks deny with unattended', steps: [as('alice', emitted('m', 'plain')), handled('m', { principal: UNATTENDED, decisions: [{ allowed: false, reason: 'unattended' }] })] },
  ],
};

const configurationPart: FixturePart = {
  name: 'configuration',
  facets: ['engine', 'audit', 'configuration'],
  lanes: ['C6'],
  note: 'DbConfig carries @AccessResource(configuration) (design §14.1); no model permits anything here, so only SYSTEM can read the rows.',
  world: {
    permissions: [],
    principals: {},
    combine: combine('deny-overrides', 'm1'),
    models: [staticModel('m1')],
    config: AUDIT,
    lane: { configuration: { rows: [{ path: 'app.title', value: 'T' }] } },
  },
  cases: [
    {
      name: "configuration-db-source polls under runAs(SYSTEM, 'config-poll')",
      steps: [
        {
          note: 'poll',
          do: async (ctx) => {
            const c = laneHandle(ctx, 'configuration');
            await c.poll();
            assert.equal(c.value('app.title'), 'T', 'app.title after the poll');
          },
        },
        NOT_CALLED,
        { audit: { kind: 'runAs', reason: 'config-poll' } },
      ],
    },
  ],
};

const socketPart: FixturePart = {
  name: 'socket',
  facets: ['engine', 'orm', 'socket'],
  lanes: ['C9'],
  world: { ...ormWorld({ 'task:read': permit() }, { 'task:read': allRows() }), lane: { orm: { models: [TASK] }, socket: { handlers: [{ event: 'tasks', orm: ACCESSIBLE }] } } },
  cases: [{ name: 'a socket handler without a principal source fails closed on .accessible()', steps: [laneCall('emit tasks', (ctx) => laneHandle(ctx, 'socket').emit('tasks'), UNATTENDED_DENIED), NOT_CALLED] }],
};

const send = (path: string) => (ctx: StepContext) => laneHandle(ctx, 'email').send({ to: 'x@example.com', attachments: [{ fs: 'uploads', path }] });

const emailPart: FixturePart = {
  name: 'email',
  facets: ['engine', 'host', 'fs', 'email'],
  lanes: ['C9'],
  note: 'Attachments of a guarded filesystem are read with fs:read as the sending principal (plan C9).',
  world: fsWorld(fsGrants([{ permission: 'fs:read', path: 'docs/a.txt' }])),
  cases: [
    { name: 'an attachment the sender may read is sent', steps: [as('alice', laneCall('send docs/a.txt', send('docs/a.txt'), 'resolves'))] },
    { name: 'an attachment the sender may not read is refused', steps: [as('alice', laneCall('send docs/b.txt', send('docs/b.txt'), { throws: 'AccessDenied' }))] },
    { name: 'without a principal the attachment is refused (unattended)', steps: [laneCall('send docs/a.txt', send('docs/a.txt'), UNATTENDED_DENIED)] },
  ],
};

export const B09Lanes = extension('B09', [ormPart, httpPart, queuePart, configurationPart, socketPart, emailPart]);
