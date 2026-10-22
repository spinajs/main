import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { renderTemplate } from '@spinajs/log';
import { MetadataRelation } from '@spinajs/orm';
import { DefaultQueueService } from '@spinajs/queue';
import { ActionHook, Hooks } from '@spinajs/hooks';
import type { ActionName, AfterContext } from '@spinajs/hooks';
import type { AuthnContext, IdentityRef } from '@spinajs/authn/contracts';
import { DEFAULT_THROTTLE, FakeBackoffThrottle, MemorySecretStore, MemorySessionIssuer } from '@spinajs/authn-testing';
import { Argon2PasswordHasher, LocalPasswordPolicy, LocalPasswordService, PasswordMailer } from '@spinajs/authn-local';
import type { PasswordMail } from '@spinajs/authn-local';

import { QueueAuthnEventSink, USER_COMMON_METADATA, User, UserActivated, UserAddressVerifier, UserChanged, UserIdentityStore, UserPasswordStateHook, UserPasswordStore } from '../../src/index.js';
import { deactivate } from '../../src/actions.js';
import { bootUsersDb, registerUsersTestHost, releaseUsersHost, seedUser, storedUser } from '../support/users-db.js';

const OLD = 'Old-Password-1';
const NEW = 'New-Password-2';
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$c2VjcmV0aGFzaA';
const AT = new Date('2026-10-04T08:30:00.000Z');
const FACTS = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() } as const;
const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => ({ now: new Date(), purpose: 'request', ip: '198.51.100.4', ...over });

class RecordingMailer extends PasswordMailer {
  public readonly mails: PasswordMail[] = [];
  public async send(mail: PasswordMail): Promise<void> {
    this.mails.push(mail);
  }
}

async function markerRows(userId: number): Promise<number> {
  return Number(await User.query().Driver.select().from('users_metadata').where('user_id', userId).where('Key', USER_COMMON_METADATA.USER_INVITE_PENDING).selectCount());
}

/** Calls the hook's after phase the way the runner does after `action` returned `output`. */
async function after(action: ActionName, input: Record<string, unknown>, output: unknown): Promise<void> {
  const hook = await DI.resolve(UserPasswordStateHook);
  await hook.after({ action, input, output, bag: new Map(), depth: 1 } as unknown as AfterContext<ActionName>);
}

const redeemed = (id: IdentityRef, purpose: 'reset' | 'invite', at = AT) => after('authn.password.reset.redeem', { login: 'whoever', ctx: ctx({ now: at }) }, { status: 'reset', purpose, id });

