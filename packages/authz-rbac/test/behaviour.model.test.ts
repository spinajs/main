import 'mocha';
import assert from 'node:assert/strict';

import { AuthzConfigError, CORE_FILTER_OPS, GLOBAL } from '@spinajs/authz';
import { BEHAVIOUR_FIXTURES, fixtureDsl, runBehaviour, userPrincipal } from '@spinajs/authz-testing';
import type { World } from '@spinajs/authz-testing';

import { RBAC_ASSIGNMENT_OP, rbacAssignmentExtension } from '../src/index.js';
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

// B06.rbac's world with an adapter that compiles native:rbac.assignment, so the model may emit it.
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const P1 = ref('project', 'p1');
const P2 = ref('project', 'p2');
const O1 = ref('org', 'o1');
const nativeWorld: World = {
  permissions: ['file:read'],
  principals: { alice, bob, carol },
  adapters: [
    {
      types: ['file'],
      rows: {
        file: [
          { id: 'f1', owner: 'alice' },
          { id: 'f2', owner: 'bob' },
          { id: 'f3', owner: 'carol' },
          { id: 'f4', owner: 'carol' },
        ],
      },
      parents: [[ref('file', 'f1'), P1] as const, [ref('file', 'f2'), P2] as const, [ref('file', 'f3'), P2] as const, [ref('file', 'f4'), O1] as const],
      relations: [{ type: 'file', relation: 'owner', column: 'owner' }],
      compiles: [...CORE_FILTER_OPS, RBAC_ASSIGNMENT_OP],
    },
  ],
  scopes: [{ nodes: [{ ref: P1, parent: O1 }, { ref: P2, parent: O1 }, { ref: O1 }] }],
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [role('viewer', ['file:read']), role('owner', [{ permission: 'file:read', relation: 'owner' }])],
    assignments: [assignment('a1', alice, 'viewer', P1), assignment('a2', bob, 'owner'), assignment('a3', carol, 'owner', P2), assignment('a4', carol, 'viewer', ref('file', 'f4'))],
  },
};

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
  extension('B06', [
    {
      name: 'rbac-native',
      facets: ['engine', 'rbac', 'list'],
      lanes: ['L1'],
      note: 'B06.rbac with rbacAssignmentExtension: scoped assignments become native:rbac.assignment, which the harness list evaluates with the model NativeFilter.',
      cases: [
        {
          name: 'scoped assignments as native:rbac.assignment: check ⇔ filter',
          world: nativeWorld,
          steps: [
            { filter: { as: 'alice', permission: 'file:read', type: 'file' }, expect: { equals: { op: RBAC_ASSIGNMENT_OP, args: { v: 1, subjects: [{ type: 'user', id: 'alice' }], roles: ['viewer'] } } } },
            {
              note: 'session.list evaluates native:rbac.assignment with the model filter',
              do: async (ctx) => {
                const list = ctx.session.list!;
                assert.deepEqual([...(await list(ctx.principal('alice'), 'file:read', 'file'))].sort(), ['f1']);
                assert.deepEqual([...(await list(ctx.principal('carol'), 'file:read', 'file'))].sort(), ['f3', 'f4']);
              },
            },
            { agree: { as: ['alice', 'bob', 'carol'], permissions: ['file:read'], type: 'file' } },
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
      note: 'AuthzService.covers must count a typed doc:read grant of the target; skipped until the engine reads model summaries (docs/plans/authz-v3-rfc/L1-3.md).',
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

runBehaviour(['B06.rbac-native'], () => rbacHarness({ extensions: (_host, options) => [rbacAssignmentExtension(options)] }), { strict: true, timeoutMs: 30_000, fixtures: [...BEHAVIOUR_FIXTURES, ...LOCAL] });
runBehaviour(['B13.rbac-global'], rbacHarness, { strict: true, timeoutMs: 30_000, fixtures: [...BEHAVIOUR_FIXTURES, ...LOCAL] });
runBehaviour(['B01.rbac-combine'], rbacHarness, { strict: true, timeoutMs: 30_000, fixtures: [...BEHAVIOUR_FIXTURES, ...LOCAL] });
runBehaviour(['B12.rbac-extension'], throwingHarness, { strict: true, timeoutMs: 30_000, fixtures: [...BEHAVIOUR_FIXTURES, ...LOCAL] });

// Pending until F3 lands RFC L1-3 (covers from model summaries); then drop the skip. Today covers(caller, target) is true.
describe.skip('B26.rbac-probe: RFC L1-3 (docs/plans/authz-v3-rfc/L1-3.md)', () => {
  runBehaviour(['B26.rbac-probe'], rbacHarness, { strict: true, timeoutMs: 30_000, fixtures: [...BEHAVIOUR_FIXTURES, ...LOCAL] });
});
