import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import { BEHAVIOUR_FIXTURES, fixtureDsl, runBehaviour, userPrincipal } from '@spinajs/authz-testing';
import type { World } from '@spinajs/authz-testing';

import { rbacHarness } from './model/harness.js';

runBehaviour(['B01.rbac', 'B02.rbac', 'B11.rbac', 'B12.rbac', 'B13.rbac', 'B14.rbac'], rbacHarness, { strict: true, timeoutMs: 30_000 });

// Lane-local parts, not in the kit catalogue.
const { ALGORITHMS, assignment, combine, extension, permit, ref, role, staticModel } = fixtureDsl;
const alice = userPrincipal('alice');
const f1 = ref('file', 'f1');

const combineWorld = (algorithm: (typeof ALGORITHMS)[number]): World => ({
  permissions: ['file:read', 'file:write'],
  principals: { alice },
  combine: combine(algorithm, 'rbac', 'm1'),
  models: [staticModel('m1', { votes: { 'file:read': permit() } })],
  // reader grants file:read, so RBAC is routed for it; alice holds only writer.
  rbac: { roles: [role('writer', ['file:write']), role('reader', ['file:read'])], assignments: [assignment('a1', alice, 'writer')] },
});

const LOCAL = [
  extension('B01', [
    {
      name: 'rbac-combine',
      facets: ['engine', 'rbac'],
      lanes: ['L1'],
      note: "RBAC's no_access is a non-permit reason, not a deny: another model's permit wins under every algorithm.",
      cases: ALGORITHMS.map((algorithm) => ({
        name: `${algorithm}: rbac no_access next to a permitting model`,
        world: combineWorld(algorithm),
        steps: [
          { check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: true } },
          { explain: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: true, trace: { votes: ['rbac', 'm1'] } } },
        ],
      })),
    },
  ]),
  extension('B12', [
    {
      name: 'rbac-extension',
      facets: ['engine', 'rbac'],
      lanes: ['L1'],
      note: "An RbacExtension's compile hook runs at boot through the contributor; its error fails the boot.",
      cases: [
        {
          name: 'a compile hook that throws fails the boot',
          world: { permissions: ['file:read'], principals: { alice }, combine: combine('deny-overrides', 'rbac'), rbac: { roles: [role('viewer', ['file:read'])] } },
          boot: { throws: 'AuthzConfigError', message: ['implies unknown role'] },
          steps: [],
        },
      ],
    },
  ]),
];

const throwingHarness = () =>
  rbacHarness({
    extensions: () => [
      {
        compile: () => {
          throw new AuthzConfigError("rbac role 'viewer' implies unknown role 'ghost'");
        },
      },
    ],
  });

runBehaviour(['B01.rbac-combine'], rbacHarness, { strict: true, timeoutMs: 30_000, fixtures: [...BEHAVIOUR_FIXTURES, ...LOCAL] });
runBehaviour(['B12.rbac-extension'], throwingHarness, { strict: true, timeoutMs: 30_000, fixtures: [...BEHAVIOUR_FIXTURES, ...LOCAL] });
