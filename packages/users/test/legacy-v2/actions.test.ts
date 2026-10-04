// Rewrite-class rows (LEDGER actions rows 41, 42, 82, 84-87) moved here by C1 dispatch 1: they assert users.Role,
// which authz-rbac's migrations drop (H13). Rows 20, 23-25, 64, 65, 67-70, 72 and 83 (C1 task 3) assert the 2.x
// generated password, the reset token create() put in metadata, or the "at least one role" refusal.
// Excluded by .mocharc.json; T1 replaces and deletes them.
import { BasicPasswordProvider } from '../../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User, UserActivated, UserChanged, deactivate, UserDeactivated, create, UserCreated, deleteUser, UserDeleted, ban, unban, grant, revoke, changePassword, _user_update, passwordChangeRequest, confirmPasswordReset, passwordMatch, USER_COMMON_METADATA, login, UserLogged, UserBanned, UserUnbanned, UserPasswordChanged, UserPasswordChangeRequest, CreateMiddleware, SessionProvider, UserSession, issuePasswordResetToken } from '../../src/index.js';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { UserAlreadyExists } from '../../src/exceptions.js';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { join, normalize, resolve } from 'path';
import { TestConfiguration } from '../common.test.js';
import * as sinon from 'sinon';
import { expect } from 'chai';

