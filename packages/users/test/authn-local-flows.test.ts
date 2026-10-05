import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { DefaultQueueService } from '@spinajs/queue';
import { DEFAULT_THROTTLE, FakeBackoffThrottle, MemorySecretStore, MemorySessionIssuer, RecordingEventSink } from '@spinajs/authn-testing';
import type { AuthnContext, IdentityRef } from '@spinajs/authn/contracts';
import { Argon2PasswordHasher, EXPIRED_PASSWORD_MARKER, LocalPasswordPolicy, LocalPasswordService, LocalPasswordStrategy, PasswordExpirationJob, PasswordMailer } from '@spinajs/authn-local';
import type { PasswordMail } from '@spinajs/authn-local';

import { QueueAuthnEventSink, UserAccountSink, UserActivated, UserIdentityStore, UserPasswordAgeSource, UserPasswordChanged, UserPasswordStore } from '../src/index.js';
import { UserPasswordExpired } from '../src/events/UserPasswordExpired.js';
import { bootUsersDb, registerUsersTestHost, seedUser, storedUser } from './support/users-db.js';

const OLD = 'Old-Password-1';
const NEW = 'New-Password-2';
const T0 = new Date('2026-06-01T10:00:00.000Z');
const ctx = (now: Date, over: Partial<AuthnContext> = {}): AuthnContext => ({ now, purpose: 'request', ip: '198.51.100.4', ...over });
const later = (days: number) => new Date(T0.getTime() + days * 86_400_000);

class RecordingMailer extends PasswordMailer {
  public readonly mails: PasswordMail[] = [];
  public async send(mail: PasswordMail): Promise<void> {
    this.mails.push(mail);
  }
}

