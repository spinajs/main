import { GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { RuleDef } from '@spinajs/authz';
import { BEHAVIOUR_FIXTURES, fakeModelInitContext, fixtureDsl, runBehaviour, userPrincipal } from '@spinajs/authz-testing';
import type { Case, World } from '@spinajs/authz-testing';
import { expect } from 'chai';
import 'mocha';

import { ConfigRuleStore, MemoryAssignmentStore, MemoryRoleStore, RbacModel } from '../../src/index.js';
import type { RoleDef } from '../../src/index.js';
import { rbacSqlBootProblems, sqlExpressibleGlob } from '../../src/orm/index.js';
import type { RbacSqlBootColumns } from '../../src/orm/index.js';
import { rbacHarness } from '../model/harness.js';
import { KINDS } from '../orm/root-orm.js';
import { sqlKitHarness } from './kit-harness.js';

/*
 * Boot rule §6.5.11 (L4b plan task 7): kit B05.sql on the lane SQL harness, strict, and lane cases beside it for
 * the rule's other shapes (config rules) and the controls that must boot.
 */

const { assignment, combine, extension, ref, role } = fixtureDsl;
const alice = userPrincipal('alice');
const P1 = ref('project', 'p1');

const PERMISSIONS = [
  { name: 'file:read', types: ['file'] },
  { name: 'file:edit', types: ['file'] },
  { name: 'project:read', types: ['project'] },
  // No adapter serves 'note': it lists nowhere in SQL.
  { name: 'note:read', types: ['note'] },
];

function world(grantOn: readonly { type: string; id?: string }[] | undefined, rules: readonly Omit<RuleDef, 'source'>[] = [], adapter: object = {}): World {
  return {
    permissions: PERMISSIONS,
    principals: { alice },
    adapters: [
      {
        types: ['file', 'project'],
        rows: { file: [{ id: 'f1', name: 'a/b', size: 3 }], project: [{ id: 'p1' }] },
        parents: [[ref('file', 'f1'), P1] as const],
        ...adapter,
      },
    ],
    combine: combine('deny-overrides', 'rbac'),
    rbac: {
      ladders: [{ name: 'project', roles: ['viewer', 'maintainer'] }],
      roles: [role('viewer', [grantOn ? { permission: 'file:read', on: grantOn.map((p) => ({ ...p })) } : 'file:read', 'file:edit', 'project:read'], { ladder: 'project' }), role('maintainer', [], { ladder: 'project' })],
      assignments: [assignment('a1', alice, 'viewer', P1)],
      rules: rules.map((r) => ({ ...r, source: 'test' })),
    },
  };
}

const refused = (name: string, w: World, message: string[]): Case => ({ name, world: w, boot: { throws: 'AuthzConfigError', message: ['$domain', '6.5 rule 11', ...message] }, steps: [] });
const boots = (name: string, w: World): Case => ({ name, world: w, steps: [{ check: { as: 'alice', permission: 'file:edit', resource: ref('file', 'f1'), subject: 'row' }, expect: { allowed: true } }] });

const threshold = (extra: Partial<RuleDef>): Omit<RuleDef, 'source'> => ({ id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['file:edit'], minRole: 'maintainer', ...extra } as Omit<RuleDef, 'source'>);

const LOCAL = [
  extension('B05', [
    {
      name: 'sql-l4b',
      facets: ['engine', 'boot', 'rbac', 'rules', 'sql'],
      lanes: ['L4b'],
      note: 'Rule 11 beyond the kit case: config rules, and the shapes SQL can express (controls).',
      cases: [
        boots(
          'control: a prefix glob, a ** glob and a template prefix boot',
          world([
            { type: 'file', id: 'a/*' },
            { type: 'file', id: 'a/**' },
            { type: 'file', id: '{principal.id}/*' },
          ]),
        ),
        refused('a glob with a * before its end', world([{ type: 'file', id: '*/b' }]), ["type 'file'", "rbac role 'viewer' grant 'file:read'", '"*/b"']),
        refused('a config threshold whose resource glob is more than a prefix', world(undefined, [threshold({ resource: { attr: 'resource.name', glob: 'a*b' } })]), ["type 'file'", "rbac rule 't1'", '"a*b"']),
        refused('a config threshold whose when reads a field that is no column', world(undefined, [threshold({ when: { attr: 'resource.weight', gt: 3 } })]), ["type 'file'", "rbac rule 't1'", 'resource.weight', 'not a column']),
        // Review M2: leaves SQL can only read as UNKNOWN.
        refused('a config threshold comparing a text column with eq', world(undefined, [threshold({ when: { attr: 'resource.name', eq: 'notes' } })]), ["type 'file'", "rbac rule 't1'", 'resource.name with eq']),
        refused('a config threshold comparing an integer column', world(undefined, [threshold({ when: { attr: 'resource.size', gt: 3 } })]), ["type 'file'", "rbac rule 't1'", 'resource.size, which is not a text column']),
        refused('a config threshold matching an integer column with a wildcard', world(undefined, [threshold({ resource: { attr: 'resource.size', wildcard: '3*' } })]), ["type 'file'", "rbac rule 't1'", 'resource.size, which is not a text column']),
        refused('a config threshold reading a field of two segments', world(undefined, [threshold({ resource: { attr: 'resource.name.first', wildcard: 'a*' } })]), ["type 'file'", "rbac rule 't1'", 'resource.name.first: SQL reads only a field of one segment']),
        // Review M7: a leaf under all, any and not.
        refused('a config threshold whose resource glob sits under all, any and not', world(undefined, [threshold({ when: { all: [{ attr: 'principal.id', ne: 'x' }, { any: [{ attr: 'principal.id', eq: 'y' }, { not: { attr: 'resource.name', glob: 'a*b' } }] }] } })]), ["type 'file'", "rbac rule 't1'", '"a*b"']),
        refused('a config threshold whose resource glob is a ref', world(undefined, [threshold({ resource: { attr: 'resource.name', glob: { ref: 'principal.attributes.home' } } as never })]), ["type 'file'", "rbac rule 't1'", 'not a literal']),
        boots('control: the same rule limited to another type boots', world(undefined, [threshold({ resourceTypes: ['project'], when: { attr: 'resource.size', gt: 3 } })])),
        boots('control: a threshold whose permissions are on a type no SQL lists boots', world(undefined, [threshold({ permissions: ['note:read'], resource: { attr: 'resource.title', glob: 'a*b' } })])),
        boots('control: a prefix glob and a wildcard on a column boot', world(undefined, [threshold({ resource: { attr: 'resource.name', glob: 'z/**' } }), threshold({ id: 't2', when: { attr: 'resource.name', wildcard: '*zz*' } })])),
        // '*' matches project:read too, and projects have no name column.
        refused('a threshold on every permission reading a field one of the types lacks', world(undefined, [threshold({ permissions: ['*'], resource: { attr: 'resource.name', glob: 'z/*' } })]), ["type 'project'", "rbac rule 't1'", 'resource.name']),
        boots('control: a permission glob that matches only the type with the column boots', world(undefined, [threshold({ permissions: ['file:*'], resource: { attr: 'resource.name', glob: 'z/*' } })])),
      ],
    },
  ]),
];

// On the kit's in-memory adapters: one that calls itself 'orm' is list-scoped only with `compiles`.
const FAKE = [
  extension('B05', [
    {
      name: 'sql-l4b-fake',
      facets: ['engine', 'boot', 'rbac', 'rules'],
      lanes: ['L4b'],
      note: "Rule 11 on adapters of kind 'orm' without authz-orm models: not list-scoped boots, list-scoped refuses (columns not loaded).",
      cases: [boots("control: an adapter of kind 'orm' that is not list-scoped", world(undefined, [threshold({ resource: { attr: 'resource.name', wildcard: 'zz*' } })], { kind: 'orm', compiles: undefined })), refused("an adapter of kind 'orm' whose types have no loaded columns", world(undefined, [threshold({ resource: { attr: 'resource.name', wildcard: 'zz*' } })], { kind: 'orm' }), ["type 'file'", "rbac rule 't1'", "the columns of type 'file' are not loaded"])],
    },
  ]),
];

async function bootModel(roles: readonly RoleDef[], rules: readonly Omit<RuleDef, 'source'>[] = []): Promise<RbacModel> {
  const registry = new PermissionRegistryImpl();
  registry.register(PERMISSIONS, 'test');
  registry.freeze();
  const model = new RbacModel({ roles: new MemoryRoleStore(roles, [{ name: 'project', roles: ['viewer', 'maintainer'] }]), assignments: new MemoryAssignmentStore([]), rules: new ConfigRuleStore(rules.map((r) => ({ ...r, source: 'test' })) as RuleDef[]), log: { warn: () => undefined } });
  await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
  return model;
}

const TEXT = (...names: string[]): RbacSqlBootColumns => ({ names: ['id', ...names], text: ['id', ...names] });

const LADDER_ROLES = [role('viewer', [{ permission: 'file:read', on: [{ type: 'file', id: '*/b' }] }], { ladder: 'project' }), role('maintainer', ['file:edit'], { ladder: 'project' })];

const PLAIN_ROLES = [role('viewer', ['file:read', 'file:edit'], { ladder: 'project' }), role('maintainer', [], { ladder: 'project' })];

describe('authz-rbac orm-compile: boot rule §6.5.11', () => {
  it('a glob SQL expresses is a fixed prefix and at most one trailing * or **', () => {
    for (const ok of ['a', 'a/*', 'a/**', '*', '**', '']) expect(sqlExpressibleGlob(ok), ok).to.equal(true);
    for (const no of ['a*b*', '*/b', 'a/*/c', 'a/***', '**/x', 'a**b']) expect(sqlExpressibleGlob(no), no).to.equal(false);
  });

  describe('rbacSqlBootProblems', () => {
    it('reports a grant glob once, under the role that declares it, not under the roles that inherit it', async () => {
      const model = await bootModel(LADDER_ROLES);
      const problems = rbacSqlBootProblems({ model, types: ['file'], columns: () => [TEXT('name')] });
      expect(problems.map((p) => [p.type, p.source])).to.deep.equal([['file', "rbac role 'viewer' grant 'file:read'"]]);
    });

    it('needs the field as a text column of every model of the type', async () => {
      const model = await bootModel(PLAIN_ROLES, [threshold({ resource: { attr: 'resource.name', wildcard: 'a*' } })]);
      expect(rbacSqlBootProblems({ model, types: ['file'], columns: () => [TEXT('name'), TEXT('name')] })).to.deep.equal([]);
      expect(rbacSqlBootProblems({ model, types: ['file'], columns: () => [TEXT('name'), TEXT()] }).map((p) => p.text)).to.deep.equal(["resource reads resource.name, which is not a column of type 'file'"]);
      const text = rbacSqlBootProblems({ model, types: ['file'], columns: () => [TEXT('name'), { names: ['id', 'name'], text: ['id'] }] });
      expect(text.map((p) => p.text)).to.deep.equal(["resource reads resource.name, which is not a text column of type 'file' (SQL decides a resource.* read only as a literal wildcard, or a literal glob of a fixed prefix and one trailing * or **, on a text column)"]);
    });

    it('says the columns are not loaded for a type without a model or with a model without columns (review M5)', async () => {
      const model = await bootModel(PLAIN_ROLES, [threshold({ when: { attr: 'resource.name', wildcard: 'a*' } })]);
      const unloaded: RbacSqlBootColumns = { names: [], text: [] };
      for (const columns of [[], [unloaded], [TEXT('name'), unloaded]]) {
        const problems = rbacSqlBootProblems({ model, types: ['file'], columns: () => columns });
        expect(problems.map((p) => p.text)).to.deep.equal(["when reads resource.*, but the columns of type 'file' are not loaded (boot the ORM before the authz domain)"]);
      }
    });

    it('refuses a pattern holding a NUL', async () => {
      const model = await bootModel(PLAIN_ROLES, [threshold({ resource: { attr: 'resource.name', wildcard: 'a\u0000*' } })]);
      expect(rbacSqlBootProblems({ model, types: ['file'], columns: () => [TEXT('name')] }).map((p) => p.text)).to.deep.equal(['resource matches resource.name with a wildcard holding a NUL, which SQL cannot decide']);
    });
  });

  describe('on the kit adapters', function () {
    this.timeout(120000);
    runBehaviour(['B05.sql-l4b-fake'], () => rbacHarness({ facets: ['ladders', 'rules', 'conditions'], rules: (host) => new ConfigRuleStore(host.world.rbac?.rules ?? []) }), { strict: true, timeoutMs: 60000, fixtures: [...BEHAVIOUR_FIXTURES, ...FAKE] });
  });

  for (const kind of KINDS) {
    describe(kind, function () {
      this.timeout(600000);
      runBehaviour(['B05.sql', 'B05.sql-l4b'], () => sqlKitHarness({ kind }), { strict: true, timeoutMs: 120000, fixtures: [...BEHAVIOUR_FIXTURES, ...LOCAL] });
    });
  }
});
