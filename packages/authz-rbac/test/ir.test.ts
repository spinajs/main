import * as chai from 'chai';
import 'mocha';
import { readFileSync } from 'node:fs';
import { PermissionRegistryImpl } from '@spinajs/authz';
import type { PermissionInput } from '@spinajs/authz';
import { GLOBAL_OBJECT, IREvaluator, MemoryTupleSource, canonicalize, mergeFragments, validateIR } from '@spinajs/authz-ir';
import type { IRFragment, PolicyIR, Truth } from '@spinajs/authz-ir';

import { compileGrants, compileRoles, rbacToIR } from '../src/index.js';
import type { GrantDef, RoleDef, RuleDef } from '../src/index.js';

const expect = chai.expect;

const registry = (defs: readonly PermissionInput[]): PermissionRegistryImpl => {
  const r = new PermissionRegistryImpl();
  r.register(defs, 'test');
  r.freeze();
  return r;
};

type Extra = Partial<Omit<RoleDef, 'name' | 'grants'>>;
const role = (name: string, grants: readonly (string | GrantDef)[] = [], extra: Extra = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });

/** The RBAC part of the impact summary §3.3 config. */
const ROLES = [role('invoice.viewer', ['invoice:read'], { assignable: false }), role('accountant', ['invoice:approve'], { extends: ['invoice.viewer'], scopeTypes: ['org'] }), role('clerk', [{ permission: 'invoice:read', relation: 'owner' }])];
const PERMISSIONS: PermissionInput[] = [{ name: 'invoice:read', list: true }, { name: 'invoice:approve' }, { name: 'project:read' }];

/** Invoices under projects (column), projects under orgs (adapter ancestry), as the ORM and the adapter would compile them. */
const SCOPES: IRFragment = {
  model: 'orm',
  types: {
    org: { relations: {}, permissions: {} },
    project: { relations: { parent: { allowed: ['org'], source: { kind: 'ancestor', via: 'adapter' } } }, permissions: {} },
    invoice: { relations: { parent: { allowed: ['project'], source: { kind: 'column', model: 'Invoice', column: 'project_id' } }, owner: { allowed: ['user'], source: { kind: 'column', model: 'Invoice', column: 'author_id' } } }, permissions: {} },
  },
};

function compile(roles: readonly RoleDef[], rules?: readonly RuleDef[]): PolicyIR {
  const reg = registry(PERMISSIONS);
  const { ir, conflicts } = mergeFragments([rbacToIR(compileRoles(roles), compileGrants(compileRoles(roles), reg), reg, rules ? { rules } : {}), SCOPES]);
  expect(conflicts).to.deep.equal([]);
  expect(validateIR(ir)).to.deep.equal([]);
  return ir;
}

const user = (id: string) => ({ type: 'user', id });
const i1 = { type: 'invoice', id: 'i1' };

function world(ir: PolicyIR): MemoryTupleSource {
  return new MemoryTupleSource(ir)
    .setColumn('Invoice', 'project_id', i1, { type: 'project', id: 'p1' })
    .setColumn('Invoice', 'author_id', i1, user('carl'))
    .add({ type: 'project', id: 'p1' }, 'parent', { type: 'org', id: 'o1' })
    .add({ type: 'org', id: 'o1' }, 'accountant', user('ann'))
    .add({ type: 'org', id: 'o2' }, 'accountant', user('bob'))
    .add(GLOBAL_OBJECT, 'clerk', user('carl'))
    .add(GLOBAL_OBJECT, 'clerk', user('cleo'));
}

async function truth(ir: PolicyIR, who: string, permission: string, source = world(ir)): Promise<Truth> {
  return (await new IREvaluator(ir, source).check({ principal: user(who), permission, resource: i1 })).truth;
}

describe('authz-rbac: rbacToIR', () => {
  it('compiles the §3.3 roles to the golden IR', () => {
    const golden = readFileSync(new URL('./fixtures/invoice.ir.json', import.meta.url), 'utf8');
    expect(`${JSON.stringify(JSON.parse(canonicalize(compile(ROLES))), null, 2)}\n`).to.equal(golden);
  });

  it('reaches scoped roles down the scope chain, global roles everywhere, relation grants only with the relation', async () => {
    const ir = compile(ROLES);
    expect(await truth(ir, 'ann', 'invoice:read')).to.equal('allow');
    expect(await truth(ir, 'ann', 'invoice:approve')).to.equal('allow');
    expect(await truth(ir, 'bob', 'invoice:read')).to.equal('deny');
    expect(await truth(ir, 'carl', 'invoice:read')).to.equal('allow');
    expect(await truth(ir, 'cleo', 'invoice:read')).to.equal('deny');
    expect(await truth(ir, 'carl', 'invoice:approve')).to.equal('deny');
  });

  it('subtracts deny roles and maps roles for ceilings', async () => {
    const ir = compile([...ROLES, role('frozen', ['invoice:read'], { deny: true, scopeTypes: ['project'] })]);
    expect(ir.principal.roles.accountant).to.deep.equal([{ type: 'org', relation: 'accountant' }]);
    expect(ir.principal.roles.clerk).to.deep.equal([{ type: '$global', relation: 'clerk' }]);
    const source = world(ir).add({ type: 'project', id: 'p1' }, 'frozen', user('ann'));
    expect(await truth(ir, 'ann', 'invoice:read', source)).to.equal('deny');
    expect(await truth(ir, 'ann', 'invoice:approve', source)).to.equal('allow');
  });

  it('makes what it cannot express opaque, so the answer is unknown instead of a guess', async () => {
    const ir = compile([...ROLES, role('auditor', [{ permission: 'invoice:approve', on: [{ type: 'invoice', id: 'q*' }] }])], [{ id: 'r1', kind: 'threshold', scope: { type: '$global' }, permissions: ['invoice:read'], minRole: 'x', source: 'config' }]);
    expect(ir.opaque.map((o) => o.name).sort()).to.deep.equal(['rbac grant on of role auditor', 'rbac rule r1']);
    const source = world(ir).add(GLOBAL_OBJECT, 'auditor', user('dan'));
    expect(await truth(ir, 'dan', 'invoice:approve', source)).to.equal('unknown');
    expect(await truth(ir, 'ann', 'invoice:read', source)).to.equal('unknown');
    expect(await truth(ir, 'bob', 'invoice:read', source)).to.equal('deny');
  });
});
