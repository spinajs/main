import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { DefaultQueueService } from '@spinajs/queue';
import { AuthnAudit } from '@spinajs/authn/audit';
import { AuthnEventListener } from '@spinajs/authn/contracts';
import type { AuthnEvent, AuthnEventType, IdentityRef } from '@spinajs/authn/contracts';

import { QueueAuthnEventListener, UserImpersonationEnded, UserImpersonationStarted, UserLogged, UserLoginFailed, UserPasswordChangeRequest, UserPasswordChanged } from '../src/index.js';
import { UserPasswordExpired } from '../src/events/UserPasswordExpired.js';
import { InvalidCredentials, UserIsBanned, UserNotActive } from '../src/exceptions.js';
import { bootUsersDb, registerUsersTestHost, seedUser } from './support/users-db.js';

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$c2VjcmV0aGFzaA';
const AT = new Date('2026-10-04T08:30:00.000Z');

const event = (type: AuthnEventType, identity: IdentityRef | undefined, over: Partial<AuthnEvent> = {}): AuthnEvent => ({ type, at: AT, outcome: 'success', ...(identity ? { identity } : {}), ...over });

describe('users authn event listeners', function () {
  this.timeout(30000);

  let emit: sinon.SinonStub;
  const emitted = (): object[] => emit.args.map(([sent]: object[]) => sent);

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

  // R2: UserPasswordStateHook (test/hooks/password-state.test.ts) took over what UserAccountSink did.
  it('QueueAuthnEventListener is a registered AuthnEventListener, and no users listener writes the password state', async () => {
    const listeners = await DI.resolve(Array.ofType(AuthnEventListener));

    expect(listeners.some((s) => s instanceof QueueAuthnEventListener)).to.eq(true);
    expect(listeners.map((s) => s.constructor.name)).to.not.include('UserAccountSink');
  });

  it('AuthnAudit delivers once to QueueAuthnEventListener, and its failure does not fail the publish', async () => {
    const { ref } = await seedUser({ login: 'once', password: HASH });
    const audit = await DI.resolve(AuthnAudit);

    expect(audit.listeners().filter((l) => l instanceof QueueAuthnEventListener)).to.have.lengthOf(1);
    await audit.publish(event('login', ref));
    expect(emitted().map((x) => x.constructor)).to.deep.eq([UserLogged]);

    emit.rejects(new Error('queue down'));
    await audit.publish(event('login', ref));
  });

  describe('QueueAuthnEventListener', () => {
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

        await (await DI.resolve(QueueAuthnEventListener)).on(e(ref));

        const sent = only();
        expect(sent).to.be.instanceOf(type);
        expect(sent.UserUUID).to.eq(ref.id);
        expect(JSON.stringify(sent)).to.not.contain(HASH);
      });
    }

    it('maps a login failure with an identity to UserLoginFailed, carrying the reason only', async () => {
      const { ref } = await seedUser({ login: 'failed', password: HASH });

      await (await DI.resolve(QueueAuthnEventListener)).on(event('login', ref, { outcome: 'failure', reason: 'invalid_credentials' }));
      await (await DI.resolve(QueueAuthnEventListener)).on(event('login', undefined, { outcome: 'failure', reason: 'unknown_login' }));

      const sent = only() as unknown as UserLoginFailed;
      expect(sent).to.be.instanceOf(UserLoginFailed);
      expect(sent.UserUUID).to.eq(ref.id);
      expect(sent.Error.message).to.eq('Login failed: invalid_credentials');
      expect(sent.Error).to.be.instanceOf(InvalidCredentials);
    });

    it('gives UserLoginFailed the error class of a status refusal', async () => {
      const { ref } = await seedUser({ login: 'refused', password: HASH });
      const sink = await DI.resolve(QueueAuthnEventListener);

      for (const reason of ['banned', 'inactive', 'deleted', 'wrong_password']) {
        await sink.on(event('login', ref, { outcome: 'failure', reason }));
      }

      const errors = emitted().map((x) => (x as UserLoginFailed).Error);
      expect(errors.map((e) => e.constructor)).to.deep.eq([UserIsBanned, UserNotActive, UserNotActive, InvalidCredentials]);
      expect(errors.map((e) => e.message)).to.deep.eq(['Login failed: banned', 'Login failed: inactive', 'Login failed: deleted', 'Login failed: wrong_password']);
    });

    // A blocking listener stopped the login: the credentials were right, so no UserLoginFailed error class describes it.
    it('re-emits nothing for a login that a blocking listener stopped (listener_failed)', async () => {
      const { ref } = await seedUser({ login: 'stopped', password: HASH });

      await (await DI.resolve(QueueAuthnEventListener)).on(event('login', ref, { outcome: 'failure', reason: 'listener_failed' }));

      expect(emitted()).to.deep.eq([]);
    });

    it('maps impersonation start, end and expiry with the impersonator as UserUUID', async () => {
      const { ref: admin } = await seedUser({ login: 'impersonator' });
      const { ref: target } = await seedUser({ login: 'impersonated' });
      const sink = await DI.resolve(QueueAuthnEventListener);

      await sink.on(event('impersonation.start', target, { actor: admin }));
      await sink.on(event('impersonation.end', target, { actor: admin }));
      await sink.on(event('impersonation.expire', target, { actor: admin, reason: 'max_minutes' }));
      await sink.on(event('impersonation.start', target, { actor: admin, outcome: 'failure', reason: 'no_guard' }));

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
      const sink = await DI.resolve(QueueAuthnEventListener);

      await sink.on(event('password.reset', ref));
      await sink.on(event('password.reset', { type: 'service', id: ref.id }));
      await sink.on(event('password.reset', { type: 'user', id: '00000000-0000-4000-8000-000000000000' }));
      await sink.on(event('login', undefined));

      expect(only().UserUUID).to.eq(ref.id);
    });

    it('ignores failures and other event types', async () => {
      const { ref } = await seedUser({ login: 'quiet', password: HASH });
      const sink = await DI.resolve(QueueAuthnEventListener);

      await sink.on(event('password.change', ref, { outcome: 'failure', reason: 'stale' }));
      await sink.on(event('session.issue', ref));
      await sink.on(event('invite.redeem', ref));

      expect(emitted()).to.deep.eq([]);
    });
  });
});
