import { PermissionRegistryImpl } from '@spinajs/authz';
import { fakeModelInitContext } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import type { AdminContext } from '@spinajs/authz';

import { grantingRoles, grantingRolesAt, listHolders } from '../../src/admin/holders.js';
import { MemoryAssignmentStore, MemoryRoleStore, RbacModel } from '../../src/index.js';
import type { GrantDef, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const role = (name: string, grants: readonly (string | GrantDef)[] = [], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });

async function model(roles: readonly RoleDef[]) {
  const registry = new PermissionRegistryImpl();
  registry.register([{ name: 'doc:read', types: ['doc'] }, { name: 'doc:edit', types: ['doc'], implies: ['doc:read'] }, { name: 'doc:delete', types: ['doc'] }], 'test');
  registry.freeze();
  const m = new RbacModel({ roles: new MemoryRoleStore(roles), assignments: new MemoryAssignmentStore(), log: { warn: () => undefined } });
  await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
  m.grantIndex();
  return m;
}

describe('authz-rbac holders: grantingRoles', () => {
  it('finds direct grants, extends, permission implies and roles that imply a granting role', async () => {
    const m = await model([
      role('viewer', ['doc:read']),
      role('editor', ['doc:edit']),
      role('admin', [], { extends: ['editor'] }),
      role('lead', [], { implies: [{ role: 'viewer', at: 'descendants' }] }),
      role('janitor', ['doc:delete']),
    ]);
    expect([...grantingRoles(m, 'doc:read')].sort()).to.deep.equal(['admin', 'editor', 'lead', 'viewer']);
    expect([...grantingRoles(m, 'doc:delete')]).to.deep.equal(['janitor']);
  });
  it('leaves out a deny role', async () => {
    const m = await model([role('viewer', ['doc:read']), role('blocked', ['doc:read'], { deny: true })]);
    expect([...grantingRoles(m, 'doc:read')]).to.deep.equal(['viewer']);
  });

  it('counts a descendants-only implied role for ancestors but not for the resource itself', async () => {
    const m = await model([
      role('viewer', ['doc:read']),
      role('lead', [], { implies: [{ role: 'viewer', at: 'descendants' }] }),
      role('owner', [], { implies: [{ role: 'viewer', at: 'self-and-descendants' }] }),
    ]);
    const { self, ancestors } = grantingRolesAt(m, 'doc:read');
    expect([...self].sort()).to.deep.equal(['owner', 'viewer']);
    expect([...ancestors].sort()).to.deep.equal(['lead', 'owner', 'viewer']);
  });
});

describe('authz-rbac holders: listHolders needs an AuthzService with ancestors and inspect', () => {
  const query = { permission: 'doc:read', scope: { type: 'doc', id: 'd1' }, expandSets: false, page: { limit: 10, offset: 0 } } as const;
  const ctxWith = (m: RbacModel, authz: object) => ({ domain: 'root', authz: { models: () => [m], ...authz } }) as unknown as AdminContext;

  it('throws AuthzConfigError without ancestors()', async () => {
    const m = await model([role('viewer', ['doc:read'])]);
    let e: unknown;
    await listHolders(query, ctxWith(m, { inspect: async () => ({}) })).catch((err: unknown) => (e = err));
    expect(e).to.be.instanceOf(AuthzConfigError);
    expect((e as Error).message).to.match(/ancestors/);
  });

  it('throws AuthzConfigError without inspect()', async () => {
    const m = await model([role('viewer', ['doc:read'])]);
    let e: unknown;
    await listHolders(query, ctxWith(m, { ancestors: async () => [] })).catch((err: unknown) => (e = err));
    expect(e).to.be.instanceOf(AuthzConfigError);
    expect((e as Error).message).to.match(/inspect/);
  });
});