/** authn-local's password flows over the users stores and sinks; only sessions, throttle and secrets are kit fakes. */
describe('authn-local password flows over the users stores', function () {
  this.timeout(60000);

  let emit: sinon.SinonStub;

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

  async function setup() {
    const identities = new UserIdentityStore();
    const passwords = new UserPasswordStore();
    const hasher = new Argon2PasswordHasher({});
    await hasher.resolve();
    const events = new RecordingEventSink();
    const mailer = new RecordingMailer();
    const sinks = [await DI.resolve(UserAccountSink), await DI.resolve(QueueAuthnEventSink), events];
    const sessions = new MemorySessionIssuer();
    const service = new LocalPasswordService({ identities, passwords, sessions, throttle: new FakeBackoffThrottle(DEFAULT_THROTTLE), tokens: null, secrets: new MemorySecretStore(), mailer, sinks, hasher, policy: new LocalPasswordPolicy({}) });
    const strategy = new LocalPasswordStrategy({ identities, passwords, hasher });
    await strategy.resolve();

    const login = (name: string, password: string) => strategy.verify({ kind: 'password', login: name, password }, ctx(T0, { purpose: 'login' }));
    const setAt = async (ref: IdentityRef) => (await storedUser(ref.id)).PasswordSetAt?.toMillis() ?? null;

    return { identities, passwords, hasher, events, mailer, sessions, service, strategy, login, setAt };
  }

  it('an admin set stores the hash, records PasswordSetAt and lets the user log in', async () => {
    const x = await setup();
    const { ref } = await seedUser({ login: 'flow-set' });

    expect(await x.service.set(ref, OLD, ctx(T0))).to.deep.eq({ status: 'set' });

    expect(await x.setAt(ref)).to.eq(T0.getTime());
    expect((await x.login('flow-set', OLD)).ok).to.eq(true);
    expect(emit.args.map((a) => a[0]).some((e) => e instanceof UserPasswordChanged)).to.eq(true);
  });

  it('a change moves PasswordSetAt', async () => {
    const x = await setup();
    const { ref } = await seedUser({ login: 'flow-change' });
    await x.service.set(ref, OLD, ctx(T0));
    const session = await x.sessions.issue(ref, { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: T0 });

    expect((await x.service.change(ref, OLD, NEW, session, ctx(later(3)))).status).to.eq('changed');

    expect(await x.setAt(ref)).to.eq(later(3).getTime());
    expect((await x.login('flow-change', NEW)).ok).to.eq(true);
  });

  it('a login rehash rewrites the hash over the verified one without moving PasswordSetAt', async () => {
    const x = await setup();
    const { ref } = await seedUser({ login: 'flow-rehash' });
    await x.service.set(ref, OLD, ctx(T0));
    const weak = await x.hasher.hashWith(OLD, { argon2: { memoryCost: 4096, timeCost: 2, parallelism: 1 }, pepper: null });
    await x.passwords.set(ref, weak);

    expect((await x.login('flow-rehash', OLD)).ok).to.eq(true);

    const stored = await x.passwords.get(ref);
    expect(stored).to.not.eq(weak);
    expect(await x.hasher.verify(stored, OLD)).to.eq(true);
    expect(await x.setAt(ref)).to.eq(T0.getTime());
  });

  it("an expiry stores '!expired' without moving PasswordSetAt and emits UserPasswordExpired", async () => {
    const x = await setup();
    const { ref } = await seedUser({ login: 'flow-expire' });
    await x.service.set(ref, OLD, ctx(T0));

    await x.service.expire(ref, { cause: 'aged' }, ctx(later(40)));

    expect(await x.passwords.get(ref)).to.eq(EXPIRED_PASSWORD_MARKER);
    expect(await x.setAt(ref)).to.eq(T0.getTime());
    expect((await x.login('flow-expire', OLD)).ok).to.eq(false);
    expect(emit.args.map((a) => a[0]).some((e) => e instanceof UserPasswordExpired)).to.eq(true);
  });

  it('redeeming an invite sets the first password, records PasswordSetAt and activates the account', async () => {
    const x = await setup();
    const { ref } = await seedUser({ login: 'flow-invite', email: 'flow-invite@spinajs.pl', active: false, invitePending: true });

    await x.service.invite(ref, ctx(T0));
    const [mail] = x.mailer.mails;
    expect(await x.service.redeemReset('flow-invite@spinajs.pl', mail.secret, NEW, ctx(later(0.001)))).to.deep.eq({ status: 'reset', purpose: 'invite' });

    const u = await storedUser(ref.id);
    expect(Boolean(u.IsActive)).to.eq(true);
    expect(u.PasswordSetAt.toMillis()).to.eq(later(0.001).getTime());
    expect(emit.args.map((a) => a[0]).filter((e) => e instanceof UserActivated)).to.have.lengthOf(1);
    expect((await x.login('flow-invite', NEW)).ok).to.eq(true);
  });

  it('a reset moves PasswordSetAt', async () => {
    const x = await setup();
    const { ref } = await seedUser({ login: 'flow-reset', email: 'flow-reset@spinajs.pl' });
    await x.service.set(ref, OLD, ctx(T0));

    await x.service.requestReset('flow-reset@spinajs.pl', ctx(later(1)));
    await x.service.drain();
    const [mail] = x.mailer.mails;
    expect(await x.service.redeemReset('flow-reset@spinajs.pl', mail.secret, NEW, ctx(later(2)))).to.deep.eq({ status: 'reset', purpose: 'reset' });

    expect(await x.setAt(ref)).to.eq(later(2).getTime());
  });

  it('the expiry job expires exactly the passwords UserPasswordAgeSource lists as too old', async () => {
    const x = await setup();
    const { ref: old } = await seedUser({ login: 'flow-age-old' });
    const { ref: fresh } = await seedUser({ login: 'flow-age-fresh' });
    await x.service.set(old, OLD, ctx(T0));
    await x.service.set(fresh, OLD, ctx(later(20)));

    const job = new PasswordExpirationJob({ ages: new UserPasswordAgeSource(), passwords: x.passwords, service: x.service, enabled: true, maxAgeDays: 31 });
    const result = await job.run(later(40));

    expect(result).to.deep.include({ expired: 1, failed: 0 });
    expect(await x.passwords.get(old)).to.eq(EXPIRED_PASSWORD_MARKER);
    expect(await x.passwords.get(fresh)).to.not.eq(EXPIRED_PASSWORD_MARKER);
    expect(await new UserPasswordAgeSource().passwordsSetBefore(later(100))).to.not.deep.include(old);
  });
});
