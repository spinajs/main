import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User, UserChanged, USER_COMMON_METADATA } from '../src/index.js';
import { getUser, getUserUnsafe, getUsersByRole, setUserMeta, getUserMeta, updateUser, verifyPassword, roleList, assertNoProtectedMetadata, assertUserUnique, create, ban, passwordChangeRequest, confirmPasswordReset } from '../src/actions.js';
import { MetadataNotFound, TokenInvalid, UserAlreadyExists } from '../src/exceptions.js';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { join, normalize, resolve } from 'path';
import { TestConfiguration } from './common.test.js';
import * as sinon from 'sinon';
import { expect } from 'chai';

import './migration/rbac.migration.js';
import { DefaultQueueService } from '@spinajs/queue';
import { UserMetadataChange } from '../src/events/UserMetadataChange.js';
import { UserCreated } from '../src/events/UserCreated.js';
import { DateTime } from 'luxon';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

describe('actions fundamentals ( imperative helpers )', function () {
  this.timeout(15000);

  before(async () => {
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration, [null, null, [dir('./config')]]);
    await DI.resolve(Orm);
  });

  afterEach(async () => {
    sinon.restore();

    DI.clearCache();
  });

  describe('getUser / getUserUnsafe', () => {
    it('resolves a user by email with metadata populated', async () => {
      const u = await getUser('test@spinajs.pl');

      expect(u).to.be.instanceOf(User);
      expect(u.Email).to.eq('test@spinajs.pl');
      expect(u.Metadata).to.not.be.undefined;
    });

    it('returns a passed User instance as-is', async () => {
      const u = await getUser('test@spinajs.pl');
      const same = await getUser(u);

      expect(same).to.eq(u);
    });

    it('rejects for an unknown identifier', async () => {
      await expect(getUser('nobody@spinajs.pl')).to.be.rejected;
    });

    it('getUserUnsafe resolves any user through the base model', async () => {
      const u = await getUserUnsafe('test@spinajs.pl');

      expect(u.Email).to.eq('test@spinajs.pl');
    });
  });

  describe('roleList', () => {
    it('normalises a single role to a one-element list', () => {
      expect(roleList('admin')).to.deep.eq(['admin']);
    });

    it('trims, drops blanks and de-duplicates while preserving order', () => {
      expect(roleList([' admin ', 'user', 'admin', '  ', ''])).to.deep.eq(['admin', 'user']);
    });

    it('answers an empty list for nil input', () => {
      expect(roleList(undefined)).to.deep.eq([]);
      expect(roleList(null as any)).to.deep.eq([]);
    });
  });

  describe('assertNoProtectedMetadata', () => {
    it('passes benign keys and empty input', () => {
      expect(() => assertNoProtectedMetadata(undefined)).to.not.throw();
      expect(() => assertNoProtectedMetadata({ [USER_COMMON_METADATA.USER_PHONE]: '123' })).to.not.throw();
    });

    it('refuses protected security keys', () => {
      expect(() => assertNoProtectedMetadata({ [USER_COMMON_METADATA.USER_PWD_RESET_TOKEN]: 'planted' })).to.throw(InvalidArgument);
      expect(() => assertNoProtectedMetadata({ [USER_COMMON_METADATA.USER_BAN_IS_BANNED]: false })).to.throw(InvalidArgument);
    });

    it('refuses glob patterns that could rewrite protected entries', () => {
      expect(() => assertNoProtectedMetadata({ '*': 'x' })).to.throw(InvalidArgument);
      expect(() => assertNoProtectedMetadata({ 'user:?fa:token': 'x' })).to.throw(InvalidArgument);
    });
  });

  describe('assertUserUnique', () => {
    it('refuses a taken email and names the clashing field', async () => {
      const err = await assertUserUnique(undefined, 'test@spinajs.pl').catch((e) => e);

      expect(err).to.be.instanceOf(UserAlreadyExists);
      expect((err as UserAlreadyExists).data).to.deep.eq({ fields: ['Email'] });
    });

    it('lets an account keep its own values via exceptUserId', async () => {
      const u = await getUser('test@spinajs.pl');

      await expect(assertUserUnique(u.Login, u.Email, u.Id)).to.be.fulfilled;
    });

    it('passes for free values', async () => {
      await expect(assertUserUnique('free-login', 'free@spinajs.pl')).to.be.fulfilled;
    });
  });

  describe('setUserMeta / getUserMeta', () => {
    it('writes a single key-value pair and reads it back', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      const u = await getUser('test@spinajs.pl');
      await setUserMeta(u, USER_COMMON_METADATA.USER_PHONE, '555-1234');

      const fresh = await getUser(u.Uuid);
      expect(await getUserMeta(fresh, USER_COMMON_METADATA.USER_PHONE)).to.eq('555-1234');
    });

    it('writes an entry array in one call', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      const u = await getUser('test@spinajs.pl');
      await setUserMeta(u, [
        { key: USER_COMMON_METADATA.USER_PHONE, value: '1' },
        { key: USER_COMMON_METADATA.USER_NEWSLETTER_ENABLED, value: true },
      ]);

      const fresh = await getUser(u.Uuid);
      expect(await getUserMeta(fresh, USER_COMMON_METADATA.USER_PHONE)).to.eq('1');
    });

    // Pins the fix for the event-payload bug: `meta` used to receive the
    // mapping FUNCTION instead of the resolved entries, serializing garbage
    // into the queued event.
    it('emits UserMetadataChange carrying the resolved entries, not a function', async () => {
      const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      const u = await getUser('test@spinajs.pl');
      await setUserMeta(u, USER_COMMON_METADATA.USER_PHONE, '777');

      const evt = eStub.args.map((a) => a[0] as any).find((e) => e instanceof UserMetadataChange) as UserMetadataChange;
      expect(evt).to.not.be.undefined;
      expect(evt.meta).to.be.an('array');
      expect(evt.meta).to.deep.eq([{ key: USER_COMMON_METADATA.USER_PHONE, value: '777' }]);
    });

    it('getUserMeta throws MetadataNotFound for a missing key', async () => {
      const u = await getUser('test@spinajs.pl');

      await expect(getUserMeta(u, 'no:such:key')).to.be.rejectedWith(MetadataNotFound);
    });
  });

  describe('updateUser', () => {
    it('persists partial changes and emits UserChanged', async () => {
      const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      const u = await getUser('test@spinajs.pl');
      const stamp = DateTime.now();
      await updateUser(u, { LastLoginAt: stamp });

      const fresh = await getUser(u.Uuid);
      expect(fresh.LastLoginAt).to.not.be.undefined;
      expect(eStub.args.map((a) => a[0] as any).some((e) => e instanceof UserChanged)).to.eq(true);
    });
  });

  describe('verifyPassword', () => {
    it('confirms the stored password', async () => {
      const u = await getUser('test@spinajs.pl');

      expect(await verifyPassword(u, 'bbbb')).to.eq(true);
    });

    it('refuses a wrong password', async () => {
      const u = await getUser('test@spinajs.pl');

      expect(await verifyPassword(u, 'not-the-password')).to.eq(false);
    });
  });

  describe('getUsersByRole', () => {
    it('finds users carrying the role', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await create('byrole@spinajs.pl', 'byrole', ['admin'], { password: 'bbbb1234' });

      const users = await getUsersByRole(['admin']);
      expect(users.some((u) => u.Email === 'byrole@spinajs.pl')).to.eq(true);
    });
  });

  /**
   * ===============================================
   * REGRESSION TESTS for audit findings R1 / R3 / R6 ( fixed ).
   * ===============================================
   */

  describe('audit finding regressions', () => {
    // Regression for R1 ( fixed ): ban() now consults the duration-aware
    // IsBanned getter, so an expired ban no longer blocks re-banning.
    it('R1: ban() accepts a user whose previous ban has expired', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await ban('test@spinajs.pl', 'first', 10);

      // age the ban past its duration
      const u = await getUser('test@spinajs.pl');
      u.Metadata[USER_COMMON_METADATA.USER_BAN_START_DATE] = DateTime.now().minus({ hours: 1 });
      await u.Metadata.update();

      const fresh = await getUser('test@spinajs.pl');
      expect(fresh.IsBanned).to.eq(false);

      await expect(ban('test@spinajs.pl', 'second', 10)).to.be.fulfilled;
    });

    // Regression for R1 ( fixed, same root cause ): an expired ban no longer
    // blocks completing a password reset.
    it('R1: confirmPasswordReset() accepts a user whose ban has expired', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await ban('test@spinajs.pl', 'expired', 10);
      let u = await getUser('test@spinajs.pl');
      u.Metadata[USER_COMMON_METADATA.USER_BAN_START_DATE] = DateTime.now().minus({ hours: 1 });
      await u.Metadata.update();

      await passwordChangeRequest('test@spinajs.pl');
      u = await getUser('test@spinajs.pl');
      const token = u.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN] as string;

      await expect(confirmPasswordReset('test@spinajs.pl', 'brandNew123', token)).to.be.fulfilled;
    });

    // Regression for R3 ( fixed ): exception payloads carry the user uuid
    // only - never the stored reset token or the full model.
    it('R3: TokenInvalid does not leak the stored reset token', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await passwordChangeRequest('test@spinajs.pl');

      const err = await confirmPasswordReset('test@spinajs.pl', 'brandNew123', 'not-the-token').catch((e) => e);

      expect(err).to.be.instanceOf(TokenInvalid);
      const u = await getUser('test@spinajs.pl');
      expect((err as TokenInvalid).data).to.deep.eq({ user: u.Uuid });
    });

    // Regression for R6 ( fixed ): UserCreated now carries the account fields
    // it declares.
    it('R6: UserCreated carries the account fields it declares', async () => {
      const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await create('evt@spinajs.pl', 'evt-login', ['admin'], { password: 'bbbb1234' });

      const evt = eStub.args.map((a) => a[0] as any).find((e) => e instanceof UserCreated) as UserCreated;
      expect(evt).to.not.be.undefined;
      expect(evt.Email).to.eq('evt@spinajs.pl');
      expect(evt.Login).to.eq('evt-login');
    });
  });
});
