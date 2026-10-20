import { GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AuthzCommand, PrincipalRef } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { assignment, combine, extension, ref, role } from './dsl.js';
import { eventSince, exec, mark, savedId, since } from './model-steps.js';
import type { Case, World } from './types.js';

const O1 = ref('org', 'o1');
const P1 = ref('project', 'p1');

const alice = userPrincipal('alice');
const root = userPrincipal('root');

const MANAGE = ['authz:assignments.manage', 'authz:links.manage', 'authz:rules.manage'];

const world: World = {
  permissions: ['file:read', 'file:edit', ...MANAGE].map((name) => ({ name, types: ['org', 'project', 'file'] })),
  principals: { alice, root },
  scopes: [{ nodes: [{ ref: P1, parent: O1 }] }],
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    ladders: [{ name: 'project', roles: ['viewer', 'editor'] }],
    roles: [role('viewer', ['file:read'], { ladder: 'project' }), role('editor', ['file:edit'], { ladder: 'project' }), role('superuser', [...MANAGE, 'file:read', 'file:edit'])],
    assignments: [assignment('r1', root, 'superuser', GLOBAL), assignment('r2', root, 'editor', GLOBAL)],
  },
};

const ALICE: PrincipalRef = { type: 'user', id: 'alice' };
const GRANT: AuthzCommand = { kind: 'assignment.grant', subject: ALICE, role: 'viewer', scope: P1 };

const cases: Case[] = [
  {
    name: 'assignment.grant emits RoleAssigned with actor and scope, after an AuthzChange',
    steps: [mark('grant'), exec('root', [GRANT], 'ok'), since('grant', { published: 1 }), eventSince('grant', { type: 'RoleAssigned', actor: 'root', data: { subject: ALICE, role: 'viewer', scope: P1 } })],
  },
  {
    name: 'assignment.revoke emits RoleRevoked with actor and scope, after an AuthzChange',
    steps: [exec('root', [GRANT], 'ok', { save: 'grant' }), mark('revoke'), exec('root', (s) => [{ kind: 'assignment.revoke', id: savedId(s, 'grant') }], 'ok'), since('revoke', { published: 1 }), eventSince('revoke', { type: 'RoleRevoked', actor: 'root', data: { subject: ALICE, role: 'viewer', scope: P1 } })],
  },
  {
    name: 'link and rule writes publish an AuthzChange too',
    steps: [mark('link'), exec('root', [{ kind: 'link.create', scope: P1, role: 'viewer' }], 'ok'), since('link', { published: 1 }), mark('rule'), exec('root', [{ kind: 'rule.put', rule: { id: 'thr', kind: 'threshold', scope: P1, permissions: ['file:edit'], minRole: 'editor' } }], 'ok'), since('rule', { published: 1 })],
  },
];

const policyWorld: World = {
  permissions: ['file:read', 'authz:policies.manage'].map((name) => ({ name, types: ['org', 'project', 'file'] })),
  principals: { alice },
  scopes: [{ nodes: [{ ref: P1, parent: O1 }] }],
  combine: combine('deny-overrides', 'abac'),
  abac: { policies: [] },
};

const policyCases: Case[] = [
  {
    name: 'a policy write publishes an AuthzChange',
    steps: [mark('put'), exec(SYSTEM, [{ kind: 'policy.put', policy: { id: 'p1', effect: 'permit', permissions: ['file:read'], scope: O1 } }], 'ok'), since('put', { published: 1 }), mark('delete'), exec(SYSTEM, [{ kind: 'policy.delete', id: 'p1' }], 'ok'), since('delete', { published: 1 })],
  },
];

export const B27Events = extension('B27', [
  {
    name: 'events',
    facets: ['engine', 'admin', 'rbac', 'ladders', 'bus'],
    lanes: ['L9', 'C1', 'C4'],
    note: 'AuthzAdmin writes publish an AuthzChange after commit and emit RoleAssigned/RoleRevoked { subject, role, scope, actor, expiresAt } (design §6.1.5) as AuthzEvents (actor on the event, the rest in data); lane handle adminEvents. root manages everything and holds editor at GLOBAL, so the guard lets it grant, link and require up to editor. data.subject is assumed to be a PrincipalRef and data.scope a ResourceRef (the design leaves their encoding open). Policy writes are B27.policyEvents; which tags a write publishes is left open (D-F5-4).',
    world,
    cases,
  },
  {
    name: 'policyEvents',
    facets: ['engine', 'admin', 'abac', 'bus'],
    lanes: ['L9', 'L3'],
    note: 'policy.put and policy.delete through AuthzAdmin with the ABAC policy handler; SYSTEM passes the permission check and the guard (D-F5-7).',
    world: policyWorld,
    cases: policyCases,
  },
]);
