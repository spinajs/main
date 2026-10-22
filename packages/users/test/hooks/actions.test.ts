/* eslint-disable @typescript-eslint/no-unsafe-member-access -- the tamper tests write into hook inputs untyped, as a careless hook would */
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { DefaultQueueService } from '@spinajs/queue';
import { InvalidArgument } from '@spinajs/exceptions';
import { ActionRefused } from '@spinajs/hooks';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { ScriptedActionHook } from '@spinajs/authn-testing';
import type { Principal } from '@spinajs/authz';

import { NO_PASSWORD, USER_COMMON_METADATA, User, UserAlreadyExists, UserBanned, UserIdentityRegistrar } from '../../src/index.js';
import type { UserDraft, UsersCreateInput, UsersCreateOutput } from '../../src/index.js';
import { activate, ban, create, deactivate, deleteUser, expirePassword, setUserMeta, unban, updateUser } from '../../src/actions.js';
import { globalRolesOf } from '../support/authz-host.js';
import { passwordCalls, resetPasswordCalls } from '../support/password-service.js';
import { RecordingSessionIssuer, registerRecordingSessionIssuer } from '../support/session-issuer.js';
import { RecordingTokenService, registerRecordingTokenService } from '../support/token-service.js';
import { bootUsersDb, registerUsersTestHost, releaseUsersHost, seedUser, storedUser } from '../support/users-db.js';
import { ThrowingAfterHook, rowState, withHook } from './support.js';

const CODE = 'not-today';
const PASSWORD = 'passw0rd123';
const FACTS = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() } as const;
const userRef = (uuid: string): IdentityRef => ({ type: 'user', id: uuid });

async function rejection(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  expect(err, 'expected a rejection').to.be.instanceOf(Error);
  return err as Error;
}

async function nothingWritten(login: string): Promise<void> {
  expect(await User.query().withDeleted().whereLogin(login).first(), 'no row, not even a soft-deleted one').to.not.exist;
}

const createCalls = (hook: ScriptedActionHook) => hook.calls('users.create');

