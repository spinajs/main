import { SYSTEM } from '@spinajs/authz';
import type { AuthzCommand } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { cmp, combine, extension, permit, ref, staticModel } from './dsl.js';
import { exec } from './model-steps.js';
import type { Case, World } from './types.js';

const O1 = ref('org', 'o1');
const O2 = ref('org', 'o2');
const f1 = ref('file', 'f1');
const f2 = ref('file', 'f2');

const alice = userPrincipal('alice');

const ORG_SCHEMA = {
  scopeType: 'org',
  schema: { type: 'object', properties: { policies: { type: 'object', properties: { level: { type: 'string' } } } } },
  defaults: { policies: { level: 'bronze' } },
};

// m1 permits when the subject's tier equals scope.org.policies.level of the nearest org. The resolver
// says o1 is gold; the store says silver; o2 has no value anywhere but the schema default.
const world: World = {
  permissions: ['file:read', 'authz:scope.manage'],
  principals: { alice },
  scopes: [
    {
      nodes: [{ ref: O1, attributes: { policies: { level: 'gold' } } }, { ref: O2 }, { ref: f1, parent: O1 }, { ref: f2, parent: O2 }],
    },
  ],
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: { 'file:read': permit(cmp('tier', 'eq', { ref: 'scope.org.policies.level' })) } })],
  scopeAttributes: { schemas: [ORG_SCHEMA], values: [{ scope: O1, attributes: { policies: { level: 'silver' } } }] },
};

const tier = (resource: typeof f1, value: string, allowed: boolean) => ({ check: { as: 'alice', permission: 'file:read', resource, subject: { id: resource.id, tier: value } }, expect: { allowed } });
const set = (patch: Record<string, unknown>): AuthzCommand => ({ kind: 'scope.setAttributes', scope: O1, patch });

const cases: Case[] = [
  { name: 'a stored value wins over the scope resolver', steps: [tier(f1, 'silver', true), tier(f1, 'gold', false)] },
  { name: 'without a stored or resolved value the schema default applies', steps: [tier(f2, 'bronze', true), tier(f2, 'gold', false)] },
  {
    name: 'a change publishes scope:<t>:<id> and the next check reads the new value',
    steps: [tier(f1, 'silver', true), exec(SYSTEM, [set({ policies: { level: 'platinum' } })], 'ok'), { published: { tags: ['scope:org:o1'] } }, tier(f1, 'platinum', true), tier(f1, 'silver', false)],
  },
  {
    name: 'a null in the patch deletes the stored path, and the resolver value shows again',
    steps: [exec(SYSTEM, [set({ policies: { level: null } })], 'ok'), tier(f1, 'gold', true), tier(f1, 'silver', false)],
  },
  {
    name: 'scope.replaceAttributes replaces the stored object',
    steps: [exec(SYSTEM, [{ kind: 'scope.replaceAttributes', scope: O1, attributes: { policies: { level: 'iron' } } }], 'ok'), { published: { tags: ['scope:org:o1'] } }, tier(f1, 'iron', true)],
  },
];

export const B39Store = extension('B39', [
  {
    name: 'store',
    facets: ['engine', 'admin', 'scopeAttributes', 'bus'],
    lanes: ['L9'],
    note: 'ctx.attributes = schema defaults ⊕ resolver attributes ⊕ store rows, the store winning (design §5.6, D23); changes go through AuthzAdmin (L9 task 5).',
    world,
    cases,
  },
]);
