import { DefaultConditionCompiler, GLOBAL } from '@spinajs/authz';
import type { Assignment, PermissionInput, ResourceRef, RuleDef } from '@spinajs/authz';
import { CONFORMANCE_NOW, FakeAdapter, FakeScopeResolver, runModelConformance, userPrincipal, withCeiling, withCompanions, worldRows } from '@spinajs/authz-testing';
import type { ModelFactory } from '@spinajs/authz-testing';
import * as fc from 'fast-check';
import 'mocha';

import { ConfigRuleStore, MemoryAssignmentStore, MemoryRoleStore, RbacModel, createRbacExtensions, rbacAssignmentExtension } from '../../src/index.js';
import type { LadderDef, RbacModelOptions, RoleDef } from '../../src/index.js';

/*
 * runModelConformance over RbacModel with what L1b adds: a ladder (implicit extends, ranks), implied
 * roles, a subject set, and restrict, cap and threshold rules (org-attribute conditions included),
 * once with the default extensions and once with the list extension (args v2, rules: true).
 */

const O1: ResourceRef = { type: 'org', id: 'o1' };
const O2: ResourceRef = { type: 'org', id: 'o2' };
const P1: ResourceRef = { type: 'project', id: 'p1' };
const P2: ResourceRef = { type: 'project', id: 'p2' };
const P3: ResourceRef = { type: 'project', id: 'p3' };
const FILE_A: ResourceRef = { type: 'file', id: 'a' };
const HOUR = 3_600_000;

const PERMISSIONS: PermissionInput[] = ['file:read', 'file:write', 'file:delete'].map((name) => ({ name, types: ['file'] }));
const NAMES = PERMISSIONS.map((p) => p.name);

const role = (name: string, grants: RoleDef['grants'], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'conformance', ...extra, grants });
const LADDERS: LadderDef[] = [{ name: 'files', roles: ['viewer', 'editor', 'admin'] }];
const ROLES: RoleDef[] = [role('viewer', [{ permission: 'file:read' }], { ladder: 'files' }), role('editor', [{ permission: 'file:write' }], { ladder: 'files' }), role('admin', [{ permission: 'file:delete' }], { ladder: 'files' }), role('owner', [{ permission: 'file:delete', relation: 'owner' }]), role('lead', [], { implies: [{ role: 'editor', at: 'descendants' }] }), role('team', [], { subjectSet: true })];

// Rules a type-level vote of the default extensions can carry: no scope reads, scope GLOBAL.
const GLOBAL_RULES: Omit<RuleDef, 'source'>[] = [
  { id: 'cap-dave', kind: 'cap', scope: GLOBAL, ladder: 'files', maxRole: 'viewer', subjects: { refs: [{ type: 'user', id: 'dave' }] } },
  { id: 'delete-admins', kind: 'threshold', scope: GLOBAL, permissions: ['file:delete'], minRole: 'admin' },
];
// Rules per path and per row, which the list extension carries in its terms.
const PATH_RULES: Omit<RuleDef, 'source'>[] = [
  { id: 'cap-p2', kind: 'cap', scope: P2, ladder: 'files', maxRole: 'viewer' },
  { id: 'restrict-p3', kind: 'restrict', scope: P3, allow: [{ type: 'user', id: 'bob' }] },
  { id: 'cap-locked', kind: 'cap', scope: GLOBAL, ladder: 'files', maxRole: 'viewer', when: { attr: 'scope.org.policies.locked', eq: true } },
  { id: 'strict-delete', kind: 'threshold', scope: O1, permissions: ['file:delete', 'file:write'], minRole: 'admin', when: { attr: 'scope.org.policies.strict', eq: true } },
];

const USERS = ['alice', 'bob', 'dave', 'erin'];
const SCOPES: ResourceRef[] = [GLOBAL, O1, O2, P1, P2, P3, FILE_A, { type: 'file' }];
const ROLE_NAMES = ['viewer', 'editor', 'admin', 'owner', 'lead', 'team', 'ghost'];

interface Seed {
  readonly rules: readonly number[];
  readonly locked: boolean;
  readonly assignments: readonly { readonly who: string; readonly role: string; readonly scope: number; readonly expiry: 'none' | 'past' | 'future' }[];
}

const seeds = (pool: readonly unknown[]): fc.Arbitrary<Seed> =>
  fc.record({
    rules: fc.subarray([...pool.keys()]),
    locked: fc.boolean(),
    assignments: fc.array(fc.record({ who: fc.constantFrom(...USERS), role: fc.constantFrom(...ROLE_NAMES), scope: fc.nat({ max: SCOPES.length - 1 }), expiry: fc.constantFrom('none' as const, 'past' as const, 'future' as const) }), { maxLength: 6 }),
  });

const user = (id: string) => ({ type: 'user', id });