import '../migration/rbac.migration.js';
import { DefaultQueueService } from '@spinajs/queue';
import { activate } from '../../src/actions.js';
import _ from 'lodash';
import { EmailSend } from '@spinajs/email';
import { UserMetadataChange } from '../../src/events/UserMetadataChange.js';
import { DateTime } from 'luxon';
import { UserLoginFailed } from '../../src/events/UserLoginFailed.js';
import { expirePassword } from '../../src/actions.js';
import { UserPasswordExpired } from '../../src/events/UserPasswordExpired.js';

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

    await DI.resolve(Configuration, [null, null, [dir('../config')]]);
    await DI.resolve(Orm);
  });

  afterEach(async () => {
    sinon.restore();

    DI.clearCache();
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

  it('Should trim and de-duplicate the role list', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const { User: u } = await create('roles@wp.pl', 'roleuser', ['admin', ' admin ', 'guest'], { password: 'passw0rd123' });

    expect(u.Role).to.have.members(['admin', 'guest']);
    expect(u.Role, 'a duplicate would be checked twice by every downstream guard').to.have.lengthOf(2);
  });

  /**
   * A role absent from the grants map inserts fine and then fails inside
   * accesscontrol, far from whoever typed it.
   */
  it('Should refuse a role that is not configured in grants', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await expect(create('bogus@wp.pl', 'bogususer', ['not-a-role'], { password: 'passw0rd123' })).to.be.rejectedWith(InvalidArgument, /not configured in rbac.grants or rbac.roles: not-a-role/);

    expect(await User.query().whereAnything('bogus@wp.pl').first()).to.not.exist;
  });

  it('Should refuse granting a role that is not configured in grants', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await expect(grant('test@spinajs.pl', 'not-a-role')).to.be.rejectedWith(InvalidArgument, /not configured in rbac.grants or rbac.roles/);
  });

  /**
   * The escape hatch itself needs a test: without one, `rbac.requireKnownRole`
   * could regress into a no-op and nothing here would notice.
   */
  it('Should accept an undeclared role when rbac.requireKnownRole is false', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const config = DI.get(Configuration)!;
    config.set('rbac.requireKnownRole', false);

    try {
      const { User: u } = await create('escapehatch@wp.pl', 'escapehatch', ['neither-grants-nor-roles'], { password: 'passw0rd123' });
      expect(u.Role).to.include('neither-grants-nor-roles');
    } finally {
      config.set('rbac.requireKnownRole', true);
    }
  });

  /**
   * `rbac.roles` may be assembled dynamically (the escape hatch above exists
   * for exactly that scenario), so one malformed entry must not turn a routine
   * refusal into an unhandled TypeError thrown before assertRolesExist ever
   * gets to report which role was the problem.
   */
  it('Should refuse an unknown role rather than throw when rbac.roles holds a malformed entry', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const config = DI.get(Configuration)!;
    const original = config.get('rbac.roles');
    config.set('rbac.roles', [null, { Name: 'admin' }]);

    try {
      await expect(create('malformed-roles@wp.pl', 'malformedroles', ['not-a-role'], { password: 'passw0rd123' })).to.be.rejectedWith(InvalidArgument, /not configured in rbac.grants or rbac.roles: not-a-role/);
    } finally {
      config.set('rbac.roles', original);
    }
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
   * ONE mail, not two. The account-created mail IS the invite: a separate reset mail
   * would arrive alongside it carrying the same token and read as a second, contradictory
   * instruction.
   */
  it('Should mail a new account exactly one message, carrying the reset link', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await create('invite@wp.pl', 'invite', ['admin']);

    const mails = eStub.args.map((a) => (a as any)[0]).filter((e) => e instanceof EmailSend);
    expect(mails, 'exactly one mail per created account').to.have.length(1);

    const user = await User.query().whereAnything('invite@wp.pl').populate('Metadata').firstOrFail();
    expect((mails[0] as any).model.Token, 'the mail must carry the token that was stored').to.eq(user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN]);
    expect((mails[0] as any).to).to.deep.eq(['invite@wp.pl']);
  });

  it('Should issue the invite link with the invite lifetime, not the reset one', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await create('invitettl@wp.pl', 'invitettl', ['admin']);

    const user = await User.query().whereAnything('invitettl@wp.pl').populate('Metadata').firstOrFail();
    expect(user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_WAIT_TIME]).to.eq(15 * 60);

    const mail = eStub.args.map((a) => (a as any)[0]).find((e) => e instanceof EmailSend);
    expect((mail as any).model.ExpiresInMinutes).to.eq(15);
  });

  /**
   * One template renders both account mails; without the flag a new user is welcomed with
   * the password-reset wording.
   */
  it('Should mark the creation mail as an invite', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await create('inviteflag@wp.pl', 'inviteflag', ['admin']);

    const mail = eStub.args.map((a) => (a as any)[0]).find((e) => e instanceof EmailSend);
    expect((mail as any).model.IsInvite).to.eq(true);
  });

  /**
   * An account holding no role at all can do nothing and can only be repaired by
   * another administrator, so an empty list is refused rather than applied.
   */
  it('Should refuse a role list that names no role', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await expect(create('noroles@wp.pl', 'noroles', [], { password: 'passw0rd123' })).to.be.rejectedWith(InvalidArgument, /At least one role/);
    await expect(create('blankroles@wp.pl', 'blankroles', ['  ', ''], { password: 'passw0rd123' })).to.be.rejectedWith(InvalidArgument, /At least one role/);
  });

  describe('password reset token', () => {
    /**
     * A freshly created account is INACTIVE and the link mailed to it is the only way in,
     * so the inactive guard has to make room for exactly this case — and for no other.
     */
    it('lets a newly invited account redeem its link and activates it', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await create('redeem@wp.pl', 'redeem', ['admin']);

      const invited = () => User.query().whereAnything('redeem@wp.pl').populate('Metadata').firstOrFail();
      const token = (await invited()).Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN];

      await confirmPasswordReset('redeem@wp.pl', 'brandNew123', token);

      const after = await invited();
      expect(after.IsActive, 'redeeming the invite is what activates the account').to.be.ok;
      expect(after.Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING], 'the marker is single-use like the token').to.not.be.ok;
      expect(await passwordMatch('brandNew123')(after)).to.eq(true);
    });

    it('emits UserActivated when an invite is redeemed', async () => {
      const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await create('redeemev@wp.pl', 'redeemev', ['admin']);
      const token = (await User.query().whereAnything('redeemev@wp.pl').populate('Metadata').firstOrFail()).Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN];

      eStub.resetHistory();
      await confirmPasswordReset('redeemev@wp.pl', 'brandNew123', token);

      expect(eStub.args.some((a) => (a as any)[0] instanceof UserActivated)).to.be.true;
    });

    it('refuses an invite whose link has expired', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await create('expinv@wp.pl', 'expinv', ['admin']);

      const user = await User.query().whereAnything('expinv@wp.pl').populate('Metadata').firstOrFail();
      const token = user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN];

      // force the invite to be older than the 15 minutes it was issued for
      user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_START_DATE] = DateTime.now().minus({ minutes: 30 });
      await user.Metadata.update();

      await expect(confirmPasswordReset('expinv@wp.pl', 'brandNew123', token)).to.be.rejected;
    });

    it('refuses an invited account that was banned before redeeming', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await create('bannedinv@wp.pl', 'bannedinv', ['admin']);
      const token = (await User.query().whereAnything('bannedinv@wp.pl').populate('Metadata').firstOrFail()).Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN];

      await ban('bannedinv@wp.pl', 'testing', 3600);

      // a ban outranks an invite: the marker must not become a way past it
      await expect(confirmPasswordReset('bannedinv@wp.pl', 'brandNew123', token)).to.be.rejected;
    });

    it('refuses an invited account that was soft-deleted before redeeming', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await create('deletedinv@wp.pl', 'deletedinv', ['admin']);
      const token = (await User.query().whereAnything('deletedinv@wp.pl').populate('Metadata').firstOrFail()).Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN];

      await deleteUser('deletedinv@wp.pl');

      // a soft delete outranks an invite too, same as a ban
      await expect(confirmPasswordReset('deletedinv@wp.pl', 'brandNew123', token)).to.be.rejected;
    });

    /**
     * `deactivate()` is the only lever an administrator has to withdraw an invite that
     * has not been redeemed yet. If it leaves the marker in place, whoever holds the
     * mailed link can still redeem it and have the account activated behind the
     * administrator's back.
     */
    it('refuses an invited account that was deactivated before redeeming', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await create('deactinv@wp.pl', 'deactinv', ['admin']);
      const token = (await User.query().whereAnything('deactinv@wp.pl').populate('Metadata').firstOrFail()).Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN];

      await deactivate('deactinv@wp.pl');

      await expect(confirmPasswordReset('deactinv@wp.pl', 'brandNew123', token)).to.be.rejected;
    });

    /**
     * The sole writer of the marker stores a real boolean `true`. A stored STRING
     * 'false' is truthy under `!!`, so only a strict `=== true` comparison keeps it
     * from silently reopening the inactive-account guard.
     */
    it('treats the invite marker as pending only when it is stored as boolean true', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await create('stringmark@wp.pl', 'stringmark', ['admin']);
      const user = await User.query().whereAnything('stringmark@wp.pl').populate('Metadata').firstOrFail();
      const token = user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN];

      user.Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING] = 'false';
      await user.Metadata.update();

      await expect(confirmPasswordReset('stringmark@wp.pl', 'brandNew123', token)).to.be.rejected;
    });
  });
});
