import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User, UserActivated, UserChanged, deactivate, UserDeactivated, create, UserCreated, deleteUser, UserDeleted, ban, unban, grant, revoke, changePassword, _user_update, passwordChangeRequest, confirmPasswordReset, passwordMatch, USER_COMMON_METADATA, login, UserLogged, UserBanned, UserUnbanned, UserPasswordChanged, UserPasswordChangeRequest, CreateMiddleware, SessionProvider, UserSession } from '../src/index.js';
import { Configuration } from '@spinajs/configuration';
import { ErrorCode, InvalidArgument } from '@spinajs/exceptions';
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
import { E_CODES, expirePassword } from '../src/actions.js';
import { UserPasswordExpired } from '../src/events/UserPasswordExpired.js';

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

  it('activate resolves with the user, not the notification email result', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const u = await activate('test-notactive@spinajs.pl');
    expect(u).to.be.instanceOf(User);
  });

  it('deactivate resolves with the user, not the notification email result', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const u = await deactivate('test@spinajs.pl');
    expect(u).to.be.instanceOf(User);
  });

  it('ban resolves with the user, not the notification email result', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const u = await ban('test@spinajs.pl', 'reason', 100);
    expect(u).to.be.instanceOf(User);
  });

  it('expirePassword emits UserPasswordExpired carrying the user uuid', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await expirePassword('test@spinajs.pl');

    const ev = eStub.args.map((a) => a[0] as any).find((e) => e instanceof UserPasswordExpired);
    expect(ev).to.not.be.undefined;
    expect(ev!.UserUUID).to.be.a('string').that.is.not.empty;
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

    const { User: U, Password } = await create('test@wp.pl', 'test222', ['admin'], { password: 'bbbb1234' });

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

  /**
   * Regression: the model declared `RegisteredAt` and `create()` stamped it, but
   * the initial migration never created the column — and the ORM writes only
   * columns the table description reports, so the value was dropped silently on
   * every single insert.
   */
  it('Should persist the registration date of a created user', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await create('registered@wp.pl', 'registered', ['admin'], { password: 'bbbb1234' });

    // read back from the database, not from the in-memory model
    const user = await User.query().whereAnything('registered@wp.pl').firstOrFail();

    expect(user.RegisteredAt, 'RegisteredAt must survive the insert').to.be.not.null;
    expect(user.RegisteredAt.isValid).to.eq(true);
  });

  it('Should create user with metadata', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const { User: U, Password } = await create('meta@wp.pl', 'metameta', ['admin'], {
      password: 'bbbb1234',
      metadata: {
        'user:niceName': 'Meta User',
        'user:locale': 'en',
      },
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

    const { User: U } = await create('middleware@wp.pl', 'middlewareuser', ['admin'], { password: 'bbbb1234' });

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

    const { User: U } = await create('empty-mw@wp.pl', 'emptymw', ['admin'], { password: 'bbbb1234' });

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

    const { User: U } = await create('no-mw@wp.pl', 'nomw', ['admin'], { password: 'bbbb1234' });

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

    const { User: U } = await create('bad-mw@wp.pl', 'badmw', ['admin'], { password: 'bbbb1234' });

    expect(U).to.be.instanceOf(User);

    config.set('rbac.actions.create.beforeCreate', []);
  });

  it('Shouldn create user with already existing email', async () => {
    await expect(create('test@spinajs.pl', 'test', ['admin'], { password: 'bbbb1234' })).to.be.rejected;
  });

  it('Shouldn create user with already existing login', async () => {
    await expect(create('dasda@wp.pl', 'test', ['admin'], { password: 'bbbb1234' })).to.be.rejected;
  });

  /**
   * The refusal has to name WHICH field clashed, not only that something did —
   * an http caller marks the offending input from it, and a caller that cannot
   * tell login from email has to make the user guess.
   */
  it('Should name the clashing field when refusing a duplicate', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await create('clash@wp.pl', 'clashing', ['admin'], { password: 'bbbb1234' });

    const err = await create('clash@wp.pl', 'other-login', ['admin'], { password: 'bbbb1234' }).catch((e) => e);
    expect(err).to.be.instanceOf(ErrorCode);
    expect((err as any).code).to.eq(E_CODES.E_USER_ALREADY_EXISTS);
    expect((err as any).data.fields).to.deep.eq(['Email']);

    const both = await create('clash@wp.pl', 'clashing', ['admin'], { password: 'bbbb1234' }).catch((e) => e);
    expect((both as any).data.fields, 'both fields clash, both must be reported').to.deep.eq(['Login', 'Email']);
  });

  /**
   * Soft-deleted rows keep occupying the unique indexes, so skipping them would
   * trade this refusal for a driver error on the insert.
   */
  it('Should refuse a login taken by a soft-deleted account', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const { User: u } = await create('gone@wp.pl', 'goneuser', ['admin'], { password: 'bbbb1234' });
    await deleteUser(u);

    await expect(create('other@wp.pl', 'goneuser', ['admin'], { password: 'bbbb1234' })).to.be.rejectedWith(/Login already in use/);
  });

  /**
   * The uniqueness check must run before `beforeCreate`: a middleware that writes
   * to another system ( the legacy-user mirror is one ) must not fire for a
   * request that is about to be refused.
   */
  it('Should refuse a duplicate before running create middleware', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const config = DI.get(Configuration)!;
    const before = sinon.stub().callsFake((u: User) => u);
    config.set('rbac.actions.create.beforeCreate', [before as unknown as CreateMiddleware]);

    await expect(create('test@spinajs.pl', 'whoever', ['admin'], { password: 'bbbb1234' })).to.be.rejected;
    expect(before.callCount, 'middleware must not run for a refused creation').to.eq(0);

    config.set('rbac.actions.create.beforeCreate', []);
  });

  /**
   * A generated password is a secret nobody knows, so the account is unreachable
   * unless the same call also hands its owner a way in.
   */
  it('Should generate a password and issue a reset link when none is given', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const { Password } = await create('generated@wp.pl', 'generated', ['admin']);

    expect(Password, 'the generated password is returned to the caller').to.be.a('string').and.not.empty;

    const user = await User.query().whereAnything('generated@wp.pl').populate('Metadata').firstOrFail();
    expect(user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN], 'an account nobody holds a password for must be reachable').to.be.a('string');

    // the generated password is what was hashed, not something else
    expect(await passwordMatch(Password)(user)).to.eq(true);
  });

  /**
   * The inverse: a caller that supplied the password knows it and delivers it
   * itself. Mailing a reset link there would invalidate a password the caller is
   * about to hand out — which is what a CLI service account or a fixture wants
   * least.
   */
  it('Should not issue a reset link when the caller supplied the password', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await create('supplied@wp.pl', 'supplied', ['admin'], { password: 'bbbb1234' });

    const user = await User.query().whereAnything('supplied@wp.pl').populate('Metadata').firstOrFail();
    expect(user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN], 'a caller-supplied password must not be invalidated by a reset link').to.not.exist;
  });

  /**
   * The account exists by the time the link is issued, so a mail that cannot be
   * queued must not report the creation as failed — a caller that retries then
   * fails on the duplicate login instead.
   */
  it('Should still create the account when the reset link cannot be issued', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const config = DI.get(Configuration)!;
    const template = config.get('rbac.email.changePassword');
    config.set('rbac.email.changePassword', undefined);

    const { User: u } = await create('nolink@wp.pl', 'nolink', ['admin']);

    expect(u).to.be.instanceOf(User);
    expect(await User.query().whereAnything('nolink@wp.pl').first(), 'the account must survive a failed reset').to.exist;

    config.set('rbac.email.changePassword', template);
  });

  /**
   * `user:pwd_reset:token` is redeemable at the PUBLIC reset endpoint, so an
   * account seeded with a known one is an account takeover — planted through a
   * CLI or a migration just as easily as through a route, which is why the
   * refusal belongs to the action.
   */
  it('Should refuse metadata keys that decide account access', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await expect(
      create('planted@wp.pl', 'planted', ['admin'], {
        password: 'bbbb1234',
        metadata: { [USER_COMMON_METADATA.USER_PWD_RESET_TOKEN]: 'known-token' },
      }),
    ).to.be.rejectedWith(/Protected metadata keys cannot be set directly/);

    expect(await User.query().whereAnything('planted@wp.pl').first(), 'nothing may be written for a refused creation').to.not.exist;
  });

  /**
   * The metadata relation matches keys as GLOBS, so `*` is not a key — it is
   * "every key", including the protected ones.
   */
  it('Should refuse glob metadata keys', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await expect(create('globber@wp.pl', 'globber', ['admin'], { password: 'bbbb1234', metadata: { '*': 'overwritten' } })).to.be.rejectedWith(/Protected metadata keys cannot be set directly/);
  });

  it('Should honour an explicit id', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const { User: u } = await create('withid@wp.pl', 'withid', ['admin'], { password: 'bbbb1234', id: 4321 });

    expect(u.Id).to.eq(4321);
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

  /**
   * The REJECTION TYPE is the assertion, not just the rejection: @spinajs/http maps
   * `InvalidArgument` to 400 and anything unmapped to 500, so a bare `Error` here made
   * every "your password is too weak" answer an internal server error - indistinguishable,
   * to a client, from the server being broken.
   */
  it('Should reject a password that does not meet requirements', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));
    const user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    // password rule requires at least 8 chars with a letter and a digit
    await expect(changePassword('short')(user)).to.be.rejectedWith(InvalidArgument);

    const error = await changePassword('short')(user).catch((e: unknown) => e);
    expect((error as InvalidArgument).fieldName).to.eq('password');
    expect((error as InvalidArgument).errorCode).to.eq('E_PASSWORD_DOES_NOT_MEET_REQUIREMENTS');
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

  /**
   * The token is written into metadata and never returned over HTTP —
   * possession of the mailbox is what authorizes the reset — so an installation
   * that does not deliver it has a reset flow nobody can complete. It used to be
   * the application's job through the event, and an application that had not
   * written that subscriber issued tokens into the void.
   */
  it('Password change request mails the token', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await passwordChangeRequest('test@spinajs.pl');

    const user = await User.query().whereAnything('test@spinajs.pl').populate('Metadata').firstOrFail();
    const token = user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN];

    const mail = eStub.args.map((a) => (a as any)[0]).find((e) => e instanceof EmailSend);
    expect(mail, 'the reset mail must be queued').to.exist;

    // The very token that was stored — a mail carrying a different one, or none,
    // sends the user to a page that cannot complete the reset.
    expect((mail as any).model.Token).to.eq(token);
    expect((mail as any).to).to.deep.eq(['test@spinajs.pl']);
  });

  // `rbac.password.resetUrl` is empty by default: only the application knows its
  // own address, and a template must render without a link rather than with one
  // pointing nowhere.
  it('Password change request leaves ResetUrl empty when none is configured', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await passwordChangeRequest('test@spinajs.pl');

    const mail = eStub.args.map((a) => (a as any)[0]).find((e) => e instanceof EmailSend);
    expect((mail as any).model.ResetUrl).to.eq('');
  });

  it('Password change request builds the reset link from the configured page', async () => {
    const cfg = DI.get(Configuration)!;
    cfg.set('rbac.password.resetUrl', 'https://app.example.com/password-reset');

    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    try {
      await passwordChangeRequest('test@spinajs.pl');

      const user = await User.query().whereAnything('test@spinajs.pl').populate('Metadata').firstOrFail();
      const token = user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN];

      const mail = eStub.args.map((a) => (a as any)[0]).find((e) => e instanceof EmailSend);
      const url = new URL((mail as any).model.ResetUrl);

      // The redemption page needs BOTH: `POST /auth/password/reset` identifies
      // the account by e-mail and authorizes by token.
      expect(url.origin + url.pathname).to.eq('https://app.example.com/password-reset');
      expect(url.searchParams.get('token')).to.eq(token);
      expect(url.searchParams.get('email')).to.eq('test@spinajs.pl');
    } finally {
      cfg.set('rbac.password.resetUrl', '');
    }
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

  describe('password reset token', () => {
    const reload = () => User.query().whereAnything('test@spinajs.pl').populate('Metadata').firstOrFail();

    it('is single use — a redeemed token cannot be redeemed again', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await passwordChangeRequest('test@spinajs.pl');
      const token = (await reload()).Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN];

      await confirmPasswordReset('test@spinajs.pl', 'brandNew123', token);

      // Whoever saw the reset mail must not be able to keep re-taking the
      // account for the rest of the wait-time window.
      await expect(confirmPasswordReset('test@spinajs.pl', 'attacker123', token)).to.be.rejected;

      const pwd = await DI.resolve(BasicPasswordProvider);
      expect(await pwd.verify((await reload()).Password, 'brandNew123'), 'the first reset must stand').to.be.true;
    });

    it('is erased from the user metadata once redeemed', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await passwordChangeRequest('test@spinajs.pl');
      const token = (await reload()).Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN];

      await confirmPasswordReset('test@spinajs.pl', 'brandNew123', token);

      const meta = (await reload()).Metadata;
      expect(meta[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN], 'token').to.be.not.ok;
      expect(meta[USER_COMMON_METADATA.USER_PWD_RESET_START_DATE], 'start date').to.be.not.ok;
      expect(meta[USER_COMMON_METADATA.USER_PWD_RESET_WAIT_TIME], 'wait time').to.be.not.ok;
    });

    it('is refused for a banned account', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await passwordChangeRequest('test@spinajs.pl');
      const token = (await reload()).Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN];

      await ban('test@spinajs.pl', 'testing', 3600);

      // a reset must not be a way around a ban
      await expect(confirmPasswordReset('test@spinajs.pl', 'brandNew123', token)).to.be.rejected;
    });

    it('is refused for a deactivated account', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await passwordChangeRequest('test@spinajs.pl');
      const token = (await reload()).Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN];

      await deactivate('test@spinajs.pl');

      await expect(confirmPasswordReset('test@spinajs.pl', 'brandNew123', token)).to.be.rejected;
    });
  });

  describe('login throttling', () => {
    const reload = () => User.query().whereAnything('test@spinajs.pl').populate('Metadata').firstOrFail();

    const blockAfter = async () => {
      const cfg = await DI.resolve(Configuration);
      return cfg.get<number>('rbac.password.blockAfterAttempts', 5);
    };

    it('counts consecutive failures', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await expect(login('test@spinajs.pl', 'wrong-password')).to.be.rejected;

      expect(Number((await reload()).Metadata[USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS])).to.eq(1);
    });

    it('locks the account after the configured number of failures and refuses the CORRECT password while locked', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      const limit = await blockAfter();
      for (let i = 0; i < limit; i++) {
        await expect(login('test@spinajs.pl', 'wrong-password')).to.be.rejected;
      }

      const locked = (await reload()).Metadata[USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL];
      expect(locked, 'a lock instant must be recorded').to.be.not.undefined;

      // the whole point: guessing does not become possible again just because
      // the attacker finally guessed right
      await expect(login('test@spinajs.pl', 'bbbb')).to.be.rejected;
    });

    it('clears the counter and the lock on a successful login', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await expect(login('test@spinajs.pl', 'wrong-password')).to.be.rejected;
      expect(Number((await reload()).Metadata[USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS])).to.eq(1);

      await login('test@spinajs.pl', 'bbbb');

      const meta = (await reload()).Metadata;
      expect(meta[USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS], 'attempt counter').to.be.not.ok;
      expect(meta[USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL], 'lock instant').to.be.not.ok;
    });

    it('lets an expired lock through', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      const user = await reload();
      user.Metadata[USER_COMMON_METADATA.USER_LOGIN_LOCKED_UNTIL] = DateTime.now().minus({ minutes: 5 }).toISO();
      await user.Metadata.update();

      await expect(login('test@spinajs.pl', 'bbbb')).to.be.fulfilled;
    });
  });

  describe('session revocation', () => {
    const liveSessionFor = async (email: string) => {
      const user = await User.query().whereAnything(email).firstOrFail();
      const provider = await DI.resolve(SessionProvider);
      const session = new UserSession();
      session.UserId = user.Id;
      session.Data.set('User', user.Uuid);
      await provider.save(session);
      return { provider, session };
    };

    it('destroys the sessions of a user whose password changed', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      const { provider, session } = await liveSessionFor('test@spinajs.pl');

      await changePassword('brandNew123')(await User.query().whereAnything('test@spinajs.pl').populate('Metadata').firstOrFail());

      expect(await provider.restore(session.SessionId), 'a session authorized by the old password must not survive it').to.be.null;
    });

    it('destroys the sessions of a banned user', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      const { provider, session } = await liveSessionFor('test@spinajs.pl');

      await ban('test@spinajs.pl', 'testing', 3600);

      // isActiveUser does not filter on the ban flag, so a surviving session
      // would keep working for the whole ban
      expect(await provider.restore(session.SessionId)).to.be.null;
    });

    it('destroys the sessions of a deactivated user', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      const { provider, session } = await liveSessionFor('test@spinajs.pl');

      await deactivate('test@spinajs.pl');

      expect(await provider.restore(session.SessionId)).to.be.null;
    });
  });

  /**
   * `changePassword` has always refused a password that fails the configured
   * rule. Creation accepting one plants a password the account can never
   * legitimately return to.
   */
  it('Should refuse a supplied password that does not meet requirements', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await expect(create('weak@wp.pl', 'weakling', ['admin'], { password: 'short' })).to.be.rejectedWith(InvalidArgument, /does not meet requirements/);

    expect(await User.query().whereAnything('weak@wp.pl').first(), 'nothing may be written for a refused creation').to.not.exist;
  });

  it('Should accept a supplied password that meets requirements', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const { User: u } = await create('strong@wp.pl', 'strongman', ['admin'], { password: 'passw0rd123' });

    expect(u).to.be.instanceOf(User);
  });
});
