import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { DefaultQueueService } from '@spinajs/queue';
import { AuthnEventSink } from '@spinajs/authn/contracts';
import type { AuthnEvent, AuthnEventType, IdentityRef } from '@spinajs/authn/contracts';

import { QueueAuthnEventSink, USER_COMMON_METADATA, User, UserAccountSink, UserActivated, UserChanged, UserImpersonationEnded, UserImpersonationStarted, UserLogged, UserLoginFailed, UserPasswordChangeRequest, UserPasswordChanged } from '../src/index.js';
import { UserPasswordExpired } from '../src/events/UserPasswordExpired.js';
import { MetadataRelation } from '@spinajs/orm';
import { deactivate } from '../src/actions.js';
import { bootUsersDb, registerUsersTestHost, seedUser, storedUser } from './support/users-db.js';

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$c2VjcmV0aGFzaA';
const AT = new Date('2026-10-04T08:30:00.000Z');

async function markerRows(userId: number): Promise<number> {
  return Number(await User.query().Driver.select().from('users_metadata').where('user_id', userId).where('Key', USER_COMMON_METADATA.USER_INVITE_PENDING).selectCount());
}

const event = (type: AuthnEventType, identity: IdentityRef | undefined, over: Partial<AuthnEvent> = {}): AuthnEvent => ({ type, at: AT, outcome: 'success', ...(identity ? { identity } : {}), ...over });

