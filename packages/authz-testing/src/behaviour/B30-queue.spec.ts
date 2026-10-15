import { SYSTEM, UNATTENDED } from '@spinajs/authz';

import { userPrincipal, withCeiling } from '../principals.js';
import { combine, fixture, permit, ref, relation, staticModel } from './dsl.js';
import { as, emitted, handled, http } from './lane.js';
import type { Case, World } from './types.js';

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const narrowed = withCeiling(alice, { permissions: ['file:read'] });
const f1 = ref('file', 'f1');
const ALICE = { type: 'user', id: 'alice' };

const CHECKS = [
  { permission: 'file:read', resource: f1 },
  { permission: 'file:write', resource: f1 },
] as const;

/** m1 permits alice everything; nobody else anything. */
const world: World = {
  permissions: ['file:read', 'file:write'],
  principals: { alice, narrowed },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: (req) => (req.principal.id === 'alice' ? permit() : {}) })],
  lane: {
    queue: {
      jobs: [
        { name: 'export', runAs: 'initiator', checks: CHECKS },
        { name: 'cleanup', runAs: 'system', checks: CHECKS },
        { name: 'plain', checks: CHECKS },
      ],
    },
  },
};

const queueCases: Case[] = [
  { name: 'an emitted message carries the initiator', steps: [as('alice', emitted('m', 'export', ALICE))] },
  { name: "the Initiator carries the initiator's ceiling", steps: [as('narrowed', emitted('m', 'export', { ...ALICE, ceiling: { permissions: ['file:read'] } }))] },
  { name: 'a message emitted by SYSTEM carries the system initiator', steps: [{ runAs: { as: SYSTEM, reason: 'behaviour fixture' }, steps: [emitted('m', 'export', { type: 'system', id: 'system' })] }] },
  { name: 'a message emitted without a principal carries no Initiator', steps: [emitted('m', 'export', null)] },
  {
    name: "runAs: 'initiator' runs the handler as the initiator",
    steps: [as('alice', emitted('m', 'export')), handled('m', { principal: ALICE, decisions: [{ allowed: true }, { allowed: true }] })],
  },
  {
    name: "runAs: 'initiator' restores the initiator's ceiling",
    steps: [as('narrowed', emitted('m', 'export')), handled('m', { principal: ALICE, ceiling: { permissions: ['file:read'] }, decisions: [{ allowed: true }, { allowed: false, reason: 'ceiling' }] })],
  },
  { name: "runAs: 'initiator' of a message SYSTEM emitted runs as SYSTEM", steps: [{ runAs: { as: SYSTEM, reason: 'behaviour fixture' }, steps: [emitted('m', 'export')] }, handled('m', { principal: SYSTEM, decisions: [{ allowed: true }, { allowed: true }] })] },
  {
    name: "runAs: 'system' runs the handler as SYSTEM",
    steps: [
      as('alice', emitted('m', 'cleanup')),
      handled('m', {
        principal: SYSTEM,
        decisions: [
          { allowed: true, residual: 'TRUE' },
          { allowed: true, residual: 'TRUE' },
        ],
      }),
    ],
  },
  {
    name: 'without runAs the handler runs unattended',
    steps: [
      as('alice', emitted('m', 'plain')),
      handled('m', {
        principal: UNATTENDED,
        decisions: [
          { allowed: false, reason: 'unattended' },
          { allowed: false, reason: 'unattended' },
        ],
      }),
    ],
  },
];

// job:read on the owner relation (the initiator columns) for users, unconditional for carol (design 2026-10-14 §6.3).
const statusWorld: World = {
  permissions: [],
  principals: { alice, bob, carol },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: (req) => (req.permission !== 'job:read' ? {} : req.principal.id === 'carol' ? permit() : permit(relation('owner'))) })],
  lane: { queue: { records: [{ id: 'j1', job: 'export', initiator: ALICE, status: 'success' }] } },
};

// The full row, so that the not-found fallback (200 { jobId, status: 'queued' }) cannot pass.
const JOB = { jobId: 'j1', status: 'success' };

const STATUS = (as: string) => ({ method: 'GET', path: '/jobs/v1/j1/status', as } as const);

export const B30 = fixture('B30', [
  { name: 'queue', facets: ['engine', 'host', 'queue'], lanes: ['L6'], world, cases: queueCases },
  {
    name: 'status',
    facets: ['engine', 'http', 'queue'],
    lanes: ['C8'],
    note: "queue-http-progress GET jobs/v1/:jobId/status with @Access('job:read', { resource: fromParam('jobId', 'job') }); the plan (C8) allows 403 or 404 for another user's job.",
    world: statusWorld,
    cases: [
      { name: 'the initiator reads the job status', steps: [http(STATUS('alice'), { status: 200, body: JOB })] },
      { name: 'another user cannot read the job status', steps: [http(STATUS('bob'), { status: [403, 404] })] },
      { name: 'a holder of an unconditional job:read reads the job status', steps: [http(STATUS('carol'), { status: 200, body: JOB })] },
    ],
  },
]);
