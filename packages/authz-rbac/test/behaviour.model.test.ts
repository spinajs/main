import 'mocha';

import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { BEHAVIOUR_FIXTURES, fixtureDsl, runBehaviour, userPrincipal } from '@spinajs/authz-testing';
import type { Case, World } from '@spinajs/authz-testing';

import { rbacHarness } from './model/harness.js';

runBehaviour(['B01.rbac', 'B02.rbac', 'B05.rbac', 'B06.rbac', 'B07.rbac', 'B11.rbac', 'B12.rbac', 'B13.rbac', 'B14.rbac', 'B15.rbac', 'B16.rbac', 'B17.rbac', 'B22.rbac'], rbacHarness, { strict: true, timeoutMs: 30_000 });

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

const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const O1 = ref('org', 'o1');
const O2 = ref('org', 'o2');

const globalWorld: World = {
  permissions: ['user:delete'],
  principals: { alice, bob, carol },
  scopes: [{ nodes: [{ ref: O1 }] }],
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [role('orgAdmin', ['user:delete']), role('oneUser', [{ permission: 'user:delete', on: [{ type: 'user', id: 'u1' }] }])],
    assignments: [assignment('a1', alice, 'orgAdmin', O1), assignment('b1', bob, 'orgAdmin'), assignment('c1', carol, 'oneUser')],
  },
};

// The target holds doc:read only below $global; caller holds doc:write only, root both at GLOBAL.
const grantsWorld = (targetRole: ReturnType<typeof role>, scope: ResourceRef = GLOBAL): World => {
  const people = { caller: userPrincipal('caller'), target: userPrincipal('target'), root: userPrincipal('root') };
  return {
    permissions: [
      { name: 'doc:read', types: ['doc'] },
      { name: 'doc:write', types: ['doc'] },
    ],
    principals: people,
    scopes: [{ nodes: [{ ref: O1 }] }],
    combine: combine('deny-overrides', 'rbac'),
    rbac: {
      roles: [targetRole, role('writerOnly', ['doc:write']), role('all', ['doc:read', 'doc:write'])],
      assignments: [assignment('c1', people.caller, 'writerOnly'), assignment('t1', people.target, targetRole.name, scope), assignment('r1', people.root, 'all')],
    },
  };
};

// The holder reads doc fields `holderFields` everywhere and writes docs; the target's doc:read comes from `targetRoles`.
const fieldsWorld = (holderFields: readonly string[], targetRoles: readonly (readonly [ReturnType<typeof role>, ResourceRef])[]): World => {
  const people = { holder: userPrincipal('holder'), target: userPrincipal('target') };
  return {
    permissions: [
      { name: 'doc:read', types: ['doc'], fields: true },
      { name: 'doc:write', types: ['doc'] },
    ],
    principals: people,
    scopes: [{ nodes: [{ ref: O1 }, { ref: O2 }] }],
    combine: combine('deny-overrides', 'rbac'),
    rbac: {
      roles: [role('holderReader', [{ permission: 'doc:read', fields: { read: [...holderFields] } }]), role('writerOnly', ['doc:write']), ...targetRoles.map(([r]) => r)],
      assignments: [assignment('h1', people.holder, 'holderReader'), assignment('h2', people.holder, 'writerOnly'), ...targetRoles.map(([r, scope], i) => assignment(`t${i}`, people.target, r.name, scope))],
    },
  };
};

const reads = (name: string, read?: readonly string[]) => role(name, [{ permission: 'doc:read', ...(read ? { fields: { read: [...read] } } : {}) }]);

const fieldsCase = (name: string, world: World, covers: boolean): Case => ({ name, world, steps: [{ covers: { holder: 'holder', target: 'target' }, expect: covers }] });

const grantCase = (name: string, world: World): Case => ({
  name,
  world,
  steps: [
    { check: { as: 'target', permission: 'doc:read', resource: GLOBAL }, expect: { allowed: false } },
    { covers: { holder: 'caller', target: 'target' }, expect: false },
    { covers: { holder: 'root', target: 'target' }, expect: true },
    { summary: { as: 'target' }, expect: { permissions: [{ name: 'doc:read', conditional: true }], absent: ['doc:write'] } },
  ],
});

