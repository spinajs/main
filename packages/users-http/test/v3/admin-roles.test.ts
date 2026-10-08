import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { DefaultQueueService } from '@spinajs/queue';
import { Ok } from '@spinajs/http';
import { Forbidden, InvalidArgument } from '@spinajs/exceptions';
import { FilterableLogicalOperators, IFilterRequest } from '@spinajs/orm-http';
import { User } from '@spinajs/users';
import { SYSTEM, UNATTENDED } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';

import { TestPasswordService, passwordCalls, resetPasswordCalls } from '../support/password-service.js';
import { globalRolesOf, seedRoles, unseedRoles } from '../support/authz-host.js';
import { ADMIN2_UUID, ADMIN_UUID, AdminWorld, INACTIVE_UUID, USER_UUID, bootAdminWorld, byUuid, principalOf, registerAdminWorld, signedInPrincipalOf } from '../support/admin-world.js';

/**
 * Role changes of the admin user routes go through AuthzAdmin with the caller as actor, so authz-rbac's
 * DefaultAdminGuard decides escalation, non-assignable roles, self lockout and the last holder (B26, B43).
 */

const body = async <T = any>(r: any): Promise<T> => {
  const data = r.responseData;
  return Array.isArray(data) ? ((await Promise.all(data)) as any) : await data;
};
const headers = (r: any) => (r.options?.Headers ?? []) as Array<{ Name: string; Value: any }>;
const filterReq = (Column: string, Operator: string, Value: any): IFilterRequest => ({ filters: [{ Column, Operator, Value }], op: FilterableLogicalOperators.And }) as any;
const logins = async (r: any) => (await body<any[]>(r)).map((u: any) => u.Login).sort();

