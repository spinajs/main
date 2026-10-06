import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { DefaultQueueService } from '@spinajs/queue';
import { Ok } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';
import { AuthzConfigError, AuthzService, SYSTEM } from '@spinajs/authz';
import { User, ban } from '@spinajs/users';

import { passwordCalls, resetPasswordCalls } from '../support/password-service.js';
import { globalRolesOf, seedRoles, unseedRoles } from '../support/authz-host.js';
import { ADMIN2_UUID, ADMIN_UUID, AdminWorld, USER_UUID, bootAdminWorld, byUuid, registerAdminWorld } from '../support/admin-world.js';

/**
 * The lifecycle routes that take an account out of service (delete, deactivate, ban, expire password) are
 * not AuthzAdmin commands, so AccountGuard applies the self-lockout and last-privileged-holder rules of
 * `authz.admin.guard` to them.
 */

const LAST_HOLDER = /no active account holding 'users:update'/;

describe('users-http v3: account guard on the lifecycle routes', function () {
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

  const admin = () => byUuid(ADMIN_UUID);
  const admin2 = () => byUuid(ADMIN2_UUID);
  const config = () => DI.get(Configuration)!;

  /** Every route the guard covers, run by `actor` against `target`. */
  const routes: Array<[string, (actor: User, target: User) => Promise<unknown>]> = [
    ['deactivate', (actor, target) => world.security.deactivateUser(actor, target)],
    ['ban', (actor, target) => world.security.banUser(actor, target, {} as any)],
    ['delete', (actor, target) => world.users.removeUser(actor, target)],
    ['expire the password of', (actor, target) => world.security.expireUserPassword(actor, target)],
  ];

  /** Leaves `admin` as the only account holding `admin`; admin2 keeps an account with `user`. */
  async function demoteSecondAdmin(): Promise<void> {
    await unseedRoles(ADMIN2_UUID, ['admin']);
    await seedRoles(ADMIN2_UUID, ['user']);
  }

  for (const [action, run] of routes) {
    describe(action, () => {
      it('refuses to take the last privileged account out of service', async () => {
        await demoteSecondAdmin();

        await expect(run(await admin2(), await admin())).to.be.rejectedWith(Forbidden, LAST_HOLDER);

        const kept = await User.query().where('Uuid', ADMIN_UUID).populate('Metadata').first();
        expect(kept, 'the last admin must not be deleted').to.exist;
        expect(kept!.IsActive).to.eq(true);
        expect(kept!.IsBanned).to.eq(false);
      });

      it('allows it while another active administrator remains', async () => {
        const result = await run(await admin(), await admin2());

        expect(result).to.be.instanceOf(Ok);
      });

      it('refuses the caller s own account', async () => {
        await expect(run(await admin(), await admin())).to.be.rejectedWith(Forbidden, new RegExp(`Cannot ${action} your own account`));
      });

      it('allows the caller s own account with preventSelfLockout off', async () => {
        config().set('authz.admin.guard.preventSelfLockout', false);

        const result = await run(await admin(), await admin());

        expect(result).to.be.instanceOf(Ok);
      });
    });
  }

  it('fails closed when a check is on but no privilegedPermission is configured', async () => {
    config().set('authz.admin.guard', { service: 'DefaultAdminGuard' });
    await expect(world.security.deactivateUser(await admin2(), await admin())).to.be.rejectedWith(AuthzConfigError, /authz.admin.guard.privilegedPermission/);
  });

  it('keeps a check on for a non-boolean switch value', async () => {
    config().set('authz.admin.guard.preventSelfLockout', 0);
    await expect(world.security.deactivateUser(await admin(), await admin())).to.be.rejectedWith(Forbidden, /your own account/);
  });

  it('does not count an inactive administrator as the remaining one', async () => {
    await User.update({ IsActive: false }).where({ Uuid: ADMIN2_UUID });

    await expect(world.security.deactivateUser(await byUuid(USER_UUID), await admin())).to.be.rejectedWith(Forbidden, LAST_HOLDER);
  });

  it('does not count a banned administrator as the remaining one', async () => {
    await ban(await admin2(), 'test', 3600);

    await expect(world.security.banUser(await byUuid(USER_UUID), await admin(), {} as any)).to.be.rejectedWith(Forbidden, LAST_HOLDER);
  });

  it('does not count a deleted administrator as the remaining one', async () => {
    await (await admin2()).destroy();

    await expect(world.users.removeUser(await byUuid(USER_UUID), await admin())).to.be.rejectedWith(Forbidden, LAST_HOLDER);
  });

  it('counts an administrator privileged through a role the target does not hold', async () => {
    await unseedRoles(ADMIN2_UUID, ['admin']);
    await seedRoles(ADMIN2_UUID, ['superadmin']);

    const result = await world.security.deactivateUser(await admin2(), await admin());

    expect(result).to.be.instanceOf(Ok);
  });

  it('reads the target and the witnesses as SYSTEM', async () => {
    const authz = (await DI.resolve(AuthzService)) as AuthzService;
    const runAs = sinon.spy(authz, 'runAs');

    await world.security.deactivateUser(await admin(), await admin2());

    expect(runAs.calledWith(SYSTEM, 'users-http-account-guard')).to.eq(true);
  });

  it('does not count a conditional grant of the privilege as holding it', async () => {
    await unseedRoles(ADMIN2_UUID, ['admin']);
    await unseedRoles(ADMIN_UUID, ['admin']);
    await seedRoles(USER_UUID, ['self-editor']);

    // Were self-editor's `users:update` on its own record privileged, nobody else holds it and this would be refused.
    const result = await world.security.deactivateUser(await admin(), await byUuid(USER_UUID));

    expect(result).to.be.instanceOf(Ok);
  });

  it('lets an account without the privilege go even when it is the last of its kind', async () => {
    const result = await world.security.deactivateUser(await admin(), await byUuid(USER_UUID));

    expect(result).to.be.instanceOf(Ok);
  });

  it('allows the last privileged account to go with preventLastPrivilegedRemoval off', async () => {
    await demoteSecondAdmin();
    config().set('authz.admin.guard.preventLastPrivilegedRemoval', false);

    const result = await world.security.deactivateUser(await admin2(), await admin());

    expect(result).to.be.instanceOf(Ok);
  });

  it('expires the password for the caller, not as SYSTEM', async () => {
    await world.security.expireUserPassword(await admin(), await byUuid(USER_UUID));

    const expire = passwordCalls.find((c) => c.method === 'expire');
    expect(expire?.id).to.deep.eq({ type: 'user', id: USER_UUID });
    expect(expire?.actor).to.deep.eq({ type: 'user', id: ADMIN_UUID });
  });

  it('refuses a request without a caller', async () => {
    await expect(world.security.deactivateUser(undefined as any, await byUuid(USER_UUID))).to.be.rejectedWith(Forbidden);

    expect((await byUuid(USER_UUID)).IsActive).to.eq(true);
  });

  // AuthzAdmin's own last-holder rule counts every GLOBAL holder, out-of-service accounts included.
  describe('role replacement (PATCH)', () => {
    /** USER may manage assignments but does not hold `users:update`. */
    async function manager(): Promise<User> {
      await seedRoles(USER_UUID, ['role-manager']);
      return byUuid(USER_UUID);
    }

    const outOfService: Array<[string, () => Promise<unknown>]> = [
      ['deactivated', async () => User.update({ IsActive: false }).where({ Uuid: ADMIN2_UUID })],
      ['soft-deleted', async () => (await admin2()).destroy()],
      ['banned', async () => ban(await admin2(), 'test', 3600)],
    ];

    for (const [state, takeOut] of outOfService) {
      it(`refuses to take admin from the last active administrator, the other one ${state}`, async () => {
        await takeOut();

        await expect(world.users.updateUser(await manager(), await admin(), { Role: ['user'] } as any)).to.be.rejectedWith(Forbidden, LAST_HOLDER);

        expect(await globalRolesOf(ADMIN_UUID)).to.deep.eq(['admin']);
      });
    }

    it('takes admin while another active administrator remains', async () => {
      const result = await world.users.updateUser(await manager(), await admin(), { Role: ['user'] } as any);

      expect(result).to.be.instanceOf(Ok);
      expect(await globalRolesOf(ADMIN_UUID)).to.deep.eq(['user']);
    });

    it('takes a role while a kept role still gives the privilege', async () => {
      await seedRoles(ADMIN_UUID, ['superadmin']);
      await User.update({ IsActive: false }).where({ Uuid: ADMIN2_UUID });

      await world.users.updateUser(await manager(), await admin(), { Role: ['superadmin'] } as any);

      expect(await globalRolesOf(ADMIN_UUID)).to.deep.eq(['superadmin']);
    });

    it('refuses an administrator removing its own privilege', async () => {
      await expect(world.users.updateUser(await admin(), await admin(), { Role: ['user'] } as any)).to.be.rejectedWith(Forbidden, /your own account/);

      expect(await globalRolesOf(ADMIN_UUID)).to.deep.eq(['admin']);
    });

    it('refuses the last active administrator demoting itself with preventSelfLockout off', async () => {
      config().set('authz.admin.guard.preventSelfLockout', false);
      await User.update({ IsActive: false }).where({ Uuid: ADMIN2_UUID });

      await expect(world.users.updateUser(await admin(), await admin(), { Role: ['user'] } as any)).to.be.rejectedWith(Forbidden, LAST_HOLDER);

      expect(await globalRolesOf(ADMIN_UUID)).to.deep.eq(['admin']);
    });
  });
});
