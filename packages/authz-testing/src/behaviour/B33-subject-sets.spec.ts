import { groupPrincipal, servicePrincipal, userPrincipal } from '../principals.js';
import { assignment, combine, fixture, ref, role } from './dsl.js';
import type { Case, DecisionExpectation, World } from './types.js';

const O1 = ref('org', 'o1');
const O2 = ref('org', 'o2');
const P1 = ref('project', 'p1');
const f1 = ref('file', 'f1');
const G1 = ref('group', 'g1');
const G2 = ref('group', 'g2');

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const dave = userPrincipal('dave');
const erin = userPrincipal('erin');
const gina = userPrincipal('gina');
const svc = servicePrincipal('svc', { companions: [alice] });
const g1 = groupPrincipal('g1');

const world: World = {
  permissions: ['file:read', 'file:edit', 'file:delete'].map((name) => ({ name, types: ['project', 'file'] })),
  principals: { alice, bob, carol, dave, erin, gina, svc, g1 },
  scopes: [
    {
      nodes: [{ ref: P1, parent: O1 }, { ref: f1, parent: P1 }, { ref: O2 }, { ref: G1 }, { ref: G2 }],
    },
  ],
  combine: combine('deny-overrides', 'rbac'),
  config: { rbac: { groupPrincipal: { role: 'group.member', scopeType: 'group' } } },
  rbac: {
    ladders: [{ name: 'org', roles: ['org.guest', 'org.member', 'org.admin'] }],
    roles: [role('org.guest', [], { ladder: 'org' }), role('org.member', [], { ladder: 'org', subjectSet: true }), role('org.admin', [], { ladder: 'org' }), role('group.member', [], { subjectSet: true }), role('viewer', ['file:read']), role('editor', ['file:edit']), role('deleter', ['file:delete'])],
    assignments: [{ id: 's1', subject: { set: { role: 'org.member', scope: O1 } }, role: 'viewer', scope: P1, source: 'test' }, { id: 's2', subject: { set: { role: 'group.member', scope: G1 } }, role: 'editor', scope: P1, source: 'test' }, { id: 'n1', subject: { set: { role: 'group.member', scope: G1 } }, role: 'group.member', scope: G2, source: 'test' }, { id: 's3', subject: { set: { role: 'group.member', scope: G2 } }, role: 'deleter', scope: P1, source: 'test' }, assignment('m1', alice, 'org.member', O1), assignment('m2', bob, 'org.admin', O1), assignment('m3', carol, 'org.guest', O1), assignment('m4', dave, 'org.member', O2), assignment('m5', erin, 'group.member', G1), assignment('m6', gina, 'group.member', G2)],
  },
};

const ALLOWED: DecisionExpectation = { allowed: true };
const DENIED: DecisionExpectation = { allowed: false };
const on = (as: string, permission: string, expect: DecisionExpectation) => ({ check: { as, permission, resource: f1 }, expect });

const cases: Case[] = [
  { name: 'an assignment to { set: R @ S } applies to every holder of R at S', steps: [on('alice', 'file:read', ALLOWED)] },
  { name: "it applies to a holder of a higher role of R's ladder at S", steps: [on('bob', 'file:read', ALLOWED)] },
  { name: "it does not apply to a holder of a lower role of R's ladder", steps: [on('carol', 'file:read', DENIED)] },
  { name: 'it does not apply to a holder of R at another scope', steps: [on('dave', 'file:read', DENIED)] },
  { name: 'a group principal speaks for its member set', steps: [on('g1', 'file:edit', ALLOWED), on('g1', 'file:read', DENIED)] },
  { name: "a member of a group gets the group's grants", steps: [on('erin', 'file:edit', ALLOWED)] },
  { name: "a companion's subjects, sets included, join the principal's", steps: [on('svc', 'file:read', ALLOWED), on('svc', 'file:edit', DENIED)] },
  { name: 'sets are one level deep: a set holding a set role makes no members of that set', steps: [on('erin', 'file:delete', DENIED), on('gina', 'file:delete', ALLOWED)] },
];

export const B33 = fixture('B33', [
  {
    name: 'sets',
    facets: ['engine', 'rbac', 'ladders'],
    lanes: ['L1b'],
    note: "org.member and group.member are subjectSet roles; authz.rbac.groupPrincipal = { role: 'group.member', scopeType: 'group' } (design §8.2). Assignment n1 makes the set g1 hold group.member at g2, which one level deep must not extend to g1's members. The design says sets are never nested (§5.8, §6.1.1) but not whether such a row is refused; this part reads it as ignored, so a lane that refuses the row at load fails at setup and should propose the other reading by RFC.",
    world,
    cases,
  },
]);
