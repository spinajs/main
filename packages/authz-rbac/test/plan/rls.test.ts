import { PermissionRegistryImpl } from '@spinajs/authz';
import type { AuthorizationModel } from '@spinajs/authz';
import { fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { MemoryAssignmentStore, MemoryRoleStore, RbacModel, RbacRlsPlanSource, RbacRlsSubjectKeys, rbacRlsPlan } from '../../src/index.js';
import type { GrantDef, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const role = (name: string, grants: readonly (string | GrantDef)[] = [], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });

function registry() {
  const r = new PermissionRegistryImpl();
  r.register([{ name: 'doc:read', types: ['doc'], list: true }, { name: 'doc:delete', types: ['doc'], list: true }], 'test');
  r.freeze();
  return r;
}

async function model(roles: readonly RoleDef[], config: Record<string, unknown> = {}, assignments: MemoryAssignmentStore = new MemoryAssignmentStore([])) {
  const reg = registry();
  const m = new RbacModel({ roles: new MemoryRoleStore(roles), assignments, log: { warn: () => undefined } });
  await m.init(fakeModelInitContext({ model: 'rbac', permissions: reg, config }));
  m.grantIndex();
  return { m, read: reg.require('doc:read'), del: reg.require('doc:delete') };
}

const term = (roles: readonly object[]) => ({ op: 'rbac.assignment', args: { subjects: [], roles, global: true } });

describe('rbacRlsPlan: the RBAC list plan for any principal', () => {
  it('names every role that grants the permission, with the qualifiers of its grant, and the deny roles', async () => {
    const { m, read } = await model([
      role('viewer', ['doc:read']),
      role('editor', [], { extends: ['viewer'] }),
      role('pm', [{ permission: 'doc:read', grantedAt: ['project'] }], { scopeTypes: ['project', 'org'] }),
      role('billing', [{ permission: 'doc:read', requiresTag: 'paid' }]),
      role('member', [{ permission: 'doc:read', relation: 'owner' }]),
      role('other', ['doc:delete']),
      { ...role('blocked', ['doc:read']), deny: true },
    ]);
    expect(rbacRlsPlan(m, read, 'doc')).to.deep.equal({
      kind: 'terms',
      permit: [term([{ role: 'billing', tag: 'paid' }, { role: 'editor' }, { role: 'member', relation: 'owner' }, { role: 'pm', scopeTypes: ['project'] }, { role: 'viewer' }])],
      deny: [term([{ role: 'blocked' }])],
    });
  });

  it('abstains when no role grants or denies it', async () => {
    const { m, read } = await model([role('other', ['doc:delete'])]);
    expect(rbacRlsPlan(m, read, 'doc')).to.deep.equal({ kind: 'abstain' });
  });

  it('refuses what the assignment rows cannot show: config roles and implied roles', async () => {
    const anonymous = await model([role('viewer', ['doc:read'])], { anonymousRoles: ['viewer'] });
    expect(() => rbacRlsPlan(anonymous.m, anonymous.read, 'doc')).to.throw(/anonymousRoles or serviceRoles/);
    const implied = await model([role('viewer', ['doc:read']), role('lead', [], { implies: [{ role: 'viewer', at: 'descendants' }] })]);
    expect(() => rbacRlsPlan(implied.m, implied.read, 'doc')).to.throw(/implies a role that grants doc:read/);
  });

  it('is the RlsPlanSource of the model named rbac', async () => {
    const { m, read } = await model([role('viewer', ['doc:read'])]);
    const source = new RbacRlsPlanSource();
    expect(source.model).to.equal('rbac');
    expect(source.plan(m, read, 'doc')).to.deep.equal({ kind: 'terms', permit: [term([{ role: 'viewer' }])], deny: [] });
    expect(() => source.plan({ name: 'rbac' } as AuthorizationModel, read, 'doc')).to.throw(/not an RbacModel/);
  });

  it("gives the session the principal's subject keys, its sets included", async () => {
    const roles = [role('viewer', ['doc:read']), role('team.member', [], { subjectSet: true })];
    const { m } = await model(roles, {}, new MemoryAssignmentStore([{ id: 'a1', subject: { type: 'user', id: 'alice' }, role: 'team.member', scope: { type: 'team', id: 't1' }, source: 'test' }]));
    expect([...(await new RbacRlsSubjectKeys().keys(m, userPrincipal('alice')))].sort()).to.deep.equal(['team:t1#team.member', 'user:*', 'user:alice']);
  });
});

