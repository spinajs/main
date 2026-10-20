import { GLOBAL } from '@spinajs/authz';
import type { RuleDef } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { assignment, combine, extension, ref, role } from './dsl.js';
import type { Case, ReasonExpectation, World } from './types.js';

const P1 = ref('project', 'p1');
const f1 = ref('file', 'f1');

const viewer = userPrincipal('viewer');
const editor = userPrincipal('editor');

const threshold = (id: string, minRole: string, reason: NonNullable<RuleDef['reason']>): Omit<RuleDef, 'source'> => ({ id, kind: 'threshold', scope: GLOBAL, permissions: ['file:edit', 'code:view'], minRole, reason });

const world = (rules: readonly Omit<RuleDef, 'source'>[]): World => ({
  permissions: ['file:edit', 'code:view'].map((name) => ({ name, types: ['project', 'file'] })),
  principals: { viewer, editor },
  scopes: [{ nodes: [{ ref: f1, parent: P1 }] }],
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    ladders: [{ name: 'project', roles: ['viewer', 'editor', 'maintainer'] }],
    roles: [role('viewer', [], { ladder: 'project' }), role('editor', ['file:edit', { permission: 'code:view', requiresTag: 'code' }], { ladder: 'project' }), role('maintainer', [], { ladder: 'project' })],
    rules: rules.map((r) => ({ ...r, source: 'test' })),
    assignments: [assignment('v1', viewer, 'viewer', P1), assignment('e1', editor, 'editor', P1)],
  },
});

const reported = (name: string, rules: readonly Omit<RuleDef, 'source'>[], as: string, permission: string, reason: ReasonExpectation): Case => ({
  name,
  world: world(rules),
  steps: [{ check: { as, permission, resource: f1 }, expect: { allowed: false, reason } }],
});

/** The case and the same with the rules reversed. */
const bothOrders = (name: string, rules: readonly Omit<RuleDef, 'source'>[], as: string, permission: string, reason: ReasonExpectation): Case[] => [reported(name, rules, as, permission, reason), reported(`${name} (rules reversed)`, [...rules].reverse(), as, permission, reason)];

const BRANCH_A = { code: 'branch_protected', pattern: 'a*', priority: 700, sortKey: 'a*' };
const BRANCH_B = { code: 'branch_protected', pattern: 'b*', priority: 700, sortKey: 'b*' };

const cases: Case[] = [...bothOrders('two failing thresholds at one priority: the lowest sortKey is reported', [threshold('t-b', 'maintainer', BRANCH_B), threshold('t-a', 'maintainer', BRANCH_A)], 'editor', 'file:edit', { code: 'branch_protected', pattern: 'a*' }), ...bothOrders('two failing thresholds: the lowest priority is reported', [threshold('t-1', 'maintainer', { code: 'slow', priority: 650 }), threshold('t-2', 'maintainer', { code: 'fast', priority: 610 })], 'editor', 'file:edit', 'fast'), ...bothOrders('a threshold at priority 300 beats role_too_low (410)', [threshold('t-1', 'maintainer', { code: 'link_invalid', priority: 300 })], 'viewer', 'file:edit', 'link_invalid'), ...bothOrders('role_too_low (410) beats a threshold at its default priority (600)', [threshold('t-1', 'maintainer', { code: 'policy' })], 'viewer', 'file:edit', { code: 'role_too_low', ladder: 'project', role: 'viewer', needed: 'editor' }), ...bothOrders('tag_missing (420) beats a threshold at its default priority (600)', [threshold('t-1', 'maintainer', { code: 'policy' })], 'editor', 'code:view', { code: 'tag_missing', tag: 'code' })];

export const B36Rbac = extension('B36', [
  {
    name: 'rbac',
    facets: ['engine', 'rbac', 'ladders', 'rules'],
    lanes: ['L1b'],
    note: 'Failing RBAC steps and rules each add a deny entry with its priority (design §6.1.2 steps 5-8, D17): role_too_low 410, tag_missing 420, threshold rules 600 unless their reason says otherwise. The thresholds name no ladder, so the deciding rank is the rank on the ladder of the permission.',
    cases,
  },
]);
