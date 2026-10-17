import { PermissionRegistryImpl } from '@spinajs/authz';
import { fakeModelInitContext } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { grantingRoles } from '../../src/admin/holders.js';
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
});
