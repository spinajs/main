import type { ModelCapabilities } from '@spinajs/authz';

import { agentPrincipal, sealPrincipal, userPrincipal } from '../principals.js';
import { assignment, cmp, combine, fixture, permit, ref, role, staticModel } from './dsl.js';
import type { Case, World } from './types.js';

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
// An inherit agent of alice, and the same agent without a delegate.
const bot = agentPrincipal('bot', alice);
const botAlone = sealPrincipal({ ...bot, onBehalfOf: undefined, delegation: undefined });
const rows = {
  file: [
    { id: 'r1', status: 'open' },
    { id: 'r2', status: 'closed' },
  ],
};
const OPEN = permit(cmp('status', 'eq', 'open'));

const model = (name: string, sync: ModelCapabilities['sync']) => staticModel(name, { capabilities: { sync }, votes: { 'file:read': OPEN } });

const world = (models: ReturnType<typeof model>[]): World => ({
  permissions: ['file:read'],
  principals: { alice, bob, bot, botAlone },
  adapters: [{ types: ['file'], rows }],
  combine: combine('deny-overrides', ...models.map((m) => m.name)),
  models,
});

const nowFilter = (as: string) => ({ filterNow: { as, permission: 'file:read', type: 'file' } } as const);
const NOW_FILTER = nowFilter('alice');

const core: Case[] = [
  { name: "sync: 'always' answers filterNow, as filter does", world: world([model('m1', 'always')]), steps: [{ ...NOW_FILTER, expect: { selects: ['r1'] } }] },
  { name: "sync: 'never' makes filterNow return undefined, never a guess", world: world([model('m1', 'never')]), steps: [{ ...NOW_FILTER, expect: 'undefined' }] },
  { name: 'one routed model that needs IO is enough for undefined', world: world([model('m1', 'always'), model('m2', 'never')]), steps: [{ ...NOW_FILTER, expect: 'undefined' }] },
  { name: "sync: 'after-preload' answers filterNow after preload", world: world([model('m1', 'after-preload')]), steps: [{ preload: 'alice' }, { ...NOW_FILTER, expect: { selects: ['r1'] } }] },
  { name: "sync: 'after-preload' before preload makes filterNow return undefined", world: world([model('m1', 'after-preload')]), steps: [{ ...NOW_FILTER, expect: 'undefined' }, { preload: 'alice' }, { ...NOW_FILTER, expect: { selects: ['r1'] } }] },
  {
    name: "sync: 'after-preload' preloaded for one principal makes filterNow for another return undefined",
    world: world([model('m1', 'after-preload')]),
    steps: [{ preload: 'alice' }, { ...nowFilter('bob'), expect: 'undefined' }, { ...NOW_FILTER, expect: { selects: ['r1'] } }],
  },
  {
    name: "sync: 'after-preload' under inherit is gated on the delegate the models run with, not on the agent",
    world: world([model('m1', 'after-preload')]),
    steps: [{ preload: 'botAlone' }, { ...nowFilter('bot'), expect: 'undefined' }, { preload: 'alice' }, { ...nowFilter('bot'), expect: { selects: ['r1'] } }],
  },
  {
    name: "sync: 'after-preload' does not gate async checks without preload",
    world: world([model('m1', 'after-preload')]),
    steps: [
      { check: { as: 'alice', permission: 'file:read' }, expect: { allowed: true, residual: { selects: ['r1'] } } },
      { check: { as: 'alice', permission: 'file:read', resource: ref('file', 'r2'), subject: 'row' }, expect: { allowed: false, reason: 'residual_false' } },
      { filter: { as: 'alice', permission: 'file:read', type: 'file' }, expect: { selects: ['r1'] } },
      { ...NOW_FILTER, expect: 'undefined' },
    ],
  },
];

const rbacWorld: World = {
  permissions: ['file:read'],
  principals: { alice, bob },
  adapters: [{ types: ['file'], rows }],
  combine: combine('deny-overrides', 'rbac'),
  rbac: { roles: [role('viewer', ['file:read'])], assignments: [assignment('a1', alice, 'viewer')] },
};

export const B22 = fixture('B22', [
  {
    name: 'core',
    facets: ['engine'],
    lanes: ['F3'],
    note: "F3's Authorizer implements filterNow (task 4); F3's engine runner and F4's host runner run this part.",
    cases: core,
  },
  {
    name: 'rbac',
    facets: ['engine', 'rbac'],
    lanes: ['L1'],
    world: rbacWorld,
    cases: [
      {
        name: "the RBAC model (sync: 'after-preload') answers filterNow after preload",
        steps: [{ preload: 'alice' }, { ...NOW_FILTER, expect: { selects: ['r1', 'r2'] } }, { preload: 'bob' }, { filterNow: { as: 'bob', permission: 'file:read', type: 'file' }, expect: { selects: [] } }],
      },
      { name: 'filterNow for a principal other than the preloaded one returns undefined', steps: [{ preload: 'alice' }, { ...nowFilter('bob'), expect: 'undefined' }] },
      { name: 'a check without preload is not gated', steps: [{ check: { as: 'alice', permission: 'file:read' }, expect: { allowed: true, residual: 'TRUE' } }, { ...NOW_FILTER, expect: 'undefined' }] },
    ],
  },
  { name: 'orm', facets: ['orm'], lanes: ['L4'], note: 'Synchronous query scoping (afterQueryCreation) with filterNow; L4 proposes the cases.', cases: [] },
]);
