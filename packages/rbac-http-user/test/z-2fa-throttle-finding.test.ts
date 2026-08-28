import 'mocha';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import sinon from 'sinon';

import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';

import { AuthProvider, BasicPasswordProvider, LoginAttemptsExceeded, PasswordProvider, SimpleDbAuthProvider, User, USER_COMMON_METADATA } from '@spinajs/rbac';

import { auth2Fa } from '../src/actions/2fa.js';
import { Default2FaToken } from '../src/2fa/Default2FaToken.js';
import { DbTestConfiguration } from './db-common.js';

chai.use(chaiAsPromised);

/**
 * Regression for finding R2 ( fixed ): auth2Fa() counts failed codes into the
 * same lockout metadata the password throttle uses, and refuses a locked
 * account before the code is even checked.
 */
describe('2fa throttling ( finding R2 )', function () {
  this.timeout(25000);

  const USER_UUID = '88888888-2222-4222-8222-888888888888';

  before(() => {
    DI.setESMModuleSupport();
  });

  beforeEach(async () => {
    DI.clearCache();

    DI.register(DbTestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration);
    await DI.resolve(Orm);

    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    // the password itself is never checked by auth2Fa, so a placeholder hash
    // keeps this harness independent of the password provider
    const user = new User({
      Uuid: USER_UUID,
      Email: 'twofa-throttle@spinajs.pl',
      Login: 'twofa-throttle',
      Password: 'placeholder-hash',
      Role: ['user'],
      IsActive: true,
    });
    await user.insert();
  });

  afterEach(async () => {
    sinon.restore();
    DI.clearCache();
  });

  it('R2: repeated wrong 2fa codes lock the account like failed logins do', async () => {
    sinon.stub(Default2FaToken.prototype, 'verifyToken').returns(Promise.resolve(false));

    // rbac.password.blockAfterAttempts defaults to 5
    for (let i = 0; i < 5; i++) {
      await expect(auth2Fa(USER_UUID, '000000')).to.be.rejected;
    }

    const u = await User.where('Uuid', USER_UUID).populate('Metadata').firstOrFail();
    expect(u.Metadata[USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL], 'a lock instant must be recorded').to.not.be.undefined;

    // locked: refused before verification, with the throttle error
    await expect(auth2Fa(USER_UUID, '000000')).to.be.rejectedWith(LoginAttemptsExceeded);
  });

  it('R2: a successful 2fa check clears the failure counter', async () => {
    const verifyStub = sinon.stub(Default2FaToken.prototype, 'verifyToken');
    verifyStub.onFirstCall().returns(Promise.resolve(false));
    verifyStub.returns(Promise.resolve(true));

    await expect(auth2Fa(USER_UUID, '000000')).to.be.rejected;

    let u = await User.where('Uuid', USER_UUID).populate('Metadata').firstOrFail();
    expect(Number(u.Metadata[USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS])).to.eq(1);

    await auth2Fa(USER_UUID, '123456');

    u = await User.where('Uuid', USER_UUID).populate('Metadata').firstOrFail();
    expect(u.Metadata[USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS] ?? null).to.be.null;
  });
});
