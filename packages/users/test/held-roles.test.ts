import 'mocha';
import { expect } from 'chai';
import { PermissionRegistryImpl } from '@spinajs/authz';
import { fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import { MemoryAssignmentStore, MemoryRoleStore, RbacModel, RbacService } from '@spinajs/authz-rbac';

import { heldRoles } from '../src/authn/target-guard.js';

describe('heldRoles: an assignment whose expiry no converter reads', () => {
  it('keeps its role held, so the protected-role check still sees it', async () => {
    const permissions = new PermissionRegistryImpl();
    permissions.register([{ name: 'doc:read', types: ['project'] }], 'test');
    permissions.freeze();
    const model = new RbacModel({
      roles: new MemoryRoleStore([{ name: 'admin', extends: [], assignable: true, source: 'test', grants: [{ permission: 'doc:read' }] }]),
      assignments: new MemoryAssignmentStore([
        { id: 'a-bad', subject: { type: 'user', id: 't' }, role: 'admin', scope: { type: 'project', id: 'p1' }, expiresAt: new Date(NaN), source: 'db' },
        { id: 'a-old', subject: { type: 'user', id: 'u' }, role: 'admin', scope: { type: 'project', id: 'p1' }, expiresAt: new Date(Date.now() - 3_600_000), source: 'db' },
      ]),
      log: { warn: () => undefined },
    });
    await model.init(fakeModelInitContext({ model: 'rbac', permissions }));
    const rbac = new RbacService(model);

    expect(await heldRoles(rbac, 'root', userPrincipal('t'))).to.deep.equal(['admin']);
    expect(await heldRoles(rbac, 'root', userPrincipal('u'))).to.deep.equal([]);
  });
});
