import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { randomUUID } from 'node:crypto';

import { DI } from '@spinajs/di';
import { DefaultQueueService } from '@spinajs/queue';
import { Ok } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';
import { GLOBAL, SYSTEM, principalKey } from '@spinajs/authz';
import type { AuthzCommand, Principal, PrincipalRef } from '@spinajs/authz';
import { AccountStatusSource, AssignmentStore } from '@spinajs/authz-rbac';
import { USER_COMMON_METADATA, User, UserAccountStatusSource } from '@spinajs/users';

import { resetPasswordCalls } from '../support/password-service.js';
import { globalRolesOf, rootAdmin, seedRoles } from '../support/authz-host.js';
import { ADMIN2_UUID, ADMIN_UUID, AdminWorld, INACTIVE_UUID, USER_UUID, bootAdminWorld, byUuid, principalOf, registerAdminWorld } from '../support/admin-world.js';

/**
 * AccountGuard counts a witness only when the registered AccountStatusSource answers exactly `true` for it, so an
 * administrator whose password is expired or whose invite is pending keeps no one else in service.
 */

const LAST_HOLDER = /no account in service holding 'users:update'/;
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

        await expect(world.users.updateUser(await principalOf(USER_UUID), ADMIN_UUID, { Role: ['user'] } as any, undefined as any)).to.be.rejectedWith(Forbidden, LAST_HOLDER);

        expect(await globalRolesOf(ADMIN_UUID)).to.deep.eq(['admin']);
      });

      it('demotes once another administrator is in service', async () => {
        await takeOut(ADMIN2_UUID);
        await seedRoles(USER_UUID, ['admin']);

        const result = await world.users.updateUser(await principalOf(USER_UUID), ADMIN_UUID, { Role: ['user'] } as any, undefined as any);

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

  // Under a source laxer than the row checks, this keeps the answer a 403. It does not guard against an allow:
  // without the row checks UserPrincipalFactory throws on the inactive witness and the route fails with a 500.
  it('does not count a deactivated administrator that the source calls in service', async () => {
    sinon.stub(UserAccountStatusSource.prototype, 'inService').callsFake(async (refs) => new Map(refs.map((r) => [principalKey(r), true])));
    await User.update({ IsActive: false }).where({ Uuid: ADMIN2_UUID });

    await expect(world.security.deactivateUser(await clerk(), ADMIN_UUID)).to.be.rejectedWith(Forbidden, LAST_HOLDER);

    await expectInService(ADMIN_UUID);
  });

  it('finds the administrator in service that the database returns after those out of service', async () => {
    // Uuids sorting before and after ADMIN2's, so the in-service one comes last in rowid and in Uuid order.
    const expired = ['00000000-0000-4000-8000-000000000000', '11111111-1111-4111-8111-111111111111'];
    for (const uuid of expired) {
      await new User({ Uuid: uuid, Email: `${uuid}@spinajs.pl`, Login: uuid, Password: EXPIRED_PASSWORD, IsActive: true }).insert();
      await seedRoles(uuid, ['admin']);
    }
    await outOfService[0][1](ADMIN2_UUID);
    const last = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await new User({ Uuid: last, Email: 'last@spinajs.pl', Login: 'last', Password: 'not-expired', IsActive: true }).insert();
    await seedRoles(last, ['admin']);

    const result = await world.security.deactivateUser(await clerk(), ADMIN_UUID);

    expect(result).to.be.instanceOf(Ok);
  });

  describe('the number of questions to the source', () => {
    const key = (id: string) => principalKey({ type: 'user', id });

    /** `count` accounts in service, each holding `role` at GLOBAL. */
    async function crowd(count: number, role: string): Promise<string[]> {
      const uuids = Array.from({ length: count }, () => randomUUID());
      for (const [i, uuid] of uuids.entries()) {
        await new User({ Uuid: uuid, Email: `crowd${i}@spinajs.pl`, Login: `crowd${i}`, Password: 'not-expired', IsActive: true }).insert();
      }
      const commands: AuthzCommand[] = uuids.map((id) => ({ kind: 'assignment.grant', subject: { type: 'user', id }, role, scope: GLOBAL }));
      for (let i = 0; i < commands.length; i += 100) {
        const results = await (await rootAdmin()).execute(SYSTEM, commands.slice(i, i + 100), { reason: 'test seed' });
        expect(results.every((r) => r.ok)).to.eq(true);
      }
      return uuids;
    }

    /** The user holders of `role` in the order the assignment store returns them, the target left out. */
    async function holders(role: string, target: string): Promise<string[]> {
      const store = (await DI.resolve(AssignmentStore)) as AssignmentStore;
      const all = await store.holders(role, GLOBAL, new Date());
      return all.filter((h): h is PrincipalRef => !('set' in h) && h.type === 'user' && h.id !== target).map((h) => h.id);
    }

    const calls = (spy: sinon.SinonSpy) => spy.getCalls().map((c) => (c.args[0] as readonly PrincipalRef[]).map((r) => principalKey(r)));

    function expectSlices(asked: string[][], target: string): void {
      for (const refs of asked) {
        expect(refs.length).to.be.within(1, 100);
        expect(refs).not.to.include(key(target));
      }
      const flat = asked.flat();
      expect(new Set(flat).size, 'no account is asked about twice').to.eq(flat.length);
    }

    it('asks about the holders of a role in one call and stops at the first privileged witness', async () => {
      await thirdAdmin();
      const inService = sinon.spy(UserAccountStatusSource.prototype, 'inService');

      const result = await world.security.deactivateUser(await admin(), ADMIN2_UUID);

      expect(result).to.be.instanceOf(Ok);
      // `user` comes before `admin` in the role list and USER holds both, so the `admin` holders are never asked about.
      expect(calls(inService)).to.deep.eq([[key(USER_UUID), key(INACTIVE_UUID)]]);
    });

    it('asks about one slice of a role with many holders', async () => {
      const crowded = await crowd(250, 'user');
      const firstSlice = new Set((await holders('user', ADMIN2_UUID)).slice(0, 100).map(key));
      const inService = sinon.spy(UserAccountStatusSource.prototype, 'inService');

      const result = await world.security.deactivateUser(await admin(), ADMIN2_UUID);

      expect(result).to.be.instanceOf(Ok);
      const asked = calls(inService);
      expectSlices(asked, ADMIN2_UUID);
      expect(asked).to.have.length(2);
      expect(asked[0].every((k) => firstSlice.has(k))).to.eq(true);
      expect(asked[1]).to.deep.eq([key(ADMIN_UUID)]);
      expect(crowded.filter((id) => asked.flat().includes(key(id))).length).to.be.at.most(100);
    });

    it('does not ask about a later slice once a witness is found', async () => {
      await crowd(150, 'admin');
      const order = await holders('admin', ADMIN2_UUID);
      const inService = sinon.spy(UserAccountStatusSource.prototype, 'inService');

      const result = await world.security.deactivateUser(await admin(), ADMIN2_UUID);

      expect(result).to.be.instanceOf(Ok);
      const asked = calls(inService);
      expectSlices(asked, ADMIN2_UUID);
      const later = new Set(order.slice(100).map(key));
      expect(asked.flat().filter((k) => later.has(k))).to.deep.eq([]);
    });

    it('asks about the next slice while no witness is found', async () => {
      await crowd(150, 'admin');
      const order = await holders('admin', ADMIN2_UUID);
      const later = new Set(order.slice(100).map(key));
      const inService = sinon.stub(UserAccountStatusSource.prototype, 'inService').callsFake(async (refs) => new Map(refs.map((r) => [principalKey(r), later.has(principalKey(r))])));

      const result = await world.security.deactivateUser(await admin(), ADMIN2_UUID);

      expect(result).to.be.instanceOf(Ok);
      const asked = calls(inService);
      expectSlices(asked, ADMIN2_UUID);
      expect(asked.flat().filter((k) => later.has(k)).length).to.be.greaterThan(0);
    });
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