describe('UserPasswordStateHook (HOOK-4, R2)', function () {
  this.timeout(60000);

  let emit: sinon.SinonStub;
  const emitted = () => emit.args.map((a) => a[0] as unknown);

  before(() => {
    registerUsersTestHost();
  });

  beforeEach(async () => {
    await bootUsersDb();
    emit = sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
  });

  afterEach(() => {
    sinon.restore();
    releaseUsersHost();
    DI.clearCache();
  });

  async function setup() {
    const passwords = new UserPasswordStore();
    const hasher = new Argon2PasswordHasher({});
    await hasher.resolve();
    const mailer = new RecordingMailer();
    const sessions = new MemorySessionIssuer();
    const service = new LocalPasswordService({
      identities: new UserIdentityStore(),
      passwords,
      sessions,
      throttle: new FakeBackoffThrottle(DEFAULT_THROTTLE),
      tokens: null,
      secrets: new MemorySecretStore(),
      mailer,
      verifier: new UserAddressVerifier(),
      sinks: [await DI.resolve(QueueAuthnEventSink)],
      hasher,
      policy: new LocalPasswordPolicy({}),
      hooks: await DI.resolve<Hooks>(Hooks),
    });
    const secretOf = (ref: IdentityRef, purpose: 'reset' | 'invite') => [...mailer.mails].reverse().find((m) => m.identity.id === ref.id && m.purpose === purpose)!.secret;
    return { service, passwords, hasher, sessions, secretOf };
  }

  type Parts = Awaited<ReturnType<typeof setup>>;

  async function withPassword(x: Parts, login: string, over: { active?: boolean; invitePending?: boolean } = {}) {
    const seeded = await seedUser({ login, email: `${login}@spinajs.pl`, ...over });
    await x.passwords.set(seeded.ref, await x.hasher.hash(OLD));
    return seeded;
  }

  const recorded = async (ref: IdentityRef) => (await storedUser(ref.id)).PasswordSetAt?.toMillis() ?? null;

  it('is a registered ActionHook on authn.password.change, .set and .reset.redeem', async () => {
    const hooks = await DI.resolve(Array.ofType(ActionHook));
    const hook = hooks.find((h) => h instanceof UserPasswordStateHook);
    expect(hook).to.exist;
    expect(hook!.actions).to.have.members(['authn.password.change', 'authn.password.set', 'authn.password.reset.redeem']);
  });

  describe('PasswordSetAt over the real LocalPasswordService', () => {
    it('is written on a change', async () => {
      const x = await setup();
      const { ref } = await withPassword(x, 'state-change');
      const session = await x.sessions.issue(ref, FACTS);
      const now = new Date('2026-10-05T10:00:00.000Z');

      expect((await x.service.change(ref, OLD, NEW, session, ctx({ now, purpose: 'reauth' }))).status).to.eq('changed');

      expect(await recorded(ref)).to.eq(now.getTime());
    });

    it('is written on an admin set', async () => {
      const x = await setup();
      const { ref } = await withPassword(x, 'state-set');
      const now = new Date('2026-10-05T11:00:00.000Z');

      expect((await x.service.set(ref, NEW, ctx({ now }), { actor: { type: 'user', id: 'admin-1' } })).status).to.eq('set');

      expect(await recorded(ref)).to.eq(now.getTime());
    });

    it('is written on a reset', async () => {
      const x = await setup();
      const { ref } = await withPassword(x, 'state-reset');
      await x.service.requestReset('state-reset@spinajs.pl', ctx());
      await x.service.drain();
      const now = new Date('2026-10-05T12:00:00.000Z');

      expect(await x.service.redeemReset('state-reset@spinajs.pl', x.secretOf(ref, 'reset'), NEW, ctx({ now }))).to.deep.eq({ status: 'reset', purpose: 'reset' });

      expect(await recorded(ref)).to.eq(now.getTime());
    });

    it('is not written on the expiry marker, admin or aged', async () => {
      const x = await setup();
      const { ref } = await withPassword(x, 'state-expire');

      await x.service.expire(ref, { cause: 'admin', actor: { type: 'user', id: 'admin-1' } }, ctx());
      await x.service.expire(ref, { cause: 'aged' }, ctx());

      expect(await recorded(ref)).to.eq(null);
    });

    it('is not written on a failed change or a rejected set', async () => {
      const x = await setup();
      const { ref } = await withPassword(x, 'state-failed');
      const session = await x.sessions.issue(ref, FACTS);

      expect((await x.service.change(ref, 'Wrong-Password-9', NEW, session, ctx({ purpose: 'reauth' }))).status).to.eq('invalid');
      expect((await x.service.set(ref, 'short', ctx())).status).to.eq('rejected');

      expect(await recorded(ref)).to.eq(null);
    });

    it('an invite redeem activates the pending account, marks the address verified and emits UserActivated', async () => {
      const x = await setup();
      const { ref } = await withPassword(x, 'state-invite', { active: false, invitePending: true });
      await x.service.invite(ref, ctx());
      await x.service.drain();
      const now = new Date('2026-10-05T13:00:00.000Z');

      expect(await x.service.redeemReset('state-invite@spinajs.pl', x.secretOf(ref, 'invite'), NEW, ctx({ now }))).to.deep.eq({ status: 'reset', purpose: 'invite' });

      const u = await storedUser(ref.id);
      expect(Boolean(u.IsActive)).to.eq(true);
      expect(await markerRows(u.Id)).to.eq(0);
      expect(u.EmailVerifiedAt?.toMillis()).to.eq(now.getTime());
      expect(u.PasswordSetAt?.toMillis()).to.eq(now.getTime());
      expect(emitted().filter((e) => e instanceof UserActivated).map((e) => e.UserUUID)).to.deep.eq([ref.id]);
    });

    it('an invite completed with a reset link activates the account too', async () => {
      const x = await setup();
      const { ref } = await withPassword(x, 'state-invite-reset', { active: false, invitePending: true });
      await x.service.requestReset('state-invite-reset@spinajs.pl', ctx());
      await x.service.drain();

      expect(await x.service.redeemReset('state-invite-reset@spinajs.pl', x.secretOf(ref, 'reset'), NEW, ctx())).to.deep.eq({ status: 'reset', purpose: 'reset' });

      const u = await storedUser(ref.id);
      expect(Boolean(u.IsActive)).to.eq(true);
      expect(await markerRows(u.Id)).to.eq(0);
      expect(u.EmailVerifiedAt).to.be.ok;
    });

    it('a plain reset of an active account does not mark the address verified', async () => {
      const x = await setup();
      const { ref } = await withPassword(x, 'state-plain-reset');
      await x.service.requestReset('state-plain-reset@spinajs.pl', ctx());
      await x.service.drain();

      await x.service.redeemReset('state-plain-reset@spinajs.pl', x.secretOf(ref, 'reset'), NEW, ctx());

      expect((await storedUser(ref.id)).EmailVerifiedAt).to.not.be.ok;
      expect(emitted().some((e) => e instanceof UserActivated)).to.eq(false);
    });
  });

  describe('the after phase', () => {
    it('never moves PasswordSetAt back: an older time leaves it', async () => {
      const { ref } = await seedUser({ login: 'state-late', password: HASH });

      await after('authn.password.set', { id: ref, ctx: ctx({ now: AT }) }, { status: 'set' });
      await after('authn.password.change', { id: ref, session: { id: 's' }, ctx: ctx({ now: new Date(AT.getTime() - 3_600_000) }) }, { status: 'changed' });
      expect(await recorded(ref)).to.eq(AT.getTime());

      await after('authn.password.change', { id: ref, session: { id: 's' }, ctx: ctx({ now: new Date(AT.getTime() + 1000) }) }, { status: 'changed' });
      expect(await recorded(ref)).to.eq(AT.getTime() + 1000);
    });

    for (const [title, action, input, output] of [
      ['a refused change', 'authn.password.change', (r: IdentityRef) => ({ id: r, session: { id: 's' }, ctx: ctx() }), { status: 'refused', code: 'nope' }],
      ['a rejected set', 'authn.password.set', (r: IdentityRef) => ({ id: r, ctx: ctx() }), { status: 'rejected', violations: ['length'] }],
      ['an invalid redeem', 'authn.password.reset.redeem', () => ({ login: 'x', ctx: ctx() }), { status: 'invalid' }],
      ['a non-user identity', 'authn.password.set', (r: IdentityRef) => ({ id: { type: 'service', id: r.id }, ctx: ctx() }), { status: 'set' }],
    ] as const) {
      it(`writes nothing for ${title}`, async () => {
        const { ref } = await seedUser({ login: 'state-nothing', password: HASH, active: false, invitePending: true });

        await after(action, input(ref), output);

        const u = await storedUser(ref.id);
        expect(await recorded(ref)).to.eq(null);
        expect(Boolean(u.IsActive)).to.eq(false);
        expect(u.EmailVerifiedAt, 'a failed redeem marks nothing').to.not.be.ok;
      });
    }

    it('activates an invited account once, drops the marker and emits UserChanged and UserActivated (idempotent)', async () => {
      const { ref } = await seedUser({ login: 'invitee', active: false, invitePending: true });

      await redeemed(ref, 'invite');
      await redeemed(ref, 'invite');

      const u = await storedUser(ref.id);
      expect(Boolean(u.IsActive)).to.eq(true);
      expect(await markerRows(u.Id)).to.eq(0);
      expect(u.EmailVerifiedAt?.toMillis()).to.eq(AT.getTime());
      expect(emitted().filter((e) => e instanceof UserActivated).map((e) => e.UserUUID)).to.deep.eq([ref.id]);
      expect(emitted().filter((e) => e instanceof UserChanged)).to.have.lengthOf(1);
    });

    it('loses to a deactivation racing the redeem: deactivate drops the marker before it writes IsActive', async () => {
      const { ref } = await seedUser({ login: 'invite-race', active: false, invitePending: true });
      const invitePending: string = USER_COMMON_METADATA.USER_INVITE_PENDING;
      let raced = false;
      const drop = sinon.stub(MetadataRelation.prototype, 'delete');
      drop.callsFake(async function (this: MetadataRelation<any, any>, key: string) {
        if (key === invitePending && !raced) {
          raced = true;
          await redeemed(ref, 'invite');
        }
        return drop.wrappedMethod.call(this, key);
      });

      await deactivate(await storedUser(ref.id));

      expect(raced).to.eq(true);
      expect(Boolean((await storedUser(ref.id)).IsActive)).to.eq(false);
    });

    it('a late redeem does not reactivate a deactivated account', async () => {
      const { ref } = await seedUser({ login: 'invite-late', active: false, invitePending: true });
      await deactivate(await storedUser(ref.id));

      await redeemed(ref, 'invite');

      expect(Boolean((await storedUser(ref.id)).IsActive)).to.eq(false);
      expect(emitted().some((e) => e instanceof UserActivated)).to.eq(false);
    });

    it('activates only over a marker stored as boolean true', async () => {
      const { user, ref } = await seedUser({ login: 'invite-text', active: false });
      user.Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING] = 'true';
      await user.Metadata.update();

      await redeemed(ref, 'invite');

      expect(Boolean((await storedUser(ref.id)).IsActive)).to.eq(false);
      expect(emitted().some((e) => e instanceof UserActivated)).to.eq(false);
    });

    it('leaves an identity without the marker inactive', async () => {
      const { ref } = await seedUser({ login: 'not-invited', active: false });

      await redeemed(ref, 'reset');

      expect(Boolean((await storedUser(ref.id)).IsActive)).to.eq(false);
      expect(emitted().some((e) => e instanceof UserActivated)).to.eq(false);
    });

    it('logs each failure by its class and does not throw', async () => {
      const { ref } = await seedUser({ login: 'invite-broken', active: false, invitePending: true });
      const hook = (await DI.resolve(UserPasswordStateHook)) as unknown as { Log: { warn: (fields: Record<string, unknown>, template: string) => void } };
      const warn = sinon.stub(hook.Log, 'warn');
      sinon.stub(UserPasswordStateHook.prototype as unknown as { recordPasswordSet: () => Promise<void> }, 'recordPasswordSet').rejects(new Error(`UPDATE users SET Password = '${HASH}'`));
      sinon.stub(UserPasswordStateHook.prototype as unknown as { activateInvited: () => Promise<boolean> }, 'activateInvited').rejects(new TypeError('boom'));

      await redeemed(ref, 'invite');

      expect(warn.callCount).to.eq(2);
      expect(warn.args.map(([fields, template]) => renderTemplate(template, fields))).to.deep.eq([
        `Could not record when its password was set on authn.password.reset.redeem of user ${ref.id}: Error`,
        `Could not activate its invited account on authn.password.reset.redeem of user ${ref.id}: TypeError`,
      ]);
      expect(JSON.stringify(warn.args)).to.not.contain(HASH);
      // The invite secret was mailed to that address: the mark does not depend on the activation.
      expect((await storedUser(ref.id)).EmailVerifiedAt?.toMillis()).to.eq(AT.getTime());
    });
  });
});
