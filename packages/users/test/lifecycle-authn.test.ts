import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { DefaultQueueService } from '@spinajs/queue';
import { InvalidArgument } from '@spinajs/exceptions';
import { SessionIssuer, TokenService } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { SYSTEM } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';

import { LoginAttemptsExceeded, PasswordChangeConflict, PasswordProvider, SessionProvider, TokenInvalid, USER_COMMON_METADATA, User, UserMetadataBase, UserPasswordStore, UserSession } from '../src/index.js';
import { UserPasswordExpired } from '../src/events/UserPasswordExpired.js';
import { _set_user_meta, activate, ban, changeUserPassword, confirmPasswordReset, create, deactivate, deleteUser, expirePassword, issuePasswordResetToken, passwordChangeRequest, setUserMeta } from '../src/actions.js';
import { TEST_USER_UUID } from './migration/rbac.migration.js';
import { TestPasswordService, passwordCalls, resetPasswordCalls } from './support/password-service.js';
import { RecordingSessionIssuer, registerRecordingSessionIssuer } from './support/session-issuer.js';
import { RecordingTokenService, registerRecordingTokenService } from './support/token-service.js';
import { bootUsersDb, registerUsersTestHost, seedUser, storedUser } from './support/users-db.js';

const FACTS = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() } as const;

/** Keys of authentication state, which 3.0 never keeps in identity metadata (A12). */
const AUTH_STATE = /^(user:pwd_reset:|user:pwd:|user:login:|2fa:|user:2fa:)/;

async function metadataKeys(userId: number): Promise<string[]> {
  const rows = (await User.query().Driver.select().from('users_metadata').columns(['Key']).where('user_id', userId)) as { Key: string }[];
  return rows.map((r) => r.Key);
}

