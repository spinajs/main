import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User, UserActivated, UserChanged, deactivate, UserDeactivated, create, UserCreated, deleteUser, UserDeleted, ban, unban, _user_update, USER_COMMON_METADATA, UserBanned, UserUnbanned, CreateMiddleware, SessionProvider, UserSession } from '../src/index.js';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { UserAlreadyExists, UserCreatedIncomplete } from '../src/exceptions.js';
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
import { expirePassword } from '../src/actions.js';
import { UserPasswordExpired } from '../src/events/UserPasswordExpired.js';
import { globalRolesOf, registerAuthzHost } from './support/authz-host.js';
import { TestPasswordService } from './support/password-service.js';

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
    registerAuthzHost();
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

    const { User: U } = await create('test@wp.pl', 'test222', ['admin'], { password: 'bbbb1234' });

    const user = await User.query().whereAnything('test@wp.pl').firstOrFail();
    expect(user).to.be.not.null;
    expect(user.IsActive).to.eq(false);
    expect(user.Login).to.eq('test222');
    expect(user.Email).to.eq('test@wp.pl');
    expect(await globalRolesOf(user.Uuid)).to.include('admin');

    expect(eStub.callCount).to.eq(2);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserCreated);
    expect((eStub.args[1] as any)[0]).to.be.instanceOf(EmailSend);

    expect(U).to.be.instanceOf(User);
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

    const { User: U } = await create('meta@wp.pl', 'metameta', ['admin'], {
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
    expect(await globalRolesOf(user.Uuid)).to.include('admin');

    expect(user.Metadata['user:niceName']).to.eq('Meta User');
    expect(user.Metadata['user:locale']).to.eq('en');

    expect(eStub.callCount).to.eq(3);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserMetadataChange);
    expect((eStub.args[1] as any)[0]).to.be.instanceOf(UserCreated);
    expect((eStub.args[2] as any)[0]).to.be.instanceOf(EmailSend);

    expect(U).to.be.instanceOf(User);
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
    config.set('users.actions.create.beforeCreate', [beforeSpy as CreateMiddleware]);
    config.set('users.actions.create.afterCreate', [afterSpy as CreateMiddleware]);

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
    config!.set('users.actions.create.beforeCreate', []);
    config!.set('users.actions.create.afterCreate', []);
  });

  // Regression: reading the create-middleware lists through `_cfg(path, [])`
  // ran them through `_non_nil()`, which rejects empty arrays. Since the
  // shipped config defaults both hooks to `[]`, EVERY user creation failed with
  // "users.actions.create.beforeCreate should not be null, undefined or empty".
  it('Should create user when create middleware lists are empty', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const config = DI.get(Configuration)!;
    config.set('users.actions.create.beforeCreate', []);
    config.set('users.actions.create.afterCreate', []);

    const { User: U } = await create('empty-mw@wp.pl', 'emptymw', ['admin'], { password: 'bbbb1234' });

    expect(U).to.be.instanceOf(User);
    const user = await User.query().whereAnything('empty-mw@wp.pl').firstOrFail();
    expect(user.Login).to.eq('emptymw');
  });

  // Regression: same root cause, but for apps that never declare `users.actions`
  // at all — the config lookup returns undefined and must be treated as
  // "no middleware", not as an error.
  it('Should create user when create middleware config is not declared at all', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const config = DI.get(Configuration)!;
    config.set('users.actions', undefined);

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
    config.set('users.actions.create.beforeCreate', 'not-a-list' as any);

    const { User: U } = await create('bad-mw@wp.pl', 'badmw', ['admin'], { password: 'bbbb1234' });

    expect(U).to.be.instanceOf(User);

    config.set('users.actions.create.beforeCreate', []);
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
    expect(err).to.be.instanceOf(UserAlreadyExists);
    
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
    config.set('users.actions.create.beforeCreate', [before as unknown as CreateMiddleware]);

    await expect(create('test@spinajs.pl', 'whoever', ['admin'], { password: 'bbbb1234' })).to.be.rejected;
    expect(before.callCount, 'middleware must not run for a refused creation').to.eq(0);

    config.set('users.actions.create.beforeCreate', []);
  });

  /**
   * The account exists by the time the invite is issued, so a failed invite is
   * reported but does not take the account back: the invite can be sent again.
   */
  it('Should still create the account when the reset link cannot be issued', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));
    sinon.stub(TestPasswordService.prototype, 'invite').rejects(new Error('secret store down'));

    await expect(create('nolink@wp.pl', 'nolink', ['admin'])).to.be.rejectedWith(UserCreatedIncomplete, 'its invite was not sent');

    const u = await User.query().whereAnything('nolink@wp.pl').first();
    expect(u, 'the account must survive a failed invite').to.exist;
    expect(await globalRolesOf(u!.Uuid)).to.deep.eq(['admin']);
  });

  it('Should mark a created account as awaiting its invite', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await create('invitemark@wp.pl', 'invitemark', ['admin']);

    const user = await User.query().whereAnything('invitemark@wp.pl').populate('Metadata').firstOrFail();
    expect(user.Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING], 'the marker is what lets the inactive account redeem').to.be.ok;
  });

  it('Should not mark an account created with a caller-supplied password', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await create('nomark@wp.pl', 'nomark', ['admin'], { password: 'bbbb1234' });

    const user = await User.query().whereAnything('nomark@wp.pl').populate('Metadata').firstOrFail();
    expect(user.Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING]).to.not.be.ok;
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

  /**
   * The marker is what lets a reset reach an INACTIVE account. Seeding it through the
   * create API on an arbitrary account would make the reset flow a way past the
   * deactivation guard, so it belongs on the protected list next to the reset token.
   */
  it('Should refuse the invite marker as caller-supplied metadata', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await expect(
      create('invited@wp.pl', 'invited', ['admin'], {
        password: 'bbbb1234',
        metadata: { [USER_COMMON_METADATA.USER_INVITE_PENDING]: true },
      }),
    ).to.be.rejectedWith(/Protected metadata keys cannot be set directly/);

    expect(await User.query().whereAnything('invited@wp.pl').first(), 'nothing may be written for a refused creation').to.not.exist;
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

  /**
   * `users.email.banned` (common.test.ts) configures attachments so a
   * consuming application's branded template can reference its inline
   * images ( cid:logo etc ) - nothing in this stack attaches them
   * automatically, so the producer must carry them into the queued job.
   */
  it('Should carry configured attachments into the queued mail', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await ban('test@spinajs.pl', 'reason', 100);

    const mail = eStub.args.map((a) => (a as any)[0]).find((e) => e instanceof EmailSend);
    expect((mail as any).attachements).to.deep.eq([{ provider: 'fs', path: '/tmp/logo.png', name: 'logo.png', cid: 'logo' }]);
  });

  /**
   * `users.email.unbanned` declares no attachments - the queued job must not
   * carry an empty array where the current behaviour sends nothing.
   */
  it('Should queue a mail without an attachments field when the template declares none', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await ban('test@spinajs.pl', 'reason', 100);
    await unban('test@spinajs.pl');

    const mail = eStub.args.map((a) => (a as any)[0]).find((e) => e instanceof EmailSend && e.tag === 'rbac-user-unbanned');
    expect(mail).to.exist;
    expect((mail as any).attachements).to.be.undefined;
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

  it('Should update user', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    await _user_update({ Login: 'updated-login' })(user);

    const reloaded = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(reloaded.Login).to.eq('updated-login');
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
   * `changeUserPassword` has always refused a password that fails the configured
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
