import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { DateTime } from 'luxon';
import { IdentityStore } from '@spinajs/authn/contracts';

import { USER_COMMON_METADATA, User, UserIdentityStore } from '../src/index.js';
import { TEST_USER_UUID, TEST_USER_UUID_3 } from './migration/rbac.migration.js';
import { bootUsersDb, registerUsersTestHost, seedUser } from './support/users-db.js';

const UNKNOWN = { exists: false, active: false, banned: false, deleted: false, invitePending: false };

describe('UserIdentityStore', function () {
  this.timeout(30000);

  let store: UserIdentityStore;

  before(() => {
    registerUsersTestHost();
  });

  beforeEach(async () => {
    await bootUsersDb();
    store = new UserIdentityStore();
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  it('is the registered IdentityStore and offers no provision (JIT is off)', async () => {
    expect(await DI.resolve(IdentityStore)).to.be.instanceOf(UserIdentityStore);
    expect(store.provision).to.eq(undefined);
  });

  describe('findByLogin', () => {
    it('finds a user by login and by email', async () => {
      expect(await store.findByLogin('test')).to.deep.eq({ type: 'user', id: TEST_USER_UUID });
      expect(await store.findByLogin('test@spinajs.pl')).to.deep.eq({ type: 'user', id: TEST_USER_UUID });
    });

    it('ignores case, surrounding spaces and what NFKC folds, like the throttle key', async () => {
      expect(await store.findByLogin('TEST@SpinaJS.pl')).to.deep.eq({ type: 'user', id: TEST_USER_UUID });
      expect(await store.findByLogin('  Test ')).to.deep.eq({ type: 'user', id: TEST_USER_UUID });
      expect(await store.findByLogin('ｔｅｓｔ')).to.deep.eq({ type: 'user', id: TEST_USER_UUID });
    });

    it('finds a mixed-case stored login from any case', async () => {
      const { ref } = await seedUser({ login: 'MixedCase', email: 'Mixed.Case@Example.test' });

      expect(await store.findByLogin('mixedcase')).to.deep.eq(ref);
      expect(await store.findByLogin('mixed.case@example.test')).to.deep.eq(ref);
    });

    it('prefers the account equal to the login as typed, and finds none when only case variants match', async () => {
      const { ref: upper } = await seedUser({ login: 'Twin' });
      const { ref: lower } = await seedUser({ login: 'twin' });

      expect(await store.findByLogin('Twin')).to.deep.eq(upper);
      expect(await store.findByLogin('twin')).to.deep.eq(lower);
      expect(await store.findByLogin('TWIN')).to.eq(null);
    });

    it('does not look a user up by Uuid or Id', async () => {
      const u = await User.query().where('Uuid', TEST_USER_UUID).firstOrFail();

      expect(await store.findByLogin(TEST_USER_UUID)).to.eq(null);
      expect(await store.findByLogin(String(u.Id))).to.eq(null);
    });

    it('finds a soft-deleted user, so status can say deleted', async () => {
      const ref = await store.findByLogin('test-deleted@spinajs.pl');

      expect(ref).to.not.eq(null);
      expect((await store.status(ref!)).deleted).to.eq(true);
    });

    it('answers null for an unknown, empty or non-string login', async () => {
      expect(await store.findByLogin('nobody@spinajs.pl')).to.eq(null);
      expect(await store.findByLogin('   ')).to.eq(null);
      expect(await store.findByLogin(undefined as unknown as string)).to.eq(null);
    });
  });

  describe('status', () => {
    it('reports an active user', async () => {
      expect(await store.status({ type: 'user', id: TEST_USER_UUID })).to.deep.eq({ exists: true, active: true, banned: false, deleted: false, invitePending: false });
    });

    it('reports a ban without start or duration as banned', async () => {
      expect((await store.status({ type: 'user', id: TEST_USER_UUID_3 })).banned).to.eq(true);
    });

    it('reports a ban whose duration has passed as not banned, like IsBanned', async () => {
      const { user, ref } = await seedUser({ login: 'banned-once' });
      user.Metadata[USER_COMMON_METADATA.USER_BAN_IS_BANNED] = true;
      user.Metadata[USER_COMMON_METADATA.USER_BAN_START_DATE] = DateTime.now().minus({ hours: 2 });
      user.Metadata[USER_COMMON_METADATA.USER_BAN_DURATION] = 60;
      await user.Metadata.update();

      expect((await store.status(ref)).banned).to.eq(false);
    });

    it('reports an inactive user', async () => {
      const ref = await store.findByLogin('test-notactive');

      expect(await store.status(ref!)).to.deep.include({ exists: true, active: false });
    });

    it('reports invitePending only for a stored boolean true', async () => {
      const { ref: pending } = await seedUser({ login: 'pending', active: false, invitePending: true });
      const { user, ref: text } = await seedUser({ login: 'pending-text', active: false });
      user.Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING] = 'true';
      await user.Metadata.update();

      expect(await store.status(pending)).to.deep.eq({ exists: true, active: false, banned: false, deleted: false, invitePending: true });
      expect((await store.status(text)).invitePending).to.eq(false);
    });

    it('reports an unknown Uuid or a non-user identity as not existing', async () => {
      expect(await store.status({ type: 'user', id: '00000000-0000-4000-8000-000000000000' })).to.deep.eq(UNKNOWN);
      expect(await store.status({ type: 'service', id: TEST_USER_UUID })).to.deep.eq(UNKNOWN);
    });
  });

  describe('display', () => {
    it('gives the email and the login as name', async () => {
      expect(await store.display({ type: 'user', id: TEST_USER_UUID })).to.deep.eq({ email: 'test@spinajs.pl', name: 'test' });
    });

    it('gives nothing for an unknown identity', async () => {
      expect(await store.display({ type: 'user', id: '00000000-0000-4000-8000-000000000000' })).to.deep.eq({});
    });
  });
});
