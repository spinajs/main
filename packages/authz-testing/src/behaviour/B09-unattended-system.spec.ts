import { SYSTEM, UNATTENDED } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { combine, fixture, permit, ref, staticModel } from './dsl.js';
import type { FixturePart, World } from './types.js';

const alice = userPrincipal('alice');
const f1 = ref('file', 'f1');

const world: World = {
  permissions: ['file:read'],
  principals: { alice },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: { '*': permit() } })],
};

const NOT_CALLED = { calls: { model: 'm1', count: 0 } } as const;

const later = (name: string, facets: FixturePart['facets'], lanes: string[], note: string): FixturePart => ({ name, facets, lanes, note, cases: [] });

export const B09 = fixture('B09', [
  {
    name: 'core',
    facets: ['engine', 'audit'],
    lanes: ['F3'],
    world,
    cases: [
      { name: 'UNATTENDED is denied with reason unattended, without consulting a model', steps: [{ check: { as: UNATTENDED, permission: 'file:read', resource: f1 }, expect: { allowed: false, reason: 'unattended', residual: 'FALSE' } }, NOT_CALLED] },
      { name: 'UNATTENDED gets a FALSE filter', steps: [{ filter: { as: UNATTENDED, permission: 'file:read', type: 'file' }, expect: 'FALSE' }, NOT_CALLED] },
      { name: 'SYSTEM is allowed without consulting a model', steps: [{ check: { as: SYSTEM, permission: 'file:read', resource: f1 }, expect: { allowed: true, residual: 'TRUE' } }, NOT_CALLED] },
      { name: 'SYSTEM gets a TRUE filter', steps: [{ filter: { as: SYSTEM, permission: 'file:read', type: 'file' }, expect: 'TRUE' }, NOT_CALLED] },
      { name: 'a SYSTEM check is audited', steps: [{ check: { as: SYSTEM, permission: 'file:read', resource: f1 }, expect: { allowed: true } }, { audit: { kind: 'system', count: 1 } }] },
    ],
  },
  {
    name: 'runAs',
    facets: ['engine', 'host', 'audit'],
    lanes: ['F4'],
    world,
    cases: [
      { name: 'without a principal in the ALS, current() is UNATTENDED', steps: [{ current: UNATTENDED }] },
      {
        name: 'runAs(SYSTEM, reason) makes SYSTEM current, consults no model and is audited with its reason',
        steps: [{ runAs: { as: SYSTEM, reason: 'cli' }, steps: [{ current: SYSTEM }, { check: { as: '$current', permission: 'file:read', resource: f1 }, expect: { allowed: true, residual: 'TRUE' } }] }, NOT_CALLED, { audit: { kind: 'runAs', reason: 'cli' } }, { current: UNATTENDED }],
      },
      {
        name: 'runAs(user) makes the user current for its callback only',
        steps: [{ runAs: { as: 'alice', reason: 'job' }, steps: [{ current: 'alice' }, { check: { as: '$current', permission: 'file:read', resource: f1 }, expect: { allowed: true } }] }, { current: UNATTENDED }],
      },
    ],
  },
  later('orm', ['orm'], ['L4'], 'A query on an @AccessResource model without a principal throws; under runAs(SYSTEM) it runs unscoped. L4 proposes the cases with its fixture models.'),
  later('http', ['http'], ['L5'], '@Unscoped(reason) routes run as SYSTEM and are audited (kind unscoped). L5 proposes the cases.'),
  later('queue', ['queue'], ['L6'], "@Job({ runAs: 'system' }) handlers run as SYSTEM, audited; the default is unattended. L6 proposes the cases."),
  later('configuration', ['configuration'], ['C6'], "configuration-db-source polling runs under runAs(SYSTEM, 'config-poll'). C6 proposes the case."),
  later('socket', ['socket'], ['C9'], 'Socket handlers without a principal source fail closed on scoped models. C9 proposes the case.'),
  later('email', ['email'], ['C9'], 'Attachments are read under the sending principal. C9 proposes the case.'),
]);
