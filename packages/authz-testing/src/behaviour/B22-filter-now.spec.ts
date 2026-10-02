import type { ModelCapabilities } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { assignment, cmp, combine, fixture, permit, role, staticModel } from './dsl.js';
import type { Case, World } from './types.js';

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
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
  principals: { alice },
  adapters: [{ types: ['file'], rows }],
  combine: combine('deny-overrides', ...models.map((m) => m.name)),
  models,
});

const NOW_FILTER = { filterNow: { as: 'alice', permission: 'file:read', type: 'file' } } as const;

const core: Case[] = [
  { name: "sync: 'always' answers filterNow, as filter does", world: world([model('m1', 'always')]), steps: [{ ...NOW_FILTER, expect: { selects: ['r1'] } }] },
  { name: "sync: 'never' makes filterNow return undefined, never a guess", world: world([model('m1', 'never')]), steps: [{ ...NOW_FILTER, expect: 'undefined' }] },
  { name: 'one routed model that needs IO is enough for undefined', world: world([model('m1', 'always'), model('m2', 'never')]), steps: [{ ...NOW_FILTER, expect: 'undefined' }] },
  { name: "sync: 'after-preload' answers filterNow after preload", world: world([model('m1', 'after-preload')]), steps: [{ preload: 'alice' }, { ...NOW_FILTER, expect: { selects: ['r1'] } }] },
  { name: "sync: 'after-preload' before preload makes filterNow return undefined", world: world([model('m1', 'after-preload')]), steps: [{ ...NOW_FILTER, expect: 'undefined' }, { preload: 'alice' }, { ...NOW_FILTER, expect: { selects: ['r1'] } }] },
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
    lanes: [],
    note: "F3's Authorizer implements filterNow (task 4), but the plan names B22 only for L1 and L4; F3 should run B22.core.",
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
    ],
  },
  { name: 'orm', facets: ['orm'], lanes: ['L4'], note: 'Synchronous query scoping (afterQueryCreation) with filterNow; L4 proposes the cases.', cases: [] },
]);
