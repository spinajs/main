import { GLOBAL, SYSTEM } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { assignment, combine, fixture, permit, ref, role, staticModel } from './dsl.js';
import type { Throws, World } from './types.js';

const alice = userPrincipal('alice');
const f1 = ref('file', 'f1');
const UNKNOWN: Throws = { throws: 'UnknownPermission' };
const CONFIG: Throws = { throws: 'AuthzConfigError' };

const coreWorld: World = {
  permissions: [{ name: 'file:read', types: ['file'] }],
  principals: { alice },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: { '*': permit() } })],
};

const boot = (message: string[]) => ({ throws: 'AuthzConfigError', message });

export const B02 = fixture('B02', [
  {
    name: 'core',
    facets: ['engine'],
    lanes: ['F3'],
    note: 'F3 builds the check; G1 item 3 lists B03-B09 only, so F3 should add B02.core to its runs.',
    world: coreWorld,
    cases: [
      { name: 'check() of an unregistered permission throws UnknownPermission', steps: [{ check: { as: 'alice', permission: 'ghost:read', resource: f1 }, expect: UNKNOWN }] },
      { name: 'can() of an unregistered permission throws, never false', steps: [{ can: { as: 'alice', permission: 'ghost:read', resource: f1 }, expect: UNKNOWN }] },
      { name: 'explain() of an unregistered permission throws', steps: [{ explain: { as: 'alice', permission: 'ghost:read', resource: f1 }, expect: UNKNOWN }] },
      { name: 'filter() of an unregistered permission throws', steps: [{ filter: { as: 'alice', permission: 'ghost:read', type: 'file' }, expect: UNKNOWN }] },
      { name: 'checkMany() with one unregistered permission throws', steps: [{ checkMany: { as: 'alice', permissions: ['file:read', 'ghost:read'], resource: f1 }, expect: UNKNOWN }] },
      { name: 'the permission is resolved before SYSTEM is let through', steps: [{ check: { as: SYSTEM, permission: 'ghost:read', resource: f1 }, expect: UNKNOWN }] },
      { name: 'a permission checked on a type outside PermissionDef.types throws AuthzConfigError', steps: [{ check: { as: 'alice', permission: 'file:read', resource: ref('dir', 'd1') }, expect: CONFIG }] },
      { name: 'GLOBAL is a valid resource for every permission (design §10.1)', steps: [{ check: { as: 'alice', permission: 'file:read', resource: GLOBAL }, expect: { allowed: true } }] },
      { name: 'control: a registered permission on its type is checked', steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: true } }] },
    ],
  },
  {
    name: 'rbac',
    facets: ['engine', 'rbac'],
    lanes: ['L1'],
    cases: [
      {
        name: 'a grant naming an unregistered permission fails at boot',
        world: {
          permissions: ['file:read'],
          principals: { alice },
          combine: combine('deny-overrides', 'rbac'),
          rbac: { roles: [role('editor', ['file:read', 'ghost:read'])], assignments: [assignment('a1', alice, 'editor')] },
        },
        boot: boot(['ghost:read']),
        steps: [],
      },
    ],
  },
  {
    name: 'abac',
    facets: ['engine', 'abac'],
    lanes: ['L3'],
    note: 'A policy names a permission (L3 tasks 4 and 6).',
    cases: [
      {
        name: 'a policy naming an unregistered permission fails at boot',
        world: {
          permissions: ['file:read'],
          principals: { alice },
          combine: combine('deny-overrides', 'abac'),
          abac: { policies: [{ id: 'p1', effect: 'permit', permissions: ['ghost:read'], source: 'test' }] },
        },
        boot: boot(['ghost:read']),
        steps: [],
      },
    ],
  },
  {
    name: 'rules',
    facets: ['engine', 'rbac', 'ladders', 'rules'],
    lanes: ['L1b'],
    note: 'A rule names a permission (L1b task 6).',
    cases: [
      {
        name: 'a rule naming an unregistered permission fails at boot',
        world: {
          permissions: ['file:read'],
          principals: { alice },
          combine: combine('deny-overrides', 'rbac'),
          rbac: {
            ladders: [{ name: 'project', roles: ['viewer', 'editor'] }],
            roles: [role('viewer', ['file:read'], { ladder: 'project' }), role('editor', [], { ladder: 'project' })],
            rules: [{ id: 'r1', kind: 'threshold', scope: GLOBAL, permissions: ['ghost:read'], minRole: 'editor', source: 'test' }],
          },
        },
        boot: boot(['ghost:read']),
        steps: [],
      },
    ],
  },
  {
    name: 'http',
    facets: ['http'],
    lanes: ['L5'],
    note: 'An @Access naming an unregistered permission fails at boot; L5 adds the case with its own route setup (L5 task 12).',
    cases: [],
  },
  {
    name: 'adapter',
    facets: ['fs'],
    lanes: ['L7'],
    note: "An adapter's operations() naming an unregistered permission fails at boot. Only the fs adapter declares an operation table (design §13), so L7 proposes the case; no kit fake has operations().",
    cases: [],
  },
]);