function adapter(): FakeAdapter {
  return new FakeAdapter({
    types: ['file'],
    rows: {
      file: [
        { id: 'a', owner: 'alice' },
        { id: 'b', owner: 'bob' },
        { id: 'c', owner: 'alice' },
        { id: 'd', owner: 'dave' },
      ],
    },
    parents: [
      [FILE_A, P1],
      [{ type: 'file', id: 'b' }, P1],
      [{ type: 'file', id: 'c' }, P2],
      [{ type: 'file', id: 'd' }, P3],
      [P1, O1],
      [P2, O1],
      [P3, O2],
    ],
    relations: [{ type: 'file', relation: 'owner', column: 'owner' }],
  });
}

const factory =
  (pool: readonly Omit<RuleDef, 'source'>[], lists: boolean): ModelFactory<Seed> =>
  ({ seed, shuffle }) => {
    const temp: Assignment = { id: 'temp', subject: user('temp'), role: 'viewer', scope: GLOBAL, source: 'conformance', expiresAt: new Date(CONFORMANCE_NOW.getTime() + HOUR) };
    const rows: Assignment[] = [
      { id: 'carol', subject: user('carol'), role: 'admin', scope: GLOBAL, source: 'conformance' },
      { id: 'leaver', subject: user('leaver'), role: 'editor', scope: GLOBAL, source: 'conformance' },
      { id: 'team-erin', subject: user('erin'), role: 'team', scope: O1, source: 'conformance' },
      { id: 'team-grant', subject: { set: { role: 'team', scope: O1 } }, role: 'editor', scope: P2, source: 'conformance' },
      temp,
      ...seed.assignments.map(
        (a, i): Assignment => ({
          id: `s${i}`,
          subject: user(a.who),
          role: a.role,
          scope: SCOPES[a.scope],
          source: 'conformance',
          ...(a.expiry === 'none' ? {} : { expiresAt: new Date(CONFORMANCE_NOW.getTime() + (a.expiry === 'past' ? -HOUR : HOUR)) }),
        }),
      ),
    ];
    const store = new MemoryAssignmentStore(shuffle(rows));
    const rules = new ConfigRuleStore(shuffle(seed.rules.map((i) => ({ ...pool[i], source: 'conformance' }))));
    const options: RbacModelOptions = { roles: new MemoryRoleStore(shuffle(ROLES), LADDERS), assignments: store, rules, log: { warn: () => undefined } };
    const model = new RbacModel({ ...options, ...(lists ? { extensions: [...createRbacExtensions(options), rbacAssignmentExtension(options, { rules: true })] } : {}) });
    const files = adapter();
    const rowA = files.all('file')[0];
    const scopes = new FakeScopeResolver({
      nodes: [
        { ref: O1, attributes: { policies: { locked: seed.locked, strict: true } } },
        { ref: O2, attributes: { policies: { locked: false, strict: false } } },
        { ref: P1, parent: O1 },
        { ref: P2, parent: O1 },
        { ref: P3, parent: O2 },
      ],
    });
    const probe = (who: string, permission: string) => ({ principal: userPrincipal(who), permission, resource: FILE_A, subject: rowA });
    return {
      model,
      world: {
        principals: [...USERS, 'carol', 'leaver', 'temp', 'nobody'].map((id) => userPrincipal(id)).concat(withCompanions(userPrincipal('svc'), [user('alice')]), withCeiling(userPrincipal('bob'), { roles: ['viewer', 'lead'] })),
        permissions: NAMES,
        rows: worldRows(files),
        context: { adapters: [files], scopeResolvers: [scopes], conditions: new DefaultConditionCompiler(undefined, [scopes]), permissions: PERMISSIONS },
      },
      mutations: [
        {
          title: 'assign a newcomer viewer at p1 (no rule of the pool takes file:read there)',
          request: { principal: userPrincipal('newcomer'), permission: 'file:read', resource: { type: 'file', id: 'b' }, subject: files.all('file')[1] },
          after: true,
          apply: () => store.add({ id: 'new', subject: user('newcomer'), role: 'viewer', scope: P1, source: 'conformance' }),
          tags: ['subject:user:newcomer'],
          freshness: 'invalidate',
        },
        {
          title: 'expire the viewer assignment of temp',
          request: probe('temp', 'file:read'),
          after: false,
          apply: () => {
            store.remove('temp');
            store.add({ ...temp, expiresAt: new Date(CONFORMANCE_NOW.getTime() - HOUR) });
          },
          tags: ['subject:user:temp'],
          freshness: 'invalidate',
        },
      ],
    };
  };

describe('authz-rbac L1b: conformance', () => {
  runModelConformance('RbacModel with ladders, implies, sets and rules (default extensions)', factory(GLOBAL_RULES, false), { seeds: seeds(GLOBAL_RULES), timeoutMs: 300_000 });
  runModelConformance('RbacModel with ladders, implies, sets and rules on every path (list extension)', factory([...GLOBAL_RULES, ...PATH_RULES], true), { seeds: seeds([...GLOBAL_RULES, ...PATH_RULES]), timeoutMs: 300_000 });
});