describe('users actions on action hooks (HOOK-4)', function () {
  this.timeout(30000);

  let emit: sinon.SinonStub;
  const queued = () => emit.args.map((a) => a[0] as unknown);

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
    releaseUsersHost();
    DI.clearCache();
  });

  describe('a refused action throws ActionRefused and changes nothing', () => {
    // create() leaves the account inactive, with its password, its metadata and an editor grant.
    const cases: [string, string, (u: User) => Promise<unknown>, { active?: boolean; banned?: boolean }?][] = [
      ['users.update', 'updateUser', (u) => updateUser(u, { Login: 'renamed-by-update' })],
      ['users.activate', 'activate', (u) => activate(u), { active: false }],
      ['users.deactivate', 'deactivate', (u) => deactivate(u), { active: true }],
      ['users.ban', 'ban', (u) => ban(u, 'spam', 3600)],
      ['users.unban', 'unban', (u) => unban(u), { banned: true }],
      ['users.delete', 'deleteUser', (u) => deleteUser(u)],
      ['users.metadata.set', 'setUserMeta', (u) => setUserMeta(u, 'user:locale', 'de')],
      ['users.password.expire', 'expirePassword', (u) => expirePassword(u)],
    ];

    for (const [action, name, act, over] of cases) {
      it(`${name} (${action})`, async () => {
        const login = `refused-${name.toLowerCase()}`;
        const { User: user } = await create({ Email: `${login}@spinajs.pl`, Login: login, Password: PASSWORD, Metadata: { 'user:locale': 'pl' } }, ['editor']);
        if (over?.active) await activate(await storedUser(user.Uuid));
        if (over?.banned) await ban(await storedUser(user.Uuid), 'earlier', 3600);
        const before = await rowState(user.Uuid);
        const roles = await globalRolesOf(user.Uuid);
        const events = queued().length;
        resetPasswordCalls();
        RecordingSessionIssuer.calls.length = 0;
        RecordingTokenService.calls.length = 0;
        const hook = new ScriptedActionHook();
        hook.refuse(action, CODE);

        const err = await withHook(hook, async () => rejection(act(await storedUser(user.Uuid))));

        expect(err).to.be.instanceOf(ActionRefused);
        expect(err).to.include({ action, code: CODE });
        expect(await rowState(user.Uuid)).to.deep.eq(before);
        expect(await globalRolesOf(user.Uuid)).to.deep.eq(roles);
        expect(queued().length, 'no event and no mail').to.eq(events);
        expect(passwordCalls, 'authn is not asked to expire').to.deep.eq([]);
        expect(RecordingSessionIssuer.calls).to.deep.eq([]);
        expect(RecordingTokenService.calls).to.deep.eq([]);
      });
    }

    it('create (users.create): no row, no metadata, no grant', async () => {
      const hook = new ScriptedActionHook();
      hook.refuse('users.create', CODE);

      const err = await withHook(hook, () => rejection(create({ Email: 'refused-create@spinajs.pl', Login: 'refused-create', Password: PASSWORD, Metadata: { 'user:locale': 'pl' } }, ['editor'])));

      expect(err).to.be.instanceOf(ActionRefused);
      expect(err).to.include({ action: 'users.create', code: CODE });
      await nothingWritten('refused-create');
      expect(passwordCalls).to.deep.eq([]);
    });
  });

  describe('users.create before hooks', () => {
    it('run after a duplicate email is refused: a refusing hook is not called for a duplicate', async () => {
      await seedUser({ login: 'taken', email: 'taken@spinajs.pl' });
      const hook = new ScriptedActionHook();
      hook.refuse('users.create', CODE);

      const err = await withHook(hook, () => rejection(create({ Email: 'taken@spinajs.pl', Login: 'someone-else', Password: PASSWORD })));

      expect(err).to.be.instanceOf(UserAlreadyExists);
      expect(createCalls(hook)).to.deep.eq([]);
    });

    it('see the unsaved user, the data without the password, the roles and the actor', async () => {
      const hook = new ScriptedActionHook();

      await withHook(hook, () => create({ Email: 'seen@spinajs.pl', Login: 'seen', Password: PASSWORD, Metadata: { 'user:locale': 'pl' } }, ['editor']));

      const [before] = createCalls(hook);
      const input = before.input as unknown as UsersCreateInput;
      expect(before.phase).to.eq('before');
      expect(input.data).to.deep.eq({ Email: 'seen@spinajs.pl', Login: 'seen', Metadata: { 'user:locale': 'pl' } });
      expect(input.roles).to.deep.eq(['editor']);
      expect(input.user).to.include({ Email: 'seen@spinajs.pl', Login: 'seen', IsActive: false });
      expect(input.user.Uuid).to.be.a('string').that.is.not.empty;
      expect(input.user).to.not.have.property('Password');
      expect(input.actor).to.include({ type: 'system' });
      expect(JSON.stringify(hook.calls())).to.not.contain(PASSWORD);
    });

    it('a column set on ctx.input.user, in place, is on the inserted row', async () => {
      const hook = new ScriptedActionHook();
      hook.tamper('users.create', (input) => {
        input.user.IsActive = true;
      });

      const { User: u } = await withHook(hook, () => create({ Email: 'premade@spinajs.pl', Login: 'premade', Password: PASSWORD }));

      expect(hook.landed()).to.include('users.create:before');
      expect(Boolean((await storedUser(u.Uuid)).IsActive)).to.eq(true);
      expect(u.IsActive).to.eq(true);
    });

    it('cannot change the Uuid or the stored password of the new user', async () => {
      const hook = new ScriptedActionHook();
      let seen = '';
      hook.tamper('users.create', (input) => {
        seen = input.user.Uuid;
        input.user.Uuid = '00000000-0000-4000-8000-000000000000';
        input.user.Password = '$argon2id$planted';
      });

      const { User: u } = await withHook(hook, () => create({ Email: 'pinned@spinajs.pl', Login: 'pinned' }));

      expect(seen).to.be.a('string').that.is.not.empty;
      expect(u.Uuid).to.eq(seen);
      const row = await storedUser(u.Uuid);
      expect(row.Password).to.eq(NO_PASSWORD);
      expect(await User.query().where('Uuid', '00000000-0000-4000-8000-000000000000').first()).to.not.exist;
    });

    it('a data.Email changed in place to a taken one is refused by the uniqueness check run again', async () => {
      await seedUser({ login: 'owner', email: 'owner@spinajs.pl' });
      const hook = new ScriptedActionHook();
      hook.tamper('users.create', (input) => {
        input.data.Email = 'owner@spinajs.pl';
      });

      const err = await withHook(hook, () => rejection(create({ Email: 'fresh@spinajs.pl', Login: 'fresh-login', Password: PASSWORD })));

      expect(err).to.be.instanceOf(UserAlreadyExists);
      expect((err as UserAlreadyExists).data).to.deep.include({ fields: ['Email'] });
      await nothingWritten('fresh-login');
    });

    it('a data.Email replaced with a malformed one is refused by the email check run again', async () => {
      const hook = new ScriptedActionHook();
      hook.mutate('users.create', (input) => ({ data: { ...(input.data as object), Email: 'not-an-email' } }));

      await rejection(withHook(hook, () => create({ Email: 'shape@spinajs.pl', Login: 'shape', Password: PASSWORD })));

      await nothingWritten('shape');
    });

    it('a Login a hook sets on the user takes effect and is checked again', async () => {
      await seedUser({ login: 'occupied' });
      const renamed = new ScriptedActionHook();
      renamed.mutate('users.create', (input) => ({ user: { ...(input.user as object), Login: 'renamed-login' } }));
      const { User: u } = await withHook(renamed, () => create({ Email: 'rename@spinajs.pl', Login: 'asked-login', Password: PASSWORD }));
      expect((await storedUser(u.Uuid)).Login).to.eq('renamed-login');

      const clash = new ScriptedActionHook();
      clash.mutate('users.create', (input) => ({ user: { ...(input.user as object), Login: 'occupied' } }));
      const err = await withHook(clash, () => rejection(create({ Email: 'clash@spinajs.pl', Login: 'other-asked', Password: PASSWORD })));
      expect(err).to.be.instanceOf(UserAlreadyExists);
      await nothingWritten('other-asked');
    });

    it('a protected metadata key a hook adds is refused', async () => {
      const hook = new ScriptedActionHook();
      hook.tamper('users.create', (input) => {
        input.data.Metadata = { ...(input.data.Metadata ?? {}), [USER_COMMON_METADATA.USER_BAN_IS_BANNED]: true };
      });

      const err = await withHook(hook, () => rejection(create({ Email: 'protected@spinajs.pl', Login: 'protected-meta', Password: PASSWORD, Metadata: { 'user:locale': 'pl' } })));

      expect(err).to.be.instanceOf(InvalidArgument);
      await nothingWritten('protected-meta');
    });

    it('metadata a hook changes is the metadata written', async () => {
      const hook = new ScriptedActionHook();
      hook.tamper('users.create', (input) => {
        input.data.Metadata['user:locale'] = 'de';
      });

      const { User: u } = await withHook(hook, () => create({ Email: 'meta@spinajs.pl', Login: 'meta-changed', Password: PASSWORD, Metadata: { 'user:locale': 'pl' } }));

      expect((await storedUser(u.Uuid)).Metadata['user:locale']).to.eq('de');
    });

    it('an unknown role a hook adds is refused by the role dry run', async () => {
      const hook = new ScriptedActionHook();
      hook.tamper('users.create', (input) => {
        (input.roles as string[]).push('no-such-role');
      });

      const err = await withHook(hook, () => rejection(create({ Email: 'roles@spinajs.pl', Login: 'role-added', Password: PASSWORD }, ['editor'])));

      expect(err).to.be.instanceOf(InvalidArgument);
      await nothingWritten('role-added');
    });

    it('roles a hook narrows are the roles granted', async () => {
      const hook = new ScriptedActionHook();
      hook.mutate('users.create', { roles: ['normal'] });

      const { User: u } = await withHook(hook, () => create({ Email: 'narrow@spinajs.pl', Login: 'narrowed', Password: PASSWORD }, ['editor', 'normal']));

      expect(await globalRolesOf(u.Uuid)).to.deep.eq(['normal']);
    });

    it('a write into the frozen actor does not land', async () => {
      const hook = new ScriptedActionHook();
      hook.tamper('users.create', (input) => {
        input.actor.type = 'user';
      });

      const { User: u } = await withHook(hook, () => create({ Email: 'actor@spinajs.pl', Login: 'actor-kept', Password: PASSWORD }));

      expect(hook.landed()).to.deep.eq([]);
      expect(passwordCalls.find((c) => c.method === 'set')?.actor).to.deep.eq({ type: 'system', id: 'system' });
      expect(u).to.be.instanceOf(User);
    });

    it('a refusal during a registration reaches the route as a users.create refusal and spends one hash', async () => {
      const registrar = new UserIdentityRegistrar();
      const hash = sinon.stub(UserIdentityRegistrar.prototype as unknown as { spendHash: (password: string) => Promise<void> }, 'spendHash').resolves();
      const hook = new ScriptedActionHook();
      hook.refuse('users.create', CODE);

      const err = await withHook(hook, () => rejection(registrar.register({ login: 'registrant', email: 'registrant@spinajs.pl', password: PASSWORD }, { now: new Date(), purpose: 'request' })));

      expect(err).to.be.instanceOf(ActionRefused);
      expect(err).to.include({ action: 'users.create', code: CODE });
      expect(hash.args, 'as many hashes as a taken address costs').to.deep.eq([[PASSWORD]]);
      await nothingWritten('registrant');
    });
  });

  describe('the actor hooks see', () => {
    /** A signed-in administrator whose principal carries its User model, as authn's PrincipalFactory makes it. */
    async function signedInAdmin(): Promise<{ admin: User; actor: Principal }> {
      const { User: created } = await create({ Email: 'acting-admin@spinajs.pl', Login: 'acting-admin', Password: PASSWORD }, ['admin']);
      const admin = await storedUser(created.Uuid);
      return { admin, actor: { type: 'user', id: admin.Uuid, authenticated: true, source: 'session', attributes: { team: 'ops' }, identity: admin } };
    }

    const tamperActor = (input: Record<string, any>) => {
      const identity = (input.actor as { identity?: { Password?: string; Email?: string } }).identity;
      if (identity) {
        identity.Password = '$argon2id$planted';
        identity.Email = 'planted@spinajs.pl';
      }
    };

    for (const [action, act] of [
      ['users.create', (actor: Principal) => create({ Email: 'by-actor@spinajs.pl', Login: 'by-actor' }, ['editor'], actor)],
      ['users.password.expire', async (actor: Principal) => expirePassword(await storedUser((await seedUser({ login: 'expired-by-actor' })).user.Uuid), actor)],
    ] as const) {
      it(`${action}: a frozen plain view without the identity, so the model of the acting admin is out of reach`, async () => {
        const { admin, actor } = await signedInAdmin();
        const stored = (await storedUser(admin.Uuid)).Password;
        const hook = new ScriptedActionHook();
        hook.tamper(action, tamperActor);

        await withHook(hook, async () => {
          await act(actor);
        });

        const seen = (hook.calls(action)[0].input as { actor: Record<string, unknown> }).actor;
        expect(seen).to.deep.eq({ type: 'user', id: admin.Uuid, authenticated: true, source: 'session', attributes: { team: 'ops' } });
        expect(seen).to.not.have.property('identity');
        expect(Object.isFrozen(seen)).to.eq(true);
        expect(admin.Password).to.eq(stored);
        expect(admin.Email).to.eq('acting-admin@spinajs.pl');
        expect((await storedUser(admin.Uuid)).Password).to.eq(stored);
      });
    }

    it('the action still acts as the actor it was given', async () => {
      const { actor } = await signedInAdmin();
      resetPasswordCalls();

      await withHook(new ScriptedActionHook(), () => create({ Email: 'still-actor@spinajs.pl', Login: 'still-actor' }, ['editor'], actor));

      expect(passwordCalls.find((c) => c.method === 'invite')?.actor).to.deep.eq({ type: 'user', id: actor.id });
    });
  });

  describe('users.create writes its own state', () => {
    it('a users.metadata.set hook does not run for the metadata create() writes, so it cannot refuse an account already inserted', async () => {
      const hook = new ScriptedActionHook();
      hook.refuse('users.metadata.set', CODE);

      const { User: u } = await withHook(hook, () => create({ Email: 'meta-own@spinajs.pl', Login: 'meta-own', Metadata: { 'user:locale': 'pl' } }));

      expect((await storedUser(u.Uuid)).Metadata['user:locale']).to.eq('pl');
      expect(hook.calls('users.metadata.set')).to.deep.eq([]);
      expect(passwordCalls.map((c) => c.method)).to.deep.eq(['invite']);
    });

    it('a hook cannot set the credential state of the new user: PasswordSetAt and DeletedAt stay unset', async () => {
      const hook = new ScriptedActionHook();
      hook.tamper('users.create', (input) => {
        (input.user as UserDraft).PasswordSetAt = new Date('2020-01-01T00:00:00.000Z');
        (input.user as UserDraft).DeletedAt = new Date('2020-01-01T00:00:00.000Z');
        (input.user as UserDraft).IsActive = true;
      });

      const { User: u } = await withHook(hook, () => create({ Email: 'credential-state@spinajs.pl', Login: 'credential-state' }));

      const row = await storedUser(u.Uuid);
      expect(row.PasswordSetAt ?? null).to.eq(null);
      expect(row.DeletedAt ?? null).to.eq(null);
      expect(Boolean(row.IsActive), 'an ordinary column still takes the hook value').to.eq(true);
    });
  });

  describe('users.create after hooks', () => {
    it('see output.User and whether the account was invited, as a frozen copy', async () => {
      const hook = new ScriptedActionHook();
      hook.tamper(
        'users.create',
        (output) => {
          output.User.Email = 'changed@spinajs.pl';
        },
        'after',
      );

      const { User: u } = await withHook(hook, () => create({ Email: 'after@spinajs.pl', Login: 'after-seen', Password: PASSWORD }));

      const after = createCalls(hook).find((c) => c.phase === 'after')!;
      const output = after.output as UsersCreateOutput;
      expect(output.User).to.include({ Uuid: u.Uuid, Email: 'after@spinajs.pl', Login: 'after-seen' });
      expect(output.Invited).to.eq(false);
      expect(Object.isFrozen(output.User)).to.eq(true);
      expect(hook.landed()).to.deep.eq([]);
      expect(u.Email).to.eq('after@spinajs.pl');
    });

    it('a throwing after hook is logged and create returns normally (no UserCreatedIncomplete)', async () => {
      const hook = new ThrowingAfterHook(['users.create']);

      const result = await withHook(hook, () => create({ Email: 'after-throws@spinajs.pl', Login: 'after-throws' }));

      expect(result.User).to.be.instanceOf(User);
      expect(hook.seen).to.have.lengthOf(1);
      expect((hook.seen[0] as UsersCreateOutput).Invited).to.eq(true);
      expect(passwordCalls.map((c) => c.method)).to.deep.eq(['invite']);
    });
  });

  describe('users.ban', () => {
    async function withSessions(login: string) {
      const { user } = await seedUser({ login });
      const issuer = (await DI.resolve(SessionIssuer)) as RecordingSessionIssuer;
      const session = await issuer.issue(userRef(user.Uuid), FACTS);
      RecordingSessionIssuer.calls.length = 0;
      return { user, issuer, session };
    }

    it('a refusing hook keeps the sessions and the tokens', async () => {
      const { user, issuer, session } = await withSessions('ban-refused');
      const hook = new ScriptedActionHook();
      hook.refuse('users.ban', CODE);

      await rejection(withHook(hook, async () => ban(await storedUser(user.Uuid), 'spam', 3600)));

      expect(await issuer.restore(session.id)).to.not.eq(null);
      expect(RecordingSessionIssuer.calls).to.deep.eq([]);
      expect(RecordingTokenService.calls).to.deep.eq([]);
      expect((await storedUser(user.Uuid)).IsBanned).to.eq(false);
    });

    it('with a pass-through hook still revokes sessions and tokens and emits UserBanned', async () => {
      const { user, issuer, session } = await withSessions('ban-passed');
      const hook = new ScriptedActionHook();

      await withHook(hook, async () => ban(await storedUser(user.Uuid), 'spam', 3600));

      expect(await issuer.restore(session.id)).to.eq(null);
      expect(RecordingSessionIssuer.calls).to.deep.eq([{ subject: userRef(user.Uuid), opts: { includeImpersonations: true } }]);
      expect(RecordingTokenService.calls.map((c) => c.owner)).to.deep.eq([userRef(user.Uuid)]);
      expect(queued().some((e) => e instanceof UserBanned)).to.eq(true);
      expect(hook.calls('users.ban').map((c) => c.phase)).to.deep.eq(['before', 'after']);
    });

    it('a reason and duration a hook sets are the ones stored, checked again', async () => {
      const { user } = await withSessions('ban-changed');
      const hook = new ScriptedActionHook();
      hook.mutate('users.ban', { reason: 'policy', duration: 60 });

      await withHook(hook, async () => ban(await storedUser(user.Uuid), 'spam', 3600));
      const stored = await storedUser(user.Uuid);
      expect(stored.Metadata[USER_COMMON_METADATA.USER_BAN_REASON]).to.eq('policy');
      expect(stored.Metadata[USER_COMMON_METADATA.USER_BAN_DURATION]).to.eq(60);

      const { user: other } = await withSessions('ban-invalid');
      const invalid = new ScriptedActionHook();
      invalid.mutate('users.ban', { duration: -5 });
      await rejection(withHook(invalid, async () => ban(await storedUser(other.Uuid), 'spam', 3600)));
      expect((await storedUser(other.Uuid)).IsBanned).to.eq(false);
    });

    it('a write into the frozen user does not reach the action', async () => {
      const { user } = await withSessions('ban-tampered');
      const hook = new ScriptedActionHook();
      hook.tamper('users.ban', (input) => {
        input.user.Uuid = '00000000-0000-4000-8000-000000000000';
      });

      const banned = await withHook(hook, async () => ban(await storedUser(user.Uuid), 'spam', 3600));

      expect(hook.landed()).to.deep.eq([]);
      expect(banned.Uuid).to.eq(user.Uuid);
      expect(RecordingSessionIssuer.calls.map((c) => c.subject)).to.deep.eq([userRef(user.Uuid)]);
    });
  });

  describe('users.metadata.set', () => {
    it('a protected key a hook adds is refused', async () => {
      const { user } = await seedUser({ login: 'meta-protected' });
      const hook = new ScriptedActionHook();
      hook.tamper('users.metadata.set', (input) => {
        (input.meta as { key: string; value: unknown }[]).push({ key: USER_COMMON_METADATA.USER_BAN_IS_BANNED, value: true });
      });

      const err = await withHook(hook, async () => rejection(setUserMeta(await storedUser(user.Uuid), 'user:locale', 'pl')));

      expect(err).to.be.instanceOf(InvalidArgument);
      const stored = await storedUser(user.Uuid);
      expect(stored.Metadata[USER_COMMON_METADATA.USER_BAN_IS_BANNED]).to.not.be.ok;
      expect(stored.Metadata['user:locale']).to.not.be.ok;
    });

    it('a value a hook changes is the value written', async () => {
      const { user } = await seedUser({ login: 'meta-changed-value' });
      const hook = new ScriptedActionHook();
      hook.tamper('users.metadata.set', (input) => {
        input.meta[0].value = 'de';
      });

      await withHook(hook, async () => setUserMeta(await storedUser(user.Uuid), 'user:locale', 'pl'));

      expect((await storedUser(user.Uuid)).Metadata['user:locale']).to.eq('de');
    });
  });

  describe('users.update', () => {
    it('a Login a hook changes to a taken one is refused by the uniqueness check', async () => {
      await seedUser({ login: 'update-taken' });
      const { user } = await seedUser({ login: 'update-me' });
      const hook = new ScriptedActionHook();
      hook.tamper('users.update', (input) => {
        input.data.Login = 'update-taken';
      });

      const err = await withHook(hook, async () => rejection(updateUser(await storedUser(user.Uuid), { Login: 'update-free' })));

      expect(err).to.be.instanceOf(UserAlreadyExists);
      expect((await storedUser(user.Uuid)).Login).to.eq('update-me');
    });
  });

  describe('without a hook', () => {
    it('create still answers the user and the actions still work', async () => {
      const { User: u } = await create({ Email: 'plain@spinajs.pl', Login: 'plain', Password: PASSWORD });
      expect(u).to.be.instanceOf(User);
      await ban(await storedUser(u.Uuid), 'spam', 60);
      await unban(await storedUser(u.Uuid));
      await deactivate(await storedUser(u.Uuid));
      await activate(await storedUser(u.Uuid));
      await deleteUser(await storedUser(u.Uuid));
      expect((await storedUser(u.Uuid)).DeletedAt).to.be.ok;
    });
  });
});
