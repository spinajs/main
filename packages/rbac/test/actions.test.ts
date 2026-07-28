import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User, UserActivated, UserChanged, deactivate, UserDeactivated, create, UserCreated, deleteUser, UserDeleted, ban, unban, grant, revoke, changePassword, _user_update, passwordChangeRequest, confirmPasswordReset, passwordMatch, USER_COMMON_METADATA, login, UserLogged, UserBanned, UserUnbanned, UserPasswordChanged, UserPasswordChangeRequest, CreateMiddleware } from '../src/index.js';
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
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

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
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

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
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

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

  it('Should create user with metadata', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const { User: U, Password } = await create('meta@wp.pl', 'metameta', 'bbbb', ['admin'], undefined, {
      'user:niceName': 'Meta User',
      'user:locale': 'en',
    });

    const user = await User.query().whereAnything('meta@wp.pl').populate('Metadata').firstOrFail();
    expect(user).to.be.not.null;
    expect(user.IsActive).to.eq(false);
    expect(user.Login).to.eq('metameta');
    expect(user.Email).to.eq('meta@wp.pl');
    expect(user.Role).to.include('admin');

    expect(user.Metadata['user:niceName']).to.eq('Meta User');
    expect(user.Metadata['user:locale']).to.eq('en');

    expect(eStub.callCount).to.eq(3);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserMetadataChange);
    expect((eStub.args[1] as any)[0]).to.be.instanceOf(UserCreated);
    expect((eStub.args[2] as any)[0]).to.be.instanceOf(EmailSend);

    expect(U).to.be.instanceOf(User);
    expect(Password).to.be.not.null;
    expect(Password).to.be.a('string');
  });

  it('Should create user with beforeCreate and afterCreate middleware', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const beforeSpy = sinon.spy((u: User) => {
      u.IsActive = true;
      return u;
    });

    const afterSpy = sinon.spy(async (u: User) => {
      return u;
    });

    const config = DI.get(Configuration)!;
    config.set('rbac.actions.create.beforeCreate', [beforeSpy as CreateMiddleware]);
    config.set('rbac.actions.create.afterCreate', [afterSpy as CreateMiddleware]);

    const { User: U } = await create('middleware@wp.pl', 'middlewareuser', 'bbbb', ['admin']);

    const user = await User.query().whereAnything('middleware@wp.pl').firstOrFail();
    expect(user).to.be.not.null;

    // beforeCreate middleware set IsActive to true
    expect(user.IsActive).to.eq(true);
    expect(user.Login).to.eq('middlewareuser');

    expect(beforeSpy.calledOnce).to.be.true;
    expect(afterSpy.calledOnce).to.be.true;

    // beforeCreate is called before insert, afterCreate is called after insert
    expect(beforeSpy.calledBefore(afterSpy)).to.be.true;

    expect(U).to.be.instanceOf(User);

    // reset config
    config!.set('rbac.actions.create.beforeCreate', []);
    config!.set('rbac.actions.create.afterCreate', []);
  });

  // Regression: reading the create-middleware lists through `_cfg(path, [])`
  // ran them through `_non_nil()`, which rejects empty arrays. Since the
  // shipped config defaults both hooks to `[]`, EVERY user creation failed with
  // "rbac.actions.create.beforeCreate should not be null, undefined or empty".
  it('Should create user when create middleware lists are empty', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const config = DI.get(Configuration)!;
    config.set('rbac.actions.create.beforeCreate', []);
    config.set('rbac.actions.create.afterCreate', []);

    const { User: U } = await create('empty-mw@wp.pl', 'emptymw', 'bbbb', ['admin']);

    expect(U).to.be.instanceOf(User);
    const user = await User.query().whereAnything('empty-mw@wp.pl').firstOrFail();
    expect(user.Login).to.eq('emptymw');
  });

  // Regression: same root cause, but for apps that never declare `rbac.actions`
  // at all — the config lookup returns undefined and must be treated as
  // "no middleware", not as an error.
  it('Should create user when create middleware config is not declared at all', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const config = DI.get(Configuration)!;
    config.set('rbac.actions', undefined);

    const { User: U } = await create('no-mw@wp.pl', 'nomw', 'bbbb', ['admin']);

    expect(U).to.be.instanceOf(User);
    const user = await User.query().whereAnything('no-mw@wp.pl').firstOrFail();
    expect(user.Login).to.eq('nomw');
  });

  // Guards against a "fix" that ignores the config shape entirely: a non-array
  // value must not blow up the create chain either.
  it('Should ignore malformed (non array) create middleware config', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const config = DI.get(Configuration)!;
    config.set('rbac.actions.create.beforeCreate', 'not-a-list' as any);

    const { User: U } = await create('bad-mw@wp.pl', 'badmw', 'bbbb', ['admin']);

    expect(U).to.be.instanceOf(User);

    config.set('rbac.actions.create.beforeCreate', []);
  });

  it('Shouldn create user with already existing email', async () => {
    await expect(create('test@spinajs.pl', 'test', 'bbbb', ['admin'])).to.be.rejected;
  });

  it('Shouldn create user with already existing login', async () => {
    await expect(create('dasda@wp.pl', 'test', 'bbbb', ['admin'])).to.be.rejected;
  });

  it('Should delete user', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

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
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

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

  it('Should unban user', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await ban('test@spinajs.pl', 'Banned by admin', 100);

    let user = await User.query().whereAnything('test@spinajs.pl').populate('Metadata').firstOrFail();
    expect(user.IsBanned).to.be.true;

    eStub.resetHistory();

    await unban('test@spinajs.pl');

    user = await User.query().whereAnything('test@spinajs.pl').populate('Metadata').firstOrFail();

    // ban must actually be lifted, not just an in-memory no-op
    expect(user.IsBanned).to.be.false;
    expect(user.Metadata[USER_COMMON_METADATA.USER_BAN_IS_BANNED]).to.be.null;
    expect(user.Metadata[USER_COMMON_METADATA.USER_BAN_REASON]).to.be.null;
    expect(user.Metadata[USER_COMMON_METADATA.USER_BAN_DURATION]).to.be.null;
    expect(user.Metadata[USER_COMMON_METADATA.USER_BAN_START_DATE]).to.be.null;

    // UserUnbanned event emitted
    expect(eStub.args.some((a) => (a as any)[0] instanceof UserUnbanned)).to.be.true;
  });

  it('Should not unban a user that is not banned', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));
    await expect(unban('test-notactive@spinajs.pl')).to.be.rejected;
  });

  it('Should treat a ban as expired once its duration elapses', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await ban('test@spinajs.pl', 'temp', 100);

    const user = await User.query().whereAnything('test@spinajs.pl').populate('Metadata').firstOrFail();
    expect(user.IsBanned).to.be.true;

    // move the ban start date to 200s ago while duration is 100s -> expired
    user.Metadata[USER_COMMON_METADATA.USER_BAN_START_DATE] = DateTime.now().minus({ seconds: 200 });
    await user.Metadata.update();

    const reloaded = await User.query().whereAnything('test@spinajs.pl').populate('Metadata').firstOrFail();
    expect(reloaded.IsBanned).to.be.false;
  });

  it('Should change password', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const user = await User.query().whereAnything('test@spinajs.pl').populate('Metadata').firstOrFail();
    const oldHash = user.Password;

    await changePassword('newPass123')(user);

    const reloaded = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(reloaded.Password).to.not.eq(oldHash);

    const pwd = await DI.resolve(BasicPasswordProvider);
    expect(await pwd.verify(reloaded.Password, 'newPass123')).to.be.true;
    expect(eStub.args.some((a) => (a as any)[0] instanceof UserPasswordChanged)).to.be.true;
  });

  it('Should reject a password that does not meet requirements', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));
    const user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    // password rule requires at least 8 chars with a letter and a digit
    await expect(changePassword('short')(user)).to.be.rejected;
  });

  it('Should grant role', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const before = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(before.Role).to.not.include('editor');

    await grant('test@spinajs.pl', 'editor');

    const after = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(after.Role).to.include('editor');

    // granting the same role twice must not duplicate it
    await grant('test@spinajs.pl', 'editor');
    const again = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(again.Role.filter((r) => r === 'editor').length).to.eq(1);
  });

  it('Should revoke role', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await grant('test@spinajs.pl', 'editor');
    let user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(user.Role).to.include('editor');

    await revoke('test@spinajs.pl', 'editor');
    user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(user.Role).to.not.include('editor');
  });

  it('Should update user', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    await _user_update({ Login: 'updated-login' })(user);

    const reloaded = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(reloaded.Login).to.eq('updated-login');
  });

  it('Should authenticate user', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const user = await login('test@spinajs.pl', 'bbbb');

    expect(user).to.be.not.null;
    expect(eStub.callCount).to.eq(1);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserLogged);
  });

  it('Should not auth with invalid password', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await expect(login('test@spinajs.pl', 'bbbbssss')).to.be.rejected;
    expect(eStub.callCount).to.eq(1);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserLoginFailed);

  });

  it('Should not auth with invalid login', async () => {
    await expect(login('testssssss@spinajs.pl', 'bbbb')).to.be.rejected;
  });

  it('Should reject auth with banned user', async () => {

    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await expect(login('test-banned@spinajs.pl', 'bbbb')).to.be.rejected;
    expect(eStub.callCount).to.eq(1);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserLoginFailed);
  });

  it('Should reject auth with not active user', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await expect(login('test-notactive@spinajs.pl', 'bbbb')).to.be.rejected;
    expect(eStub.callCount).to.eq(1);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserLoginFailed);
  });


  it('Password change request ', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await passwordChangeRequest('test@spinajs.pl');

    const user = await User.query().whereAnything('test@spinajs.pl').populate('Metadata').firstOrFail();

    // a reset token, start date and wait time must be stored
    expect(user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN]).to.be.a('string');
    expect(user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_START_DATE]).to.be.not.null;
    // wait time must come from config (rbac.password.passwordResetWaitTime), not be undefined
    expect(user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_WAIT_TIME]).to.eq(60 * 60);

    expect(eStub.args.some((a) => (a as any)[0] instanceof UserPasswordChangeRequest)).to.be.true;
  });

  it('Password change after request', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await passwordChangeRequest('test@spinajs.pl');
    let user = await User.query().whereAnything('test@spinajs.pl').populate('Metadata').firstOrFail();
    const token = user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN];

    await confirmPasswordReset('test@spinajs.pl', 'brandNew123', token);

    user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    const pwd = await DI.resolve(BasicPasswordProvider);
    expect(await pwd.verify(user.Password, 'brandNew123')).to.be.true;
  });

  it('Password change after request with wrong token', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await passwordChangeRequest('test@spinajs.pl');

    await expect(confirmPasswordReset('test@spinajs.pl', 'brandNew123', 'not-the-token')).to.be.rejected;
  });

  it('Password change after request with expired token', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await passwordChangeRequest('test@spinajs.pl');
    const user = await User.query().whereAnything('test@spinajs.pl').populate('Metadata').firstOrFail();
    const token = user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN];

    // force the reset request to be older than the configured wait time
    user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_START_DATE] = DateTime.now().minus({ seconds: 2 * 60 * 60 });
    await user.Metadata.update();

    await expect(confirmPasswordReset('test@spinajs.pl', 'brandNew123', token)).to.be.rejected;
  });

  // Regression: `passwordMatch` used to read the user from the second argument
  // of a `_chain` step, but _chain forwards a single value — so the check threw
  // "Cannot read properties of undefined (reading 'Password')" for EVERY
  // password, and PATCH /user/password could never succeed.
  it('Should confirm a matching password', async () => {
    const user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();

    expect(await passwordMatch('bbbb')(user)).to.eq(true);
  });

  it('Should not confirm a wrong password', async () => {
    const user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();

    expect(await passwordMatch('not-the-password')(user)).to.eq(false);
  });
});
