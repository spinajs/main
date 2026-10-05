// Rewrite-class rows (LEDGER actions rows 41, 42, 82, 84, 85) moved here by C1 dispatch 1: they assert users.Role,
// which authz-rbac's migrations drop (H13). Rows 20, 23-25, 64, 65, 67-70, 72 and 83 (C1 task 3) assert the 2.x
// generated password, the reset token create() put in metadata, or the "at least one role" refusal. Rows 49-63, 66
// and 71 (C1 task 11) assert the 2.x reset token. Rows 21, 39, 40, 44-48 and 73-77 (C1 task 13) assert the 2.x login,
// lockout and password change that N1 and N3 replace. Drop rows 86 and 87 deleted.
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
import { activate, changeUserPassword } from '../../src/actions.js';
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

  // C1 task 11: the 2.x reset token flow (rows 49-63, 66, 71) and passwordMatch (rows 58-59). users now delegates
  // the reset to PasswordService and stores no token, and passwordMatch is deleted.
  describe('2.x reset token and passwordMatch', () => {
    it('Password change request ', async () => {
      const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await passwordChangeRequest('test@spinajs.pl');

      const user = await User.query().whereAnything('test@spinajs.pl').populate('Metadata').firstOrFail();

      // a reset token, start date and wait time must be stored
      expect(user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN]).to.be.a('string');
      expect(user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_START_DATE]).to.be.not.null;
      // wait time must come from config (authn.local.reset.ttlSeconds), not be undefined
      expect(user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_WAIT_TIME]).to.eq(60 * 60);

      expect(eStub.args.some((a) => (a as any)[0] instanceof UserPasswordChangeRequest)).to.be.true;
    });

    /**
     * The issuing half has to be usable without the reset mail: `create()` puts the very
     * same link into the account-created mail instead, and two mails carrying two tokens
     * would invalidate whichever the user did not open first.
     */
    it('issuePasswordResetToken stores the token without sending a mail', async () => {
      const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      const { token, waitTime } = await issuePasswordResetToken('test@spinajs.pl');

      const user = await User.query().whereAnything('test@spinajs.pl').populate('Metadata').firstOrFail();
      expect(user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN]).to.eq(token);
      expect(waitTime).to.eq(60 * 60);

      expect(eStub.args.some((a) => (a as any)[0] instanceof UserPasswordChangeRequest), 'the event still fires').to.be.true;
      expect(eStub.args.some((a) => (a as any)[0] instanceof EmailSend), 'no mail may be queued by the issuing half').to.be.false;
    });

    it('issuePasswordResetToken honours an explicit wait time', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await issuePasswordResetToken('test@spinajs.pl', 900);

      const user = await User.query().whereAnything('test@spinajs.pl').populate('Metadata').firstOrFail();
      expect(user.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_WAIT_TIME]).to.eq(900);
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

    // `authn.local.reset.url` is empty by default: only the application knows its
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
      cfg.set('authn.local.reset.url', 'https://app.example.com/password-reset');

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
        cfg.set('authn.local.reset.url', '');
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

      /**
       * The marker is the whole of the exception. An account an administrator deactivated
       * carries none, so the reset stays refused for it — otherwise the flow would be a way
       * back into an account that was deliberately switched off.
       */
      it('still refuses an inactive account that was never invited', async () => {
        sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

        await create('deact@wp.pl', 'deact', ['admin'], { password: 'bbbb1234' });
        await activate('deact@wp.pl');
        await passwordChangeRequest('deact@wp.pl');

        const token = (await User.query().whereAnything('deact@wp.pl').populate('Metadata').firstOrFail()).Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN];

        await deactivate('deact@wp.pl');

        await expect(confirmPasswordReset('deact@wp.pl', 'brandNew123', token)).to.be.rejected;
      });

      /**
       * An account an administrator activates directly is already active; leaving the
       * marker behind makes the user's next ORDINARY reset take the invite branch and
       * emit a spurious UserActivated for an account that never stopped being active.
       */
      it('an admin activation clears the invite marker so a later ordinary reset does not re-activate', async () => {
        const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

        await create('directact@wp.pl', 'directact', ['admin']);
        await activate('directact@wp.pl');

        const activated = await User.query().whereAnything('directact@wp.pl').populate('Metadata').firstOrFail();
        expect(activated.Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING], 'an account activated directly is no longer a pending invite').to.not.be.ok;

        await passwordChangeRequest('directact@wp.pl');
        const token = (await User.query().whereAnything('directact@wp.pl').populate('Metadata').firstOrFail()).Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN];

        eStub.resetHistory();
        await confirmPasswordReset('directact@wp.pl', 'brandNew123', token);

        expect(eStub.args.some((a) => (a as any)[0] instanceof UserActivated), 'an already-active account must not re-emit UserActivated on an ordinary reset').to.be.false;
      });
    });
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

  it('Should change password', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const user = await User.query().whereAnything('test@spinajs.pl').populate('Metadata').firstOrFail();
    const oldHash = user.Password;

    await changeUserPassword(user, 'newPass123');

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
    await expect(changeUserPassword(user, 'short')).to.be.rejectedWith(InvalidArgument);

    const error = await changeUserPassword(user, 'short').catch((e: unknown) => e);
    expect((error as InvalidArgument).fieldName).to.eq('password');
    expect((error as InvalidArgument).errorCode).to.eq('E_PASSWORD_DOES_NOT_MEET_REQUIREMENTS');
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

      await changeUserPassword(await User.query().whereAnything('test@spinajs.pl').populate('Metadata').firstOrFail(), 'brandNew123');

      expect(await provider.restore(session.SessionId), 'a session authorized by the old password must not survive it').to.be.null;
    });
  });
});