describe('users lifecycle over authn (plan C1 task 11)', function () {
  this.timeout(30000);

  let emit: sinon.SinonStub;
  const queued = () => emit.args.map((a) => a[0]);

  before(() => {
    registerUsersTestHost();
    registerRecordingSessionIssuer();
    registerRecordingTokenService();
  });

  beforeEach(async () => {
    await bootUsersDb();
    emit = sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    RecordingSessionIssuer.calls.length = 0;
    RecordingTokenService.calls.length = 0;
    resetPasswordCalls();
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  describe('session revocation (N2, D5)', () => {
    const userRef = (u: { Uuid: string }): IdentityRef => ({ type: 'user', id: u.Uuid });

    for (const [title, act] of [
      ['ban', (u: User) => ban(u)],
      ['deactivate', (u: User) => deactivate(u)],
      ['deleteUser', (u: User) => deleteUser(u)],
      ['changeUserPassword', (u: User) => changeUserPassword(u, 'n3wpassword')],
    ] as const) {
      it(`${title} revokes every authn session of user:<Uuid>, impersonations included, and the 2.x ones`, async () => {
        const { user } = await seedUser({ login: `revoke-${title}`, password: await ((await DI.resolve(PasswordProvider)) as PasswordProvider).hash('0ldpassword') });
        const issuer = (await DI.resolve(SessionIssuer)) as RecordingSessionIssuer;
        const own = await issuer.issue(userRef(user), FACTS);
        const other = await issuer.issue({ type: 'user', id: TEST_USER_UUID }, { ...FACTS, impersonator: userRef(user) });
        const legacy = (await DI.resolve(SessionProvider)) as SessionProvider;
        await legacy.save(new UserSession({ UserId: user.Id }));

        await act(await storedUser(user.Uuid));

        expect(RecordingSessionIssuer.calls).to.deep.eq([{ subject: userRef(user), opts: { includeImpersonations: true } }]);
        expect(await issuer.restore(own.id)).to.eq(null);
        expect(await issuer.restore(other.id), 'a session where the user is the impersonator').to.eq(null);
        expect(await legacy.listByUser(user.Id)).to.deep.eq([]);
      });
    }

    it('without a registered SessionIssuer revokes only the 2.x sessions', async () => {
      const hasRegistered = DI.RootContainer.hasRegistered.bind(DI.RootContainer);
      sinon.stub(DI.RootContainer, 'hasRegistered').callsFake((token: unknown, parent?: boolean) => (token === SessionIssuer ? false : hasRegistered(token as never, parent)));
      const { user } = await seedUser({ login: 'revoke-no-issuer' });

      await ban(await storedUser(user.Uuid));

      expect(RecordingSessionIssuer.calls).to.deep.eq([]);
    });

    it('propagates a revocation failure', async () => {
      sinon.stub(RecordingSessionIssuer.prototype, 'revokeAll').rejects(new Error('session store down'));
      const { user } = await seedUser({ login: 'revoke-fails' });

      await expect(ban(await storedUser(user.Uuid))).to.be.rejectedWith('session store down');
    });
  });

  describe('token revocation (N8a hand-off)', () => {
    const userRef = (u: { Uuid: string }): IdentityRef => ({ type: 'user', id: u.Uuid });

    for (const [title, act] of [
      ['ban', (u: User) => ban(u)],
      ['deactivate', (u: User) => deactivate(u)],
      ['deleteUser', (u: User) => deleteUser(u)],
    ] as const) {
      it(`${title} revokes every API and agent token of user:<Uuid> through TokenService.revokeAllFor`, async () => {
        const { user } = await seedUser({ login: `tokens-${title}` });

        await act(await storedUser(user.Uuid));

        expect(RecordingTokenService.calls.map((c) => c.owner)).to.deep.eq([userRef(user)]);
        const [{ ctx, opts }] = RecordingTokenService.calls;
        expect(ctx.purpose).to.eq('request');
        expect(ctx.now).to.be.instanceOf(Date);
        expect(opts, 'the action names no actor').to.eq(undefined);
      });

      it(`${title} propagates a token revocation failure`, async () => {
        sinon.stub(RecordingTokenService.prototype, 'revokeAllFor').rejects(new Error('token store down'));
        const { user } = await seedUser({ login: `tokens-fail-${title}` });

        await expect(act(await storedUser(user.Uuid))).to.be.rejectedWith('token store down');
      });
    }

    it('changeUserPassword keeps the tokens (H32)', async () => {
      const { user } = await seedUser({ login: 'tokens-change', password: await ((await DI.resolve(PasswordProvider)) as PasswordProvider).hash('0ldpassword') });

      await changeUserPassword(await storedUser(user.Uuid), 'n3wpassword');

      expect(RecordingTokenService.calls).to.deep.eq([]);
    });

    it('without a registered TokenService revokes no token and still bans', async () => {
      const hasRegistered = DI.RootContainer.hasRegistered.bind(DI.RootContainer);
      sinon.stub(DI.RootContainer, 'hasRegistered').callsFake((token: unknown, parent?: boolean) => (token === TokenService ? false : hasRegistered(token as never, parent)));
      const { user } = await seedUser({ login: 'tokens-no-service' });

      await ban(await storedUser(user.Uuid));

      expect(RecordingTokenService.calls).to.deep.eq([]);
      expect((await storedUser(user.Uuid)).IsBanned).to.eq(true);
    });
  });

  describe('expirePassword', () => {
    it("goes through PasswordService.expire (cause admin), keeps the account active, ends the 2.x sessions and mails 'passwordExpired'", async () => {
      const { user } = await seedUser({ login: 'expire-me', password: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaA' });
      const legacy = (await DI.resolve(SessionProvider)) as SessionProvider;
      await legacy.save(new UserSession({ UserId: user.Id }));
      const admin: Principal = { type: 'user', id: TEST_USER_UUID, authenticated: true, source: 'session', attributes: {} };

      await expirePassword(user.Uuid, admin);

      const [call] = passwordCalls.filter((c) => c.method === 'expire');
      expect(call.id).to.deep.eq({ type: 'user', id: user.Uuid });
      expect(call.expiry).to.deep.eq({ cause: 'admin', actor: { type: 'user', id: TEST_USER_UUID } });
      const stored = await storedUser(user.Uuid);
      expect(Boolean(stored.IsActive)).to.eq(true);
      expect(stored.Password).to.eq('!expired');
      expect(await legacy.listByUser(user.Id)).to.deep.eq([]);
      expect(queued().filter((e) => e instanceof UserPasswordExpired), 'once, from authn event through QueueAuthnEventSink').to.have.lengthOf(1);
      expect(JSON.stringify(queued())).to.contain('rbac-user-passwordExpired');
    });

    it('defaults the actor to SYSTEM', async () => {
      const { user } = await seedUser({ login: 'expire-system' });

      await expirePassword(user.Uuid);

      expect(passwordCalls.find((c) => c.method === 'expire')!.expiry).to.deep.eq({ cause: 'admin', actor: { type: SYSTEM.type, id: SYSTEM.id } });
    });
  });

  describe('changeUserPassword (deprecated, K3b race)', () => {
    it('writes only over the hash the caller loaded: a reset landing meanwhile wins and it throws', async () => {
      const provider = (await DI.resolve(PasswordProvider)) as PasswordProvider;
      const { user } = await seedUser({ login: 'race', password: await provider.hash('0ldpassword') });
      const loaded = await storedUser(user.Uuid);

      const reset = await provider.hash('r3setpassword');
      await new UserPasswordStore().set({ type: 'user', id: user.Uuid }, reset);

      const err = await changeUserPassword(loaded, 'n3wpassword').catch((e) => e);
      expect(err).to.be.instanceOf(PasswordChangeConflict);
      expect(err.data).to.deep.eq({ user: user.Uuid });
      expect((await storedUser(user.Uuid)).Password).to.eq(reset);
      expect(RecordingSessionIssuer.calls).to.deep.eq([]);
    });

    it('sets the password over the loaded hash, stamps PasswordSetAt and writes no metadata', async () => {
      const provider = (await DI.resolve(PasswordProvider)) as PasswordProvider;
      const { user } = await seedUser({ login: 'change-ok', password: await provider.hash('0ldpassword') });
      user.Metadata[USER_COMMON_METADATA.USER_LOGIN_ATTEMPTS] = 3;
      await user.Metadata.update();

      await changeUserPassword(await storedUser(user.Uuid), 'n3wpassword');

      const stored = await storedUser(user.Uuid);
      expect(await provider.verify(stored.Password, 'n3wpassword')).to.eq(true);
      expect(stored.PasswordSetAt).to.not.eq(null);
      expect((await metadataKeys(user.Id)).filter((k) => AUTH_STATE.test(k))).to.deep.eq([]);
    });

    it("keeps leading and trailing spaces, as authn's login does not trim (A04)", async () => {
      const { user } = await seedUser({ login: 'change-spaces' });

      await changeUserPassword(await storedUser(user.Uuid), ' n3wpassword ');

      const provider = (await DI.resolve(PasswordProvider)) as PasswordProvider;
      const stored = (await storedUser(user.Uuid)).Password;
      expect(await provider.verify(stored, ' n3wpassword ')).to.eq(true);
      expect(await provider.verify(stored, 'n3wpassword')).to.eq(false);
    });

    it("checks the new password with PasswordService.check, authn's policy", async () => {
      const check = sinon.stub(TestPasswordService.prototype, 'check').resolves(['too_long']);
      const { user } = await seedUser({ login: 'change-policy' });

      const err = await changeUserPassword(await storedUser(user.Uuid), 'n3wpassword').catch((e) => e);

      expect(err).to.be.instanceOf(InvalidArgument);
      expect(err.errorCode).to.eq('E_PASSWORD_DOES_NOT_MEET_REQUIREMENTS');
      expect(check.args).to.deep.eq([['n3wpassword']]);
    });

    it('sets a first password over no password', async () => {
      const { user } = await seedUser({ login: 'change-first' });

      await changeUserPassword(await storedUser(user.Uuid), 'n3wpassword');

      expect(await ((await DI.resolve(PasswordProvider)) as PasswordProvider).verify((await storedUser(user.Uuid)).Password, 'n3wpassword')).to.eq(true);
    });
  });

  describe('the 2.x reset functions delegate to PasswordService (SR-09)', () => {
    it('passwordChangeRequest asks PasswordService.requestReset by email and stores no token', async () => {
      const { user } = await seedUser({ login: 'reset-me', email: 'reset-me@spinajs.pl' });

      await passwordChangeRequest(user.Uuid);
      const { token } = await issuePasswordResetToken(user.Uuid);

      expect(passwordCalls.filter((c) => c.method === 'requestReset').map((c) => c.login)).to.deep.eq(['reset-me@spinajs.pl', 'reset-me@spinajs.pl']);
      expect(token).to.eq('');
      expect((await metadataKeys(user.Id)).filter((k) => AUTH_STATE.test(k))).to.deep.eq([]);
      expect(queued(), 'users queues no mail and no event of its own').to.deep.eq([]);
    });

    it('passwordChangeRequest throws LoginAttemptsExceeded when the reset throttle refuses', async () => {
      sinon.stub(TestPasswordService.prototype, 'requestReset').resolves({ status: 'throttled', retryAfterSeconds: 60 });
      const { user } = await seedUser({ login: 'reset-throttled' });

      await expect(passwordChangeRequest(user.Uuid)).to.be.rejectedWith(LoginAttemptsExceeded);
    });

    it('confirmPasswordReset redeems through PasswordService.redeemReset and maps its refusals to the 2.x classes', async () => {
      const redeem = sinon.stub(TestPasswordService.prototype, 'redeemReset');
      redeem.onCall(0).resolves({ status: 'reset', purpose: 'reset' });
      redeem.onCall(1).resolves({ status: 'invalid' });
      redeem.onCall(2).resolves({ status: 'rejected', violations: ['too_short'] });
      redeem.onCall(3).resolves({ status: 'throttled', retryAfterSeconds: 5 });

      expect((await confirmPasswordReset('test@spinajs.pl', 'n3wpassword', 's3cret')).Uuid).to.eq(TEST_USER_UUID);
      await expect(confirmPasswordReset('test@spinajs.pl', 'n3wpassword', 'wrong')).to.be.rejectedWith(TokenInvalid);
      await expect(confirmPasswordReset('test@spinajs.pl', 'short', 's3cret')).to.be.rejectedWith(InvalidArgument);
      await expect(confirmPasswordReset('test@spinajs.pl', 'n3wpassword', 's3cret')).to.be.rejectedWith(LoginAttemptsExceeded);

      expect(redeem.args[0].slice(0, 3)).to.deep.eq(['test@spinajs.pl', 's3cret', 'n3wpassword']);
    });

    it('confirmPasswordReset returns the account authn found for a differently cased email', async () => {
      sinon.stub(TestPasswordService.prototype, 'redeemReset').resolves({ status: 'reset', purpose: 'reset' });

      expect((await confirmPasswordReset('Test@Spinajs.PL', 'n3wpassword', 's3cret')).Uuid).to.eq(TEST_USER_UUID);
    });
  });

  describe('A12: users writes no authentication state into metadata', () => {
    it('a create, a ban and a password change leave no reset token, lockout counter or last attempt', async () => {
      const { User: created } = await create({ Email: 'a12@spinajs.pl', Login: 'a12', Password: 'passw0rd123' });
      const { User: invited } = await create({ Email: 'a12-invite@spinajs.pl', Login: 'a12-invite' });
      await ban(await storedUser(created.Uuid));
      await changeUserPassword(await storedUser(created.Uuid), 'n3wpassword');

      expect((await metadataKeys(created.Id)).filter((k) => AUTH_STATE.test(k))).to.deep.eq([]);
      expect(await metadataKeys(invited.Id)).to.deep.eq([USER_COMMON_METADATA.USER_INVITE_PENDING]);
    });
  });

  it('activate drops the invite marker, so a later redeem does not activate again (LEDGER actions row 71, users part)', async () => {
    const { user } = await seedUser({ login: 'direct-activate', active: false, invitePending: true });

    await activate(user.Uuid);

    expect(await metadataKeys(user.Id)).to.not.include(USER_COMMON_METADATA.USER_INVITE_PENDING);
  });

  describe('SEC1: setUserMeta and the dehydrated user', () => {
    it('setUserMeta and _set_user_meta refuse reserved keys and globs', async () => {
      const u = await storedUser(TEST_USER_UUID);

      for (const key of ['user:pwd_reset:token', '2FA:enabled', 'user:ban:is_banned', 'user:invite:pending', 'user:*']) {
        await expect(setUserMeta(u, key, 'x'), key).to.be.rejectedWith(InvalidArgument);
        await expect(setUserMeta(u, [{ key, value: 'x' }]), key).to.be.rejectedWith(InvalidArgument);
        await expect(_set_user_meta(key, 'x')(u), key).to.be.rejectedWith(InvalidArgument);
      }
      expect(await metadataKeys(u.Id)).to.not.include('user:pwd_reset:token');

      await setUserMeta(u, USER_COMMON_METADATA.USER_PHONE, '555');
      expect((await storedUser(TEST_USER_UUID)).Metadata[USER_COMMON_METADATA.USER_PHONE]).to.eq('555');
    });

    it('ban still writes its own reserved keys', async () => {
      const { user } = await seedUser({ login: 'banned-by-sec1' });

      await ban(await storedUser(user.Uuid), 'spam');

      expect((await storedUser(user.Uuid)).IsBanned).to.eq(true);
    });

    it('a dehydrated user hides every reserved key, 2fa:enabled included, and what _hiddenKeys adds', async () => {
      const { user } = await seedUser({ login: 'dehydrated' });
      const plant = async (Key: string, Value: unknown) => User.query().Driver.insert().into('users_metadata').values({ user_id: user.Id, Key, Value, Type: 'string' });
      for (const key of ['2fa:enabled', '2FA:Token', 'user:pwd_reset:anything', 'user:login:attempts', 'app:secret', USER_COMMON_METADATA.USER_PHONE]) {
        await plant(key, 'v');
      }
      const before = [...UserMetadataBase._hiddenKeys];
      UserMetadataBase._hiddenKeys.push('app:secret');

      try {
        const shown = ((await storedUser(user.Uuid)).dehydrateWithRelations().Metadata as unknown as { Key: string }[]).map((m) => m.Key);
        expect(shown).to.deep.eq([USER_COMMON_METADATA.USER_PHONE]);
      } finally {
        UserMetadataBase._hiddenKeys = before;
      }
    });
  });
});