const LOCAL = [
  extension('B13', [
    {
      name: 'rbac-global',
      facets: ['engine', 'rbac'],
      lanes: ['L1'],
      note: 'A check on $global is concrete: only GLOBAL assignments and grants without patterns hold there, never a scoped holder.',
      cases: [
        {
          name: 'a role held at org:o1, or a grant limited to one user, does not pass a GLOBAL check',
          world: globalWorld,
          steps: [
            { check: { as: 'alice', permission: 'user:delete', resource: GLOBAL }, expect: { allowed: false } },
            { check: { as: 'carol', permission: 'user:delete', resource: GLOBAL }, expect: { allowed: false } },
            { check: { as: 'bob', permission: 'user:delete', resource: GLOBAL }, expect: { allowed: true } },
          ],
        },
      ],
    },
  ]),
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
  extension('B26', [
    {
      name: 'rbac-probe',
      facets: ['engine', 'rbac'],
      lanes: ['L1'],
      note: 'AuthzService.covers must count a typed doc:read grant of the target (docs/plans/authz-v3-rfc/L1-3.md).',
      cases: [
        {
          name: 'a caller without doc:read does not cover a target whose doc:read comes from a typed grant',
          world: {
            permissions: [
              { name: 'doc:read', types: ['doc'] },
              { name: 'doc:write', types: ['doc'] },
            ],
            principals: { caller: userPrincipal('caller'), target: userPrincipal('target'), root: userPrincipal('root') },
            combine: combine('deny-overrides', 'rbac'),
            rbac: {
              roles: [role('typedReader', [{ permission: 'doc:read', on: [{ type: 'doc' }] }]), role('writerOnly', ['doc:write']), role('all', ['doc:read', 'doc:write'])],
              assignments: [assignment('c1', userPrincipal('caller'), 'writerOnly'), assignment('t1', userPrincipal('target'), 'typedReader'), assignment('r1', userPrincipal('root'), 'all')],
            },
          },
          steps: [
            { covers: { holder: 'caller', target: 'target' }, expect: false },
            { covers: { holder: 'root', target: 'target' }, expect: true },
          ],
        },
      ],
    },
    {
      name: 'rbac-grants',
      facets: ['engine', 'rbac'],
      lanes: ['L1', 'F3'],
      note: 'RFC L1-3: covers and summary read the RBAC summary, so doc:read held only below $global counts for the target. A check on $global denies it there; summary lists it conditional.',
      cases: [
        grantCase('a scoped assignment', grantsWorld(role('reader', ['doc:read']), O1)),
        grantCase('a bare-type assignment', grantsWorld(role('reader', ['doc:read']), ref('doc'))),
        grantCase('a type-pattern grant', grantsWorld(role('typedReader', [{ permission: 'doc:read', on: [{ type: 'doc' }] }]))),
        grantCase('a glob grant', grantsWorld(role('globReader', [{ permission: 'doc:read', on: [{ type: 'doc', id: 'd*' }] }]))),
        grantCase('an exact-id grant', grantsWorld(role('oneReader', [{ permission: 'doc:read', on: [{ type: 'doc', id: 'd1' }] }]))),
      ],
    },
    {
      name: 'rbac-fields',
      facets: ['engine', 'rbac'],
      lanes: ['L1', 'F3'],
      note: "E1 review I1: a summary entry lists the fields of every grant that permits some row; the vote's type-level fields (union over the unconditional grants, else the intersection) leave out what a scoped grant gives on its rows.",
      cases: [
        fieldsCase(
          'every field in o1 next to a global name-only grant: a name-only holder does not cover',
          fieldsWorld(
            ['name'],
            [
              [reads('names', ['name']), GLOBAL],
              [reads('reader'), O1],
            ],
          ),
          false,
        ),
        fieldsCase('control: the global name-only grant alone is covered', fieldsWorld(['name'], [[reads('names', ['name']), GLOBAL]]), true),
        fieldsCase(
          'field a in o1 and b in o2: a holder reading x does not cover',
          fieldsWorld(
            ['x'],
            [
              [reads('aReader', ['a']), O1],
              [reads('bReader', ['b']), O2],
            ],
          ),
          false,
        ),
        fieldsCase(
          'control: a holder reading a, b and x covers',
          fieldsWorld(
            ['a', 'b', 'x'],
            [
              [reads('aReader', ['a']), O1],
              [reads('bReader', ['b']), O2],
            ],
          ),
          true,
        ),
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

runBehaviour(['B13.rbac-global'], rbacHarness, { strict: true, timeoutMs: 30_000, fixtures: [...BEHAVIOUR_FIXTURES, ...LOCAL] });
runBehaviour(['B01.rbac-combine'], rbacHarness, { strict: true, timeoutMs: 30_000, fixtures: [...BEHAVIOUR_FIXTURES, ...LOCAL] });
runBehaviour(['B12.rbac-extension'], throwingHarness, { strict: true, timeoutMs: 30_000, fixtures: [...BEHAVIOUR_FIXTURES, ...LOCAL] });
runBehaviour(['B26.rbac-probe', 'B26.rbac-grants', 'B26.rbac-fields'], rbacHarness, { strict: true, timeoutMs: 30_000, fixtures: [...BEHAVIOUR_FIXTURES, ...LOCAL] });