describe('users-http v3: role changes through AuthzAdmin', function () {
  this.timeout(25000);

  let world: AdminWorld;

  before(() => {
    registerAdminWorld();
  });

  beforeEach(async () => {
    world = await bootAdminWorld();
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));
    resetPasswordCalls();
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  const admin = () => signedInPrincipalOf(ADMIN_UUID);
  const config = () => DI.get(Configuration)!;

  describe('Users.list role filter', () => {
    beforeEach(async () => {
      const multi = new User({ Email: 'multi@spinajs.pl', Login: 'multi', Password: 'x', IsActive: true });
      await multi.insert();
      await seedRoles(multi.Uuid, ['guest', 'scoped-admin']);
    });

    it('filters by holding any of several roles, from the GLOBAL assignments', async () => {
      expect(await logins(await world.users.list(await admin(), undefined, undefined, undefined, filterReq('Role', 'in-set', ['admin'])))).to.deep.eq(['admin', 'admin2']);

      const either = await world.users.list(await admin(), undefined, undefined, undefined, filterReq('Role', 'in-set', ['scoped-admin', 'user']));
      expect(await logins(either)).to.deep.eq(['inactive', 'multi', 'user']);
      expect(headers(either).find((h) => h.Name === 'X-Total-Count')!.Value).to.eq(3);
    });

    it('filters by one role and by its absence', async () => {
      expect(await logins(await world.users.list(await admin(), undefined, undefined, undefined, filterReq('Role', 'eq', 'admin')))).to.deep.eq(['admin', 'admin2']);
      expect(await logins(await world.users.list(await admin(), undefined, undefined, undefined, filterReq('Role', 'neq', 'admin')))).to.deep.eq(['inactive', 'multi', 'user']);
      expect(await logins(await world.users.list(await admin(), undefined, undefined, undefined, filterReq('Role', 'nin-set', ['admin', 'user'])))).to.deep.eq(['multi']);
    });

    it('stops listing a holder once the role is revoked', async () => {
      await unseedRoles(ADMIN2_UUID, ['admin']);

      expect(await logins(await world.users.list(await admin(), undefined, undefined, undefined, filterReq('Role', 'in-set', ['admin'])))).to.deep.eq(['admin']);
    });

    it('cannot sort by Role any more', async () => {
      await expect(world.users.list(await admin(), undefined, { column: 'Role' } as any)).to.be.rejectedWith(InvalidArgument, /Cannot sort by/);
    });
  });

  describe('Users.addUser', () => {
    it('refuses the whole list when one role is refused, and creates nothing', async () => {
      await expect(world.users.addUser(await admin(), { Login: 'partly', Email: 'partly@spinajs.pl', Role: ['user', 'superadmin'] } as any)).to.be.rejectedWith(Forbidden, /superadmin/);

      expect(await User.query().whereLogin('partly').first()).to.not.exist;
    });

    it('answers an unknown role with InvalidArgument and creates nothing', async () => {
      await expect(world.users.addUser(await admin(), { Login: 'nosuchrole', Email: 'nosuchrole@spinajs.pl', Role: 'wizard' } as any)).to.be.rejectedWith(InvalidArgument);

      expect(await User.query().whereLogin('nosuchrole').first()).to.not.exist;
    });

    it('answers a role that grants more than the caller holds with Forbidden', async () => {
      await expect(world.users.addUser(await admin(), { Login: 'wannabe', Email: 'wannabe@spinajs.pl', Role: 'superadmin' } as any)).to.be.rejectedWith(Forbidden, /escalation|may not grant/);

      expect(await User.query().whereLogin('wannabe').first()).to.not.exist;
    });

    it('refuses the system role, which is not assignable', async () => {
      await expect(world.users.addUser(await admin(), { Login: 'sys', Email: 'sys@spinajs.pl', Role: 'system' } as any)).to.be.rejectedWith(InvalidArgument);

      expect(await User.query().whereLogin('sys').first()).to.not.exist;
    });

    it('grants as the caller: a caller who may create users but not manage assignments creates nothing', async () => {
      await seedRoles(USER_UUID, ['clerk']);

      await expect(world.users.addUser(await principalOf(USER_UUID), { Login: 'byuser', Email: 'byuser@spinajs.pl', Role: 'user' } as any)).to.be.rejectedWith(Forbidden);

      expect(await User.query().whereLogin('byuser').first()).to.not.exist;
    });

    it('refuses a request without a caller instead of acting as SYSTEM', async () => {
      await expect(world.users.addUser(undefined as any, { Login: 'nobody', Email: 'nobody@spinajs.pl', Role: 'user' } as any)).to.be.rejectedWith(Forbidden);

      expect(await User.query().whereLogin('nobody').first()).to.not.exist;
    });

    it('refuses SYSTEM, UNATTENDED, a service, an agent and an unauthenticated user as the actor, and creates nothing', async () => {
      const me = await admin();
      const actors: Principal[] = [
        SYSTEM,
        UNATTENDED,
        { type: 'service', id: 'svc', authenticated: true, source: 'service', attributes: {} },
        { type: 'agent', id: 'agent-1', authenticated: true, source: 'token', attributes: {}, onBehalfOf: me, delegation: 'inherit' },
        { ...me, authenticated: false },
      ];

      for (const actor of actors) {
        await expect(world.users.addUser(actor, { Login: 'notauser', Email: 'notauser@spinajs.pl', Role: 'user' } as any), `${actor.type}`).to.be.rejectedWith(Forbidden);
      }
      expect(await User.query().whereLogin('notauser').first()).to.not.exist;
    });

    it('hands the account over through an invite sent for the caller', async () => {
      await world.users.addUser(await admin(), { Login: 'handover', Email: 'handover@spinajs.pl', Role: 'user' } as any);

      const created = await User.query().whereLogin('handover').firstOrFail();
      const invite = passwordCalls.find((c) => c.method === 'invite');
      expect(invite?.id).to.deep.eq({ type: 'user', id: created.Uuid });
      expect(invite?.actor).to.deep.eq({ type: 'user', id: ADMIN_UUID });
    });

    it('answers 200 with the created account when a step after the grants failed', async () => {
      sinon.stub(TestPasswordService.prototype, 'invite').rejects(new Error('mailer down'));

      const result = await world.users.addUser(await admin(), { Login: 'halfway', Email: 'halfway@spinajs.pl', Role: 'user' } as any);
      expect(result).to.be.instanceOf(Ok);

      const data = await body<any>(result);
      const created = await User.query().whereLogin('halfway').firstOrFail();
      expect(data.Uuid).to.eq(created.Uuid);
      expect(data.Login).to.eq('halfway');
      expect(data.Password).to.be.undefined;
      expect(data.Incomplete).to.deep.eq({ resendInvite: true });
      expect(await globalRolesOf(created.Uuid)).to.deep.eq(['user']);
    });
  });

  describe('Users.updateUser', () => {
    it('refuses the non-assignable system role on a replacement', async () => {
      await expect(world.users.updateUser(await admin(), USER_UUID, { Role: 'system' } as any)).to.be.rejectedWith(InvalidArgument);

      expect(await globalRolesOf(USER_UUID)).to.deep.eq(['user']);
    });

    it('refuses the whole replacement on one refused role and writes nothing, the login included', async () => {
      await expect(world.users.updateUser(await admin(), USER_UUID, { Login: 'renamed', Role: ['guest', 'superadmin'] } as any)).to.be.rejectedWith(Forbidden);

      expect((await byUuid(USER_UUID)).Login).to.eq('user');
      expect(await globalRolesOf(USER_UUID)).to.deep.eq(['user']);
    });

    it('answers an unknown role with InvalidArgument', async () => {
      await expect(world.users.updateUser(await admin(), USER_UUID, { Role: ['user', 'wizard'] } as any)).to.be.rejectedWith(InvalidArgument);

      expect(await globalRolesOf(USER_UUID)).to.deep.eq(['user']);
    });

    it('refuses to take the caller s own privileged role (self lockout)', async () => {
      await expect(world.users.updateUser(await admin(), ADMIN_UUID, { Role: ['user'] } as any)).to.be.rejectedWith(Forbidden);

      expect(await globalRolesOf(ADMIN_UUID)).to.deep.eq(['admin']);
    });

    // C1 regression: User.Role is gone, and the 2.x guard let the last admin lose `admin`.
    it('refuses to take admin from the last account holding it', async () => {
      await unseedRoles(ADMIN2_UUID, ['admin']);
      config().set('authz.admin.guard.preventSelfLockout', false);

      await expect(world.users.updateUser(await admin(), ADMIN_UUID, { Role: ['user'] } as any)).to.be.rejectedWith(Forbidden, /users:update/);

      expect(await globalRolesOf(ADMIN_UUID)).to.deep.eq(['admin']);
    });

    it('takes admin from an administrator while another one remains', async () => {
      await world.users.updateUser(await admin(), ADMIN2_UUID, { Role: ['user'] } as any);

      expect(await globalRolesOf(ADMIN2_UUID)).to.deep.eq(['user']);
    });

    it('refuses a reserved login on rename before any write', async () => {
      await expect(world.users.updateUser(await admin(), USER_UUID, { Login: '__system__', Role: ['guest'] } as any)).to.be.rejectedWith(InvalidArgument, /reserved/);

      expect((await byUuid(USER_UUID)).Login).to.eq('user');
      expect(await globalRolesOf(USER_UUID)).to.deep.eq(['user']);
    });

    it('refuses a request without a caller and writes nothing', async () => {
      await expect(world.users.updateUser(undefined as any, USER_UUID, { Login: 'nocaller', Role: ['guest'] } as any)).to.be.rejectedWith(Forbidden);

      expect((await byUuid(USER_UUID)).Login).to.eq('user');
      expect(await globalRolesOf(USER_UUID)).to.deep.eq(['user']);
    });

    it('leaves the roles alone when no Role is sent', async () => {
      await world.users.updateUser(await admin(), INACTIVE_UUID, { Login: 'stillinactive' } as any);

      expect(await globalRolesOf(INACTIVE_UUID)).to.deep.eq(['user']);
    });
  });

  describe('Users.assignableRoles', () => {
    it('lists exactly the roles the caller may grant', async () => {
      const roles = await body<string[]>(await world.users.assignableRoles(await admin()));

      expect(roles).to.have.members(['guest', 'user', 'scoped-admin', 'self-editor', 'role-manager', 'admin-editor', 'clerk', 'admin']);
    });

    it('offers a stronger caller the stronger role too', async () => {
      await seedRoles(ADMIN_UUID, ['superadmin']);

      const roles = await body<string[]>(await world.users.assignableRoles(await admin()));

      expect(roles).to.have.members(['guest', 'user', 'scoped-admin', 'self-editor', 'role-manager', 'admin-editor', 'clerk', 'admin', 'superadmin']);
    });

    it('refuses a request without a caller', async () => {
      await expect(world.users.assignableRoles(undefined as any)).to.be.rejectedWith(Forbidden);
    });

    it('offers nothing to a caller who may not manage assignments', async () => {
      const roles = await body<string[]>(await world.users.assignableRoles(await principalOf(USER_UUID)));

      expect(roles).to.deep.eq([]);
    });
  });
});
