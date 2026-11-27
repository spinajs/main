import 'mocha';
import { expect } from 'chai';

import { TENANT_ADMIN_ROLE, TENANT_ENTER, TENANT_MEMBER_ROLE, TENANT_OWNER_ROLE, TENANT_TYPE, tenantResource } from '../../src/authz/index.js';
import tenancyAuthz from '../../src/config/tenancy-authz.js';

describe('the tenant authz fragment', () => {
  it('declares the four tenant permissions on the type tenant', () => {
    const permissions = tenancyAuthz.authz.permissions;
    expect(Object.keys(permissions).sort()).to.deep.eq(['tenant:enter', 'tenant:members.add', 'tenant:members.remove', 'tenant:settings.manage']);
    for (const def of Object.values(permissions)) expect(def.types).to.deep.eq([TENANT_TYPE]);
  });

  it('ships tenant.member, tenant.admin and tenant.owner on one ladder, assignable at a tenant only', () => {
    const { ladders, roles } = tenancyAuthz.authz.rbac;
    expect(ladders.tenant.roles).to.deep.eq([TENANT_MEMBER_ROLE, TENANT_ADMIN_ROLE, TENANT_OWNER_ROLE]);
    expect(roles['tenant.member']).to.deep.include({ subjectSet: true, grants: [TENANT_ENTER] });
    expect(roles['tenant.admin'].extends).to.deep.eq([TENANT_MEMBER_ROLE]);
    expect(roles['tenant.admin'].grants).to.deep.eq(['tenant:members.add', 'tenant:members.remove', 'tenant:settings.manage']);
    expect(roles['tenant.owner'].extends).to.deep.eq([TENANT_ADMIN_ROLE]);
    for (const role of Object.values(roles)) expect(role.scopeTypes).to.deep.eq([TENANT_TYPE]);
  });

  it('checks admin commands at a tenant with the tenant permissions and keeps an owner', () => {
    const { permissions, guard } = tenancyAuthz.authz.admin;
    expect(permissions['assignment.grant']).to.deep.eq({ tenant: 'tenant:members.add' });
    expect(permissions['assignment.*']).to.deep.eq({ tenant: 'tenant:members.remove' });
    expect(permissions['set.addMember']).to.deep.eq({ tenant: 'tenant:members.add' });
    expect(permissions['set.*']).to.deep.eq({ tenant: 'tenant:members.remove' });
    expect(permissions['scope.setAttributes']).to.deep.eq({ tenant: 'tenant:settings.manage' });
    expect(guard.keepHolders).to.deep.eq([{ role: TENANT_OWNER_ROLE, scopeType: TENANT_TYPE }]);
  });

  it('names a tenant as a resource of type tenant', () => {
    expect(tenantResource('acme')).to.deep.eq({ type: 'tenant', id: 'acme' });
  });
});
