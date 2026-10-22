import 'mocha';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { DefaultQueueService } from '@spinajs/queue';
import { ActionHook, ActionRefused } from '@spinajs/hooks';
import type { Principal } from '@spinajs/authz';
import type { User } from '@spinajs/users';
import { ban, deactivate, deleteUser } from '@spinajs/users';

import { ACCOUNT_DISABLE_HOOK_ORDER, AccountDisableHook, AccountGuard, DefaultAccountGuard } from '../../src/index.js';
import { unseedRoles, seedRoles } from '../support/authz-host.js';
import { ADMIN2_UUID, ADMIN_UUID, byUuid, bootAdminWorld, principalOf, registerAdminWorld } from '../support/admin-world.js';
import { ownedCache } from '../support/owned-cache.js';

chai.use(chaiAsPromised);

const LAST_HOLDER = "it would leave no account in service holding 'users:update'";

/** The refusal `work` throws. */
async function refusalOf(work: Promise<unknown>): Promise<ActionRefused> {
  try {
    await work;
  } catch (err) {
    expect(err).to.be.instanceOf(ActionRefused);
    return err as ActionRefused;
  }
  throw new Error('expected a refusal');
}

/**
 * The account guard of the lifecycle actions is a before hook on users.deactivate, users.ban and users.delete
 * (AccountDisableHook): it judges the actor the action is given, whoever calls it, and leaves an action run as SYSTEM
 * alone.
 */
describe('users-http v3: AccountDisableHook on the users lifecycle actions', function () {
  this.timeout(25000);

  const owned = ownedCache();

  before(() => {
    registerAdminWorld();
    owned.begin();
  });

  after(() => {
    owned.reset();
  });

  beforeEach(async () => {
    await bootAdminWorld();
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));
  });

  afterEach(() => {
    sinon.restore();
    owned.reset();
  });

  /** Leaves ADMIN as the only account holding `admin`. */
  async function lastAdmin(): Promise<void> {
    await unseedRoles(ADMIN2_UUID, ['admin']);
    await seedRoles(ADMIN2_UUID, ['user', 'clerk']);
  }

  const actions: Array<[string, string, (target: User, actor?: Principal) => Promise<unknown>]> = [
    ['users.deactivate', 'deactivate', (target, actor) => deactivate(target, actor)],
    ['users.ban', 'ban', (target, actor) => ban(target, 'test', 3600, actor)],
    ['users.delete', 'delete', (target, actor) => deleteUser(target, actor)],
  ];

  it('is registered as an ActionHook on the three actions, before the hooks of the default order', () => {
    expect(DI.RootContainer.getRegisteredTypes(ActionHook) ?? []).to.include(AccountDisableHook);
    const hook = new AccountDisableHook();
    expect([...hook.actions]).to.deep.eq(['users.deactivate', 'users.ban', 'users.delete']);
    expect(hook.order).to.eq(ACCOUNT_DISABLE_HOOK_ORDER);
    expect(hook.order).to.be.below(0);
  });

  for (const [action, verb, run] of actions) {
    describe(action, () => {
      it('refuses self_lockout for the actor itself, with the reason as the message, and changes nothing', async () => {
        const err = await refusalOf(run(await byUuid(ADMIN_UUID), await principalOf(ADMIN_UUID)));
        expect(err).to.include({ action, code: 'self_lockout', message: `Cannot ${verb} your own account` });

        const kept = await byUuid(ADMIN_UUID);
        expect(kept.IsActive).to.eq(true);
        expect(kept.IsBanned).to.eq(false);
      });

      it('refuses last_holder for the last account in service holding the privilege', async () => {
        await lastAdmin();
        const err = await refusalOf(run(await byUuid(ADMIN_UUID), await principalOf(ADMIN2_UUID)));
        expect(err).to.include({ action, code: 'last_holder' });
        expect(err.message).to.contain(LAST_HOLDER);
      });

      it('lets it through while another administrator remains in service', async () => {
        await run(await byUuid(ADMIN2_UUID), await principalOf(ADMIN_UUID));
      });

      it('does not judge an action run as SYSTEM, as the CLI runs it', async () => {
        await lastAdmin();
        await run(await byUuid(ADMIN_UUID));
      });
    });
  }

  it('AccountGuard no longer decides a disable: assertCanDisable is gone (D17), only the demotion is its own', () => {
    expect('assertCanDisable' in DefaultAccountGuard.prototype).to.eq(false);
    class OwnGuard extends AccountGuard {
      async assertCanDemote(): Promise<void> {}
      // @ts-expect-error the disable rule is AccountDisableHook's; an override would never be called
      async assertCanDisable(): Promise<void> {}
    }
    expect(OwnGuard).to.be.a('function');
  });
});
