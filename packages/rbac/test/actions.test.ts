import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User, UserActivated, UserChanged, deactivate, UserDeactivated, create, UserCreated, deleteUser, UserDeleted, ban, USER_COMMON_METADATA, auth, UserLogged, UserBanned } from '../src/index.js';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { join, normalize, resolve } from 'path';
import { TestConfiguration } from './common.test.js';
import * as sinon from 'sinon';
import { expect } from 'chai';

import './migration/rbac.migration.js';
import { DefaultQueueService } from '@spinajs/queue';
import { activate } from '../src/actions.js';
import _ from 'lodash';
import { EmailSend } from '@spinajs/email';
import { UserMetadataChange } from '../src/events/UserMetadataChange.js';
import { DateTime } from 'luxon';
import { UserLoginFailed } from '../src/events/UserLoginFailed.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

describe('User model tests', function () {
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

  it('Should activate user', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve());

    let user = await User.query().whereAnything('test-notactive@spinajs.pl').firstOrFail();

    expect(user.IsActive).to.eq(false);
    await activate('test-notactive@spinajs.pl');

    user = await User.query().whereAnything('test-notactive@spinajs.pl').firstOrFail();

    expect(user.IsActive).to.eq(true);
    expect(eStub.callCount).to.eq(3);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserChanged);
    expect((eStub.args[1] as any)[0]).to.be.instanceOf(UserActivated);
    expect((eStub.args[2] as any)[0]).to.be.instanceOf(EmailSend);
  });

  it('Should not send event when user is already activated', async () => {
    expect(activate('test@spinajs.pl')).to.be.rejected;
  });

  it('Should deactivate user', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve());

    let user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(user.IsActive).to.eq(true);
    await deactivate('test@spinajs.pl');

    user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(user.IsActive).to.eq(false);
    expect(eStub.callCount).to.eq(3);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserChanged);
    expect((eStub.args[1] as any)[0]).to.be.instanceOf(UserDeactivated);
    expect((eStub.args[2] as any)[0]).to.be.instanceOf(EmailSend);
  });

  it('Should create user', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve());

    const { User: U, Password } = await create('test@wp.pl', 'test222', 'bbbb', ['admin']);

    const user = await User.query().whereAnything('test@wp.pl').firstOrFail();
    expect(user).to.be.not.null;
    expect(user.IsActive).to.eq(false);
    expect(user.Login).to.eq('test222');
    expect(user.Email).to.eq('test@wp.pl');
    expect(user.Role).to.include('admin');

    expect(eStub.callCount).to.eq(2);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserCreated);
    expect((eStub.args[1] as any)[0]).to.be.instanceOf(EmailSend);

    expect(U).to.be.instanceOf(User);
    expect(Password).to.be.not.null;
    expect(Password).to.be.a('string');
  });

  it('Shouldn create user with already existing email', async () => {
    await expect(create('test@spinajs.pl', 'test', 'bbbb', ['admin'])).to.be.rejected;
  });

  it('Shouldn create user with already existing login', async () => {
    await expect(create('dasda@wp.pl', 'test', 'bbbb', ['admin'])).to.be.rejected;
  });

  it('Should delete user', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve());

    let user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();

    expect(user).to.be.not.null;

    await deleteUser(user);

    user = await User.query().whereAnything('test@spinajs.pl').first();

    expect(user).to.be.not.null;
    expect(user.DeletedAt).to.be.not.null;

    expect(eStub.callCount).to.eq(2);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserDeleted);
    expect((eStub.args[1] as any)[0]).to.be.instanceOf(EmailSend);
  });

  it('Should ban user', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve());

    await ban('test@spinajs.pl', 'Banned by admin', 100);

    let user = await User.query().whereAnything('test@spinajs.pl').populate('Metadata').firstOrFail();

    expect(user).to.be.not.null;
    expect(user.IsBanned).to.be.true;

    expect(user.Metadata[USER_COMMON_METADATA.USER_BAN_IS_BANNED]).to.be.eq(true);
    expect(user.Metadata[USER_COMMON_METADATA.USER_BAN_REASON]).to.be.eq('Banned by admin');
    expect(user.Metadata[USER_COMMON_METADATA.USER_BAN_DURATION]).to.be.eq(100);
    expect(user.Metadata[USER_COMMON_METADATA.USER_BAN_START_DATE]).to.be.not.null;
    expect(user.Metadata[USER_COMMON_METADATA.USER_BAN_START_DATE]).to.be.instanceOf(DateTime);

    expect(eStub.callCount).to.eq(3);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserMetadataChange);
    expect((eStub.args[1] as any)[0]).to.be.instanceOf(UserBanned);
    expect((eStub.args[2] as any)[0]).to.be.instanceOf(EmailSend);
  });

  it('Should unban user', async () => {});

  it('Should change password', async () => {});

  it('Should grant role', async () => {});

  it('Should revoke role', async () => {});

  it('Should update user', async () => {});

  it('Should authenticate user', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve());

    const user = await auth('test@spinajs.pl', 'bbbb');

    expect(user).to.be.not.null;
    expect(eStub.callCount).to.eq(1);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserLogged);
  });

  it('Should not auth with invalid password', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve());

    await expect(auth('test@spinajs.pl', 'bbbbssss')).to.be.rejected;
    expect(eStub.callCount).to.eq(1);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserLoginFailed);

  });

  it('Should not auth with invalid login', async () => {
    await expect(auth('testssssss@spinajs.pl', 'bbbb')).to.be.rejected;
  });

  it('Should reject auth with banned user', async () => {

    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve());

    await expect(auth('test-banned@spinajs.pl', 'bbbb')).to.be.rejected;
    expect(eStub.callCount).to.eq(1);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserLoginFailed);
  });

  it('Should reject auth with not active user', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve());

    await expect(auth('test-notactive@spinajs.pl', 'bbbb')).to.be.rejected;
    expect(eStub.callCount).to.eq(1);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserLoginFailed);
  });


  it('Password change request ', async () => {});

  it('Password change after request', async () => {});

  it('Password change after request with wrong token', async () => {});

  it('Password change after request with expired token', async () => {});
});
