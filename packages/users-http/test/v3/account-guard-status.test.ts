import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { DefaultQueueService } from '@spinajs/queue';
import { Ok } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';
import { principalKey } from '@spinajs/authz';
import type { Principal, PrincipalRef } from '@spinajs/authz';
import { AccountStatusSource } from '@spinajs/authz-rbac';
import { USER_COMMON_METADATA, User, UserAccountStatusSource } from '@spinajs/users';

import { resetPasswordCalls } from '../support/password-service.js';
import { globalRolesOf, seedRoles } from '../support/authz-host.js';
import { ADMIN2_UUID, ADMIN_UUID, AdminWorld, USER_UUID, bootAdminWorld, byUuid, principalOf, registerAdminWorld } from '../support/admin-world.js';

/**
 * AccountGuard counts a witness only when the registered AccountStatusSource answers exactly `true` for it, so an
 * administrator whose password is expired or whose invite is pending keeps no one else in service.
 */

const LAST_HOLDER = /no active account holding 'users:update'/;
// authn-local's EXPIRED_PASSWORD_MARKER; users-http does not depend on authn-local.
const EXPIRED_PASSWORD = '!expired';

describe('users-http v3: account guard witnesses come from the AccountStatusSource', function () {
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

  const admin = () => principalOf(ADMIN_UUID);
  /** USER may close accounts (users:delete) without being privileged (users:update). */
  const clerk = async () => {
    await seedRoles(USER_UUID, ['clerk']);
    return principalOf(USER_UUID);
  };
  /** USER as a third administrator, in service. */
  const thirdAdmin = async () => {
    await seedRoles(USER_UUID, ['admin']);
    return principalOf(USER_UUID);
  };

  const outOfService: Array<[string, (uuid: string) => Promise<unknown>]> = [
    ['an expired password', async (uuid) => User.update({ Password: EXPIRED_PASSWORD }).where({ Uuid: uuid })],
    [
      'a pending invite',
      async (uuid) => {
        const u = await byUuid(uuid);
        u.Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING] = true;
        await u.Metadata.sync();
      },
    ],
  ];

  const routes: Array<[string, (actor: Principal, target: string) => Promise<unknown>]> = [
    ['deactivate', (actor, target) => world.security.deactivateUser(actor, target)],
    ['ban', (actor, target) => world.security.banUser(actor, target, {} as any)],
    ['delete', (actor, target) => world.users.removeUser(actor, target)],
  ];

  async function expectInService(uuid: string): Promise<void> {
    const kept = await User.query().where('Uuid', uuid).populate('Metadata').first();
    expect(kept, 'the account must not be deleted').to.exist;
    expect(kept!.IsActive).to.eq(true);
    expect(kept!.IsBanned).to.eq(false);
  }

  for (const [state, takeOut] of outOfService) {
    describe(`the other administrator with ${state}`, () => {
      for (const [action, run] of routes) {
        it(`refuses to ${action} the last administrator in service`, async () => {
          await takeOut(ADMIN2_UUID);

          await expect(run(await clerk(), ADMIN_UUID)).to.be.rejectedWith(Forbidden, LAST_HOLDER);

          await expectInService(ADMIN_UUID);
        });

        it(`allows ${action} once another administrator is in service`, async () => {
          await takeOut(ADMIN2_UUID);

          const result = await run(await thirdAdmin(), ADMIN_UUID);

          expect(result).to.be.instanceOf(Ok);
        });
      }

      it('refuses to demote the last administrator in service', async () => {
        await takeOut(ADMIN2_UUID);
        await seedRoles(USER_UUID, ['role-manager', 'admin-editor']);

        await expect(world.users.updateUser(await principalOf(USER_UUID), ADMIN_UUID, { Role: ['user'] } as any)).to.be.rejectedWith(Forbidden, LAST_HOLDER);

        expect(await globalRolesOf(ADMIN_UUID)).to.deep.eq(['admin']);
      });

      it('demotes once another administrator is in service', async () => {
        await takeOut(ADMIN2_UUID);
        await seedRoles(USER_UUID, ['admin']);

        const result = await world.users.updateUser(await principalOf(USER_UUID), ADMIN_UUID, { Role: ['user'] } as any);

        expect(result).to.be.instanceOf(Ok);
        expect(await globalRolesOf(ADMIN_UUID)).to.deep.eq(['user']);
      });
    });
  }

  // The target's own privilege is read from its row (not deleted, active, not banned), not from the source: an
  // admin that can still come back through a password reset or an invite stays protected, and a failing source
  // cannot make the last admin look out of service.
  it('keeps an administrator with an expired password while no administrator is in service', async () => {
    await outOfService[0][1](ADMIN2_UUID);
    await outOfService[1][1](ADMIN_UUID);

    await expect(world.security.deactivateUser(await clerk(), ADMIN2_UUID)).to.be.rejectedWith(Forbidden, LAST_HOLDER);

    await expectInService(ADMIN2_UUID);
  });

  it('lets an administrator with an expired password go while another is in service', async () => {
    await outOfService[0][1](ADMIN2_UUID);

    const result = await world.security.deactivateUser(await admin(), ADMIN2_UUID);

    expect(result).to.be.instanceOf(Ok);
  });

  describe('a source that fails', () => {
    const answers: Array<[string, () => Promise<ReadonlyMap<string, boolean>>]> = [
      ['throws', () => Promise.reject(new Error('status store down'))],
      ['answers with no Map', () => Promise.resolve({ get: () => true } as unknown as ReadonlyMap<string, boolean>)],
      ['leaves the witness out', () => Promise.resolve(new Map<string, boolean>())],
      ['answers a truthy non-boolean', () => Promise.resolve(new Map<string, boolean>([[principalKey({ type: 'user', id: ADMIN_UUID }), 1 as unknown as boolean]]))],
    ];

    for (const [how, answer] of answers) {
      it(`refuses when it ${how}`, async () => {
        sinon.stub(UserAccountStatusSource.prototype, 'inService').callsFake(answer);

        await expect(world.security.deactivateUser(await admin(), ADMIN2_UUID)).to.be.rejectedWith(Forbidden, LAST_HOLDER);

        await expectInService(ADMIN2_UUID);
      });
    }
  });

  // The row checks stay a floor under an application's own source.
  it('does not count a deactivated administrator that the source calls in service', async () => {
    sinon.stub(UserAccountStatusSource.prototype, 'inService').callsFake(async (refs) => new Map(refs.map((r) => [principalKey(r), true])));
    await User.update({ IsActive: false }).where({ Uuid: ADMIN2_UUID });

    await expect(world.security.deactivateUser(await clerk(), ADMIN_UUID)).to.be.rejectedWith(Forbidden, LAST_HOLDER);

    await expectInService(ADMIN_UUID);
  });

  it('asks the source once for every candidate witness', async () => {
    await thirdAdmin();
    const inService = sinon.spy(UserAccountStatusSource.prototype, 'inService');

    await world.security.deactivateUser(await admin(), ADMIN2_UUID);

    expect(inService.callCount).to.eq(1);
    const asked = (inService.firstCall.args[0] as readonly PrincipalRef[]).map((r) => principalKey(r));
    expect(asked).to.include.members([principalKey({ type: 'user', id: ADMIN_UUID }), principalKey({ type: 'user', id: USER_UUID })]);
    expect(asked).not.to.include(principalKey({ type: 'user', id: ADMIN2_UUID }));
  });

  describe('without a registered AccountStatusSource', () => {
    beforeEach(() => {
      DI.unregister(UserAccountStatusSource);
    });

    afterEach(() => {
      DI.register(UserAccountStatusSource).as(AccountStatusSource);
    });

    it('counts no witness and refuses to take a privileged account out of service', async () => {
      await expect(world.security.deactivateUser(await admin(), ADMIN2_UUID)).to.be.rejectedWith(Forbidden, LAST_HOLDER);

      await expectInService(ADMIN2_UUID);
    });

    it('still lets an account without the privilege go', async () => {
      const result = await world.security.deactivateUser(await admin(), USER_UUID);

      expect(result).to.be.instanceOf(Ok);
    });
  });
});
