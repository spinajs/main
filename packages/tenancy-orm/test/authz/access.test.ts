import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import { AuthzAdminFailure, SYSTEM, UNATTENDED } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { TenantUnavailable, admitTenant, tenantAccess, tenantRecord, tenantRegistry } from '@spinajs/tenancy';

import { AuthzTenantAccess, TENANT_ADMIN_ROLE, TENANT_MEMBER_ROLE, TENANT_OWNER_ROLE, tenantResource, tenantsOf } from '../../src/authz/index.js';
import { authzStack, grant, person } from './support/stack.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

describe('AuthzTenantAccess and tenantsOf', function () {
  this.timeout(60000);

  before(async () => {
    await authzStack();
  });

  it('lets a tenant.member of acme enter acme and no other tenant', async () => {
    const alice = person('alice');
    await grant(alice, TENANT_MEMBER_ROLE, tenantResource('acme'));
    const access = new AuthzTenantAccess();

    expect(await access.canEnter(alice, tenantRecord({ id: 'acme' }))).to.eq(true);
    expect(await access.canEnter(alice, tenantRecord({ id: 'globex' }))).to.eq(false);
  });

  it('is the access check of admitTenant once the bridge is imported, whatever the principal attributes say', async () => {
    const bob = person('bob', { tenants: ['globex'] });
    await grant(bob, TENANT_MEMBER_ROLE, tenantResource('acme'));

    expect(await tenantAccess()).to.be.instanceOf(AuthzTenantAccess);
    expect((await admitTenant('acme', bob)).id).to.eq('acme');
    await expect(admitTenant('globex', bob)).to.be.rejectedWith(TenantUnavailable).and.eventually.have.property('reason', 'forbidden');
  });

  it('refuses a principal that holds no tenant role, a forged system principal and UNATTENDED', async () => {
    const access = new AuthzTenantAccess();
    const acme = tenantRecord({ id: 'acme' });
    const forged = { ...SYSTEM };

    expect(await access.canEnter(person('nobody', { tenants: ['acme'] }), acme)).to.eq(false);
    expect(await access.canEnter(forged, acme)).to.eq(false);
    expect(await access.canEnter(UNATTENDED, acme)).to.eq(false);
    // SYSTEM is the platform principal: authz allows it everything, by identity only.
    expect(await access.canEnter(SYSTEM, acme)).to.eq(true);
  });

  it('lists the active tenants a principal may enter', async () => {
    const carol = person('carol');
    await grant(carol, TENANT_MEMBER_ROLE, tenantResource('acme'));
    await grant(carol, TENANT_MEMBER_ROLE, tenantResource('initech'));

    expect((await tenantsOf(carol)).map((t) => t.id)).to.deep.eq(['acme']);
    expect(await tenantsOf(person('stranger'))).to.deep.eq([]);
  });

  it('lists no tenant that is not active, even from a registry that ignores the state filter', async () => {
    const grace = person('grace');
    await grant(grace, TENANT_MEMBER_ROLE, tenantResource('acme'));
    await grant(grace, TENANT_MEMBER_ROLE, tenantResource('initech'));
    const registry = await tenantRegistry();
    const unfiltered = sinon.stub(registry, 'list').callsFake(() => registry.inner.list());

    try {
      expect((await tenantsOf(grace)).map((t) => t.id)).to.deep.eq(['acme']);
    } finally {
      unfiltered.restore();
    }
  });

  it('refuses, and never allows, when authz.orm.domain names a domain that does not exist', async () => {
    const alice = person('alice');
    await grant(alice, TENANT_MEMBER_ROLE, tenantResource('acme'));
    const cfg = DI.get(Configuration);
    if (!cfg) throw new Error('no Configuration');

    cfg.set(['authz', 'orm', 'domain'], 'nowhere');
    try {
      await expect(new AuthzTenantAccess().canEnter(alice, tenantRecord({ id: 'acme' }))).to.be.rejected;
      await expect(admitTenant('acme', alice)).to.be.rejected;
      await expect(tenantsOf(alice)).to.be.rejected;
    } finally {
      cfg.set(['authz', 'orm', 'domain'], 'root');
    }
    expect(await new AuthzTenantAccess().canEnter(alice, tenantRecord({ id: 'acme' }))).to.eq(true);
  });

  it('lets a tenant.admin add members of its own tenant and of no other', async () => {
    const admin = person('admin');
    const dave = person('dave');
    await grant(admin, TENANT_ADMIN_ROLE, tenantResource('acme'));

    await grant(dave, TENANT_MEMBER_ROLE, tenantResource('acme'), admin);
    expect(await new AuthzTenantAccess().canEnter(dave, tenantRecord({ id: 'acme' }))).to.eq(true);
    await expect(grant(dave, TENANT_MEMBER_ROLE, tenantResource('globex'), admin)).to.be.rejectedWith(AuthzAdminFailure, 'tenant:members.add on tenant:globex').and.eventually.have.property('code', 'forbidden');
  });

  it('lets a tenant.member of acme add nobody, and a tenant.admin of acme make nobody an owner', async () => {
    const member = person('member');
    const admin = person('admin');
    await grant(member, TENANT_MEMBER_ROLE, tenantResource('acme'));
    await grant(admin, TENANT_ADMIN_ROLE, tenantResource('acme'));

    await expect(grant(person('erin'), TENANT_MEMBER_ROLE, tenantResource('acme'), member)).to.be.rejectedWith(AuthzAdminFailure).and.eventually.have.property('code', 'forbidden');
    await expect(grant(person('frank'), TENANT_OWNER_ROLE, tenantResource('acme'), admin)).to.be.rejectedWith(AuthzAdminFailure).and.eventually.have.property('code', 'escalation');
  });
});
