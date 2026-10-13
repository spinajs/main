import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { DefaultQueueService } from '@spinajs/queue';
import { InvalidArgument } from '@spinajs/exceptions';
import { SessionIssuer, TokenService } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { SYSTEM, UNATTENDED, runWithPrincipal } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';

import { USER_COMMON_METADATA, User, UserIsBanned, UserMetadataBase } from '../src/index.js';
import { UserPasswordExpired } from '../src/events/UserPasswordExpired.js';
import { _set_user_meta, activate, ban, create, deactivate, deleteUser, expirePassword, revokeUserTokens, setUserMeta } from '../src/actions.js';
import { TEST_USER_UUID } from './migration/rbac.migration.js';
import { passwordCalls, resetPasswordCalls } from './support/password-service.js';
import { testHasher } from './support/hasher.js';
import { RecordingSessionIssuer, registerRecordingSessionIssuer } from './support/session-issuer.js';
import { RecordingTokenService, registerRecordingTokenService } from './support/token-service.js';
import { bootUsersDb, registerUsersTestHost, seedUser, storedUser } from './support/users-db.js';

const FACTS = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() } as const;

const ADMIN: Principal = Object.freeze({ type: 'user', id: TEST_USER_UUID, authenticated: true, source: 'session', attributes: Object.freeze({}) });
// authz-http's anonymous principal; users does not depend on authz-http.
const ANONYMOUS: Principal = Object.freeze({ type: 'anonymous', id: 'anonymous', authenticated: false, source: 'anonymous', attributes: Object.freeze({}) });

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
    ] as const) {
      it(`${title} revokes every authn session of user:<Uuid>, impersonations included`, async () => {
        const { user } = await seedUser({ login: `revoke-${title}`, password: await testHasher.hash('0ldpassword') });
        const issuer = (await DI.resolve(SessionIssuer)) as RecordingSessionIssuer;
        const own = await issuer.issue(userRef(user), FACTS);
        const other = await issuer.issue({ type: 'user', id: TEST_USER_UUID }, { ...FACTS, impersonator: userRef(user) });

        await act(await storedUser(user.Uuid));

        expect(RecordingSessionIssuer.calls).to.deep.eq([{ subject: userRef(user), opts: { includeImpersonations: true } }]);
        expect(await issuer.restore(own.id)).to.eq(null);
        expect(await issuer.restore(other.id), 'a session where the user is the impersonator').to.eq(null);
      });
    }

    it('without a registered SessionIssuer revokes no session and still bans', async () => {
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
    const failFirstRevocation = (): void => {
      const stub = sinon.stub(RecordingTokenService.prototype, 'revokeAllFor').callThrough();
      stub.onFirstCall().rejects(new Error('token store down'));
    };

    for (const [title, act] of [
      ['ban', (u: User) => ban(u)],
      ['deactivate', (u: User) => deactivate(u)],
      ['deleteUser', (u: User) => deleteUser(u)],
    ] as const) {
      it(`${title} revokes every API and agent token of user:<Uuid> through TokenService.revokeAllFor, naming the caller`, async () => {
        const { user } = await seedUser({ login: `tokens-${title}` });

        await runWithPrincipal(ADMIN, async () => act(await storedUser(user.Uuid)));

        expect(RecordingTokenService.calls.map((c) => c.owner)).to.deep.eq([userRef(user)]);
        const [{ ctx, opts, ambient }] = RecordingTokenService.calls;
        expect(ctx.purpose).to.eq('request');
        expect(ctx.now).to.be.instanceOf(Date);
        expect(opts).to.deep.eq({ actor: { type: 'user', id: ADMIN.id } });
        expect(ambient, 'the audit sinks run as the caller, never as SYSTEM').to.eq(ADMIN);
      });

      it(`${title} propagates a token revocation failure`, async () => {
        sinon.stub(RecordingTokenService.prototype, 'revokeAllFor').rejects(new Error('token store down'));
        const { user } = await seedUser({ login: `tokens-fail-${title}` });

        await expect(act(await storedUser(user.Uuid))).to.be.rejectedWith('token store down');
      });

      it(`${title} after a failed token revocation is finished by revokeUserTokens`, async () => {
        failFirstRevocation();
        const { user } = await seedUser({ login: `tokens-retry-${title}` });

        await expect(act(await storedUser(user.Uuid))).to.be.rejectedWith('token store down');
        // By numeric id: a soft-deleted row is still found.
        await revokeUserTokens(user.Id);

        expect(RecordingTokenService.calls.map((c) => c.owner)).to.deep.eq([userRef(user)]);
      });
    }

    it('a ban whose token revocation failed is stored, cannot be repeated, and revokeUserTokens ends the tokens', async () => {
      failFirstRevocation();
      const { user } = await seedUser({ login: 'tokens-retry-ban' });

      await expect(ban(await storedUser(user.Uuid))).to.be.rejectedWith('token store down');
      const stored = await storedUser(user.Uuid);
      expect(stored.IsBanned).to.eq(true);
      await expect(ban(stored)).to.be.rejectedWith(UserIsBanned);

      await revokeUserTokens(stored);

      expect(RecordingTokenService.calls.map((c) => c.owner)).to.deep.eq([userRef(user)]);
    });

    it('revokeUserTokens of an unknown numeric id revokes nothing', async () => {
      await revokeUserTokens(987654);

      expect(RecordingTokenService.calls).to.deep.eq([]);
    });

    for (const [title, caller, actor] of [
      ['SYSTEM', SYSTEM, { type: 'system', id: SYSTEM.id }],
      ['UNATTENDED', undefined, undefined],
      ['an anonymous caller', ANONYMOUS, undefined],
    ] as const) {
      it(`a ban run by ${title} passes ${actor ? 'it as the actor' : 'no actor'}`, async () => {
        const { user } = await seedUser({ login: `tokens-actor-${title.replace(/\W/g, '')}` });
        const run = async () => ban(await storedUser(user.Uuid));

        await (caller ? runWithPrincipal(caller, run) : run());

        const [{ opts, ambient }] = RecordingTokenService.calls;
        expect(opts).to.deep.eq(actor ? { actor } : undefined);
        expect(ambient).to.eq(caller ?? UNATTENDED);
      });
    }

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
    it("goes through PasswordService.expire (cause admin), keeps the account active and mails 'passwordExpired'", async () => {
      const { user } = await seedUser({ login: 'expire-me', password: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaA' });
      const admin: Principal = { type: 'user', id: TEST_USER_UUID, authenticated: true, source: 'session', attributes: {} };

      await expirePassword(user.Uuid, admin);

      const [call] = passwordCalls.filter((c) => c.method === 'expire');
      expect(call.id).to.deep.eq({ type: 'user', id: user.Uuid });
      expect(call.expiry).to.deep.eq({ cause: 'admin', actor: { type: 'user', id: TEST_USER_UUID } });
      const stored = await storedUser(user.Uuid);
      expect(Boolean(stored.IsActive)).to.eq(true);
      expect(stored.Password).to.eq('!expired');
      expect(queued().filter((e) => e instanceof UserPasswordExpired), 'once, from authn event through QueueAuthnEventSink').to.have.lengthOf(1);
      expect(JSON.stringify(queued())).to.contain('rbac-user-passwordExpired');
    });

    it('defaults the actor to SYSTEM', async () => {
      const { user } = await seedUser({ login: 'expire-system' });

      await expirePassword(user.Uuid);

      expect(passwordCalls.find((c) => c.method === 'expire')!.expiry).to.deep.eq({ cause: 'admin', actor: { type: SYSTEM.type, id: SYSTEM.id } });
    });
  });

  describe('A12: users writes no authentication state into metadata', () => {
    it('a create and a ban leave no reset token, lockout counter or last attempt', async () => {
      const { User: created } = await create({ Email: 'a12@spinajs.pl', Login: 'a12', Password: 'passw0rd123' });
      const { User: invited } = await create({ Email: 'a12-invite@spinajs.pl', Login: 'a12-invite' });
      await ban(await storedUser(created.Uuid));

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