describe('users authn event sinks', function () {
  this.timeout(30000);

  let emit: sinon.SinonStub;
  const emitted = () => emit.args.map((a) => a[0]);

  before(() => {
    registerUsersTestHost();
  });

  beforeEach(async () => {
    await bootUsersDb();
    emit = sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  it('both are registered AuthnEventSinks', async () => {
    const sinks = await DI.resolve(Array.ofType(AuthnEventSink));

    expect(sinks.some((s) => s instanceof UserAccountSink)).to.eq(true);
    expect(sinks.some((s) => s instanceof QueueAuthnEventSink)).to.eq(true);
  });

  describe('UserAccountSink: PasswordSetAt', () => {
    const recorded = async (ref: IdentityRef) => (await storedUser(ref.id)).PasswordSetAt?.toMillis() ?? null;

    for (const [title, e] of [
      ['an admin set (password.change, cause set)', (r: IdentityRef) => event('password.change', r, { data: { cause: 'set' } })],
      ['a change (password.change)', (r: IdentityRef) => event('password.change', r)],
      ['a reset (password.reset)', (r: IdentityRef) => event('password.reset', r)],
      ['an invite (invite.redeem)', (r: IdentityRef) => event('invite.redeem', r)],
    ] as const) {
      it(`records event.at for ${title}`, async () => {
        const { ref } = await seedUser({ login: 'age-sink', password: HASH });
        const sink = await DI.resolve(UserAccountSink);

        await sink.publish(e(ref));

        expect(await recorded(ref)).to.eq(AT.getTime());
      });
    }

    for (const [title, e] of [
      ['an expiry (data.expired)', (r: IdentityRef) => event('password.change', r, { data: { cause: 'aged', expired: true } })],
      ['a failed change', (r: IdentityRef) => event('password.change', r, { outcome: 'failure', reason: 'wrong_password' })],
      ['a failed reset', (r: IdentityRef) => event('password.reset', r, { outcome: 'failure', reason: 'secret' })],
      ['a login', (r: IdentityRef) => event('login', r)],
      ['a reset request', (r: IdentityRef) => event('password.reset.request', r)],
      ['a non-user identity', (r: IdentityRef) => event('password.change', { type: 'service', id: r.id })],
    ] as const) {
      it(`leaves it alone for ${title}`, async () => {
        const { ref } = await seedUser({ login: 'age-sink', password: HASH });
        const sink = await DI.resolve(UserAccountSink);

        await sink.publish(e(ref));

        expect(await recorded(ref)).to.eq(null);
      });
    }

    it('never moves it back: an event older than the recorded time leaves it', async () => {
      const { ref } = await seedUser({ login: 'age-late', password: HASH });
      const sink = await DI.resolve(UserAccountSink);

      await sink.publish(event('password.reset', ref));
      await sink.publish(event('password.change', ref, { at: new Date(AT.getTime() - 3_600_000) }));
      expect(await recorded(ref)).to.eq(AT.getTime());

      await sink.publish(event('password.change', ref, { at: new Date(AT.getTime() + 1000) }));
      expect(await recorded(ref)).to.eq(AT.getTime() + 1000);
    });
  });

  describe('UserAccountSink: invite activation', () => {
    it('activates an invited account on invite.redeem, drops the marker and emits UserActivated, once', async () => {
      const { ref } = await seedUser({ login: 'invitee', active: false, invitePending: true });
      const sink = await DI.resolve(UserAccountSink);

      await sink.publish(event('invite.redeem', ref, { data: { via: 'reset' } }));
      await sink.publish(event('invite.redeem', ref));

      const u = await storedUser(ref.id);
      expect(Boolean(u.IsActive)).to.eq(true);
      expect(await markerRows(u.Id)).to.eq(0);
      expect(emitted().filter((x) => x instanceof UserActivated).map((x) => (x as UserActivated).UserUUID)).to.deep.eq([ref.id]);
      expect(emitted().some((x) => x instanceof UserChanged)).to.eq(true);
    });

    it('loses to a deactivation racing the redeem: deactivate drops the marker before it writes IsActive', async () => {
      const { ref } = await seedUser({ login: 'invite-race', active: false, invitePending: true });
      const sink = await DI.resolve(UserAccountSink);
      const drop = MetadataRelation.prototype.delete;
      let raced = false;
      sinon.stub(MetadataRelation.prototype, 'delete').callsFake(async function (this: MetadataRelation<any, any>, key: string) {
        if (key === USER_COMMON_METADATA.USER_INVITE_PENDING && !raced) {
          raced = true;
          await sink.publish(event('invite.redeem', ref));
        }
        return drop.call(this, key);
      });

      await deactivate(await storedUser(ref.id));

      expect(raced).to.eq(true);
      expect(Boolean((await storedUser(ref.id)).IsActive)).to.eq(false);
    });

    it('activates only over a marker stored as boolean true, in one statement', async () => {
      const { user, ref } = await seedUser({ login: 'invite-text', active: false });
      user.Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING] = 'true';
      await user.Metadata.update();
      const sink = await DI.resolve(UserAccountSink);

      await sink.publish(event('invite.redeem', ref));

      expect(Boolean((await storedUser(ref.id)).IsActive)).to.eq(false);
      expect(emitted().some((x) => x instanceof UserActivated)).to.eq(false);
    });

    it('leaves an identity without the marker alone', async () => {
      const { ref } = await seedUser({ login: 'not-invited', active: false });
      const sink = await DI.resolve(UserAccountSink);

      await sink.publish(event('invite.redeem', ref));

      expect(Boolean((await storedUser(ref.id)).IsActive)).to.eq(false);
      expect(emitted().some((x) => x instanceof UserActivated)).to.eq(false);
    });

    it('does not activate on a failed redeem', async () => {
      const { ref } = await seedUser({ login: 'invite-failed', active: false, invitePending: true });
      const sink = await DI.resolve(UserAccountSink);

      await sink.publish(event('invite.redeem', ref, { outcome: 'failure', reason: 'secret' }));

      expect((await storedUser(ref.id)).Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING]).to.eq(true);
    });

    it('logs a failure by its class and does not throw', async () => {
      const { ref } = await seedUser({ login: 'invite-broken', active: false, invitePending: true });
      const sink = await DI.resolve(UserAccountSink);
      const warn = sinon.stub((sink as unknown as { Log: { warn: (m: string) => void } }).Log, 'warn');
      sinon.stub(UserAccountSink.prototype as unknown as { recordPasswordSet: () => Promise<void> }, 'recordPasswordSet').rejects(new Error(`UPDATE users SET Password = '${HASH}'`));
      sinon.stub(UserAccountSink.prototype as unknown as { activateInvited: () => Promise<void> }, 'activateInvited').rejects(new TypeError('boom'));

      await sink.publish(event('invite.redeem', ref));

      expect(warn.callCount).to.eq(2);
      expect(warn.args.map((a) => a[0])).to.deep.eq([`Could not record when its password was set on invite.redeem of user ${ref.id}: Error`, `Could not activate its invited account on invite.redeem of user ${ref.id}: TypeError`]);
    });
  });

  describe('QueueAuthnEventSink', () => {
    const only = () => {
      const all = emitted();
      expect(all, 'one queue event').to.have.lengthOf(1);
      return all[0] as { UserUUID: string };
    };

    for (const [title, e, type] of [
      ['login success → UserLogged', (r: IdentityRef) => event('login', r, { strategy: 'local' }), UserLogged],
      ['password.change → UserPasswordChanged', (r: IdentityRef) => event('password.change', r), UserPasswordChanged],
      ['password.change with data.expired → UserPasswordExpired', (r: IdentityRef) => event('password.change', r, { data: { cause: 'admin', expired: true } }), UserPasswordExpired],
      ['password.reset → UserPasswordChanged', (r: IdentityRef) => event('password.reset', r), UserPasswordChanged],
      ['password.reset.request → UserPasswordChangeRequest', (r: IdentityRef) => event('password.reset.request', r), UserPasswordChangeRequest],
      ['password.reset.request of an invite → UserPasswordChangeRequest', (r: IdentityRef) => event('password.reset.request', r, { data: { purpose: 'invite' } }), UserPasswordChangeRequest],
    ] as const) {
      it(`maps ${title}`, async () => {
        const { ref } = await seedUser({ login: 'queued', password: HASH });

        await (await DI.resolve(QueueAuthnEventSink)).publish(e(ref));

        const sent = only();
        expect(sent).to.be.instanceOf(type);
        expect(sent.UserUUID).to.eq(ref.id);
        expect(JSON.stringify(sent)).to.not.contain(HASH);
      });
    }

    it('maps a login failure with an identity to UserLoginFailed, carrying the reason only', async () => {
      const { ref } = await seedUser({ login: 'failed', password: HASH });

      await (await DI.resolve(QueueAuthnEventSink)).publish(event('login', ref, { outcome: 'failure', reason: 'invalid_credentials' }));
      await (await DI.resolve(QueueAuthnEventSink)).publish(event('login', undefined, { outcome: 'failure', reason: 'unknown_login' }));

      const sent = only() as unknown as UserLoginFailed;
      expect(sent).to.be.instanceOf(UserLoginFailed);
      expect(sent.UserUUID).to.eq(ref.id);
      expect(sent.Error.message).to.eq('Login failed: invalid_credentials');
    });

    it('maps impersonation start, end and expiry with the impersonator as UserUUID', async () => {
      const { ref: admin } = await seedUser({ login: 'impersonator' });
      const { ref: target } = await seedUser({ login: 'impersonated' });
      const sink = await DI.resolve(QueueAuthnEventSink);

      await sink.publish(event('impersonation.start', target, { actor: admin }));
      await sink.publish(event('impersonation.end', target, { actor: admin }));
      await sink.publish(event('impersonation.expire', target, { actor: admin, reason: 'max_minutes' }));
      await sink.publish(event('impersonation.start', target, { actor: admin, outcome: 'failure', reason: 'no_guard' }));

      const sent = emitted() as (UserImpersonationStarted | UserImpersonationEnded)[];
      expect(sent.map((x) => x.constructor)).to.deep.eq([UserImpersonationStarted, UserImpersonationEnded, UserImpersonationEnded]);
      expect(sent.map((x) => [x.UserUUID, x.TargetUUID])).to.deep.eq([
        [admin.id, target.id],
        [admin.id, target.id],
        [admin.id, target.id],
      ]);
    });

    it('re-emits for a deleted user, and nothing for a non-user, unknown or missing identity', async () => {
      const { user, ref } = await seedUser({ login: 'gone', password: HASH });
      await user.destroy();
      const sink = await DI.resolve(QueueAuthnEventSink);

      await sink.publish(event('password.reset', ref));
      await sink.publish(event('password.reset', { type: 'service', id: ref.id }));
      await sink.publish(event('password.reset', { type: 'user', id: '00000000-0000-4000-8000-000000000000' }));
      await sink.publish(event('login', undefined));

      expect(only().UserUUID).to.eq(ref.id);
    });

    it('ignores failures and other event types', async () => {
      const { ref } = await seedUser({ login: 'quiet', password: HASH });
      const sink = await DI.resolve(QueueAuthnEventSink);

      await sink.publish(event('password.change', ref, { outcome: 'failure', reason: 'stale' }));
      await sink.publish(event('session.issue', ref));
      await sink.publish(event('invite.redeem', ref));

      expect(emitted()).to.deep.eq([]);
    });
  });
});
