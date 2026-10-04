import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { AuthnContext } from '@spinajs/authn/contracts';
import { DEFAULT_THROTTLE, FakeBackoffThrottle, FakeIdentityStore, MemoryPasswordCredentialStore, MemorySecretStore, MemorySessionIssuer, RecordingEventSink } from '@spinajs/authn-testing';
import { Argon2PasswordHasher, LocalPasswordPolicy, LocalPasswordService, PasswordMailer } from '@spinajs/authn-local';

import { EmailPasswordMailer, EmailSend, EmailSent, IEmail } from '../src/index.js';
import { capturingEmailService, dump, holds } from './capture.js';

const LOGIN = 'alice@example.com';
const RESET_URL = 'https://app.example.com/password-reset';
const ctx = (): AuthnContext => ({ now: new Date(), purpose: 'request', ip: '198.51.100.4', userAgent: 'mocha' });

// Compile-time only: the mailer registers under authn-local's abstract class, which this package never imports at runtime.
const wiring = () => DI.register(EmailPasswordMailer).as(PasswordMailer);
void wiring;

function setup() {
  const email = capturingEmailService();
  const identities = new FakeIdentityStore();
  const events = new RecordingEventSink();
  const warnings: string[] = [];
  const service = new LocalPasswordService({
    identities,
    passwords: new MemoryPasswordCredentialStore(),
    sessions: new MemorySessionIssuer(),
    throttle: new FakeBackoffThrottle(DEFAULT_THROTTLE),
    tokens: null,
    secrets: new MemorySecretStore(),
    mailer: new EmailPasswordMailer({ email: email.service, options: { connection: 'test' } }),
    sinks: [events],
    hasher: new Argon2PasswordHasher({}),
    policy: new LocalPasswordPolicy({}),
    log: { warn: (m: string) => warnings.push(m) },
    resetUrl: RESET_URL,
  });
  const alice = identities.add({ login: LOGIN, email: LOGIN, name: 'Alice' });
  const dave = identities.add({ login: 'dave@example.com', email: 'dave@example.com', name: 'Dave', status: { active: false, invitePending: true } });
  return { ...email, service, events, warnings, alice, dave };
}

function expectNothingHolds(text: string, secrets: string[]) {
  for (const s of secrets) {
    expect(holds(text, s), 'leaked a secret').to.equal(false);
  }
}

describe('SR-09 password mails through @spinajs/email', function () {
  this.timeout(60_000);

  it('SR-09 queued mail holds no secret: the secret reaches only the transport, never the queue, the email log or an error', async () => {
    const x = setup();

    await x.service.invite(x.dave, ctx());
    expect(await x.service.requestReset(LOGIN, ctx())).to.deep.equal({ status: 'accepted' });
    await x.service.drain();

    expect(x.sender.Captured.map((m) => m.tag)).to.deep.equal(['authn-password-invite', 'authn-password-reset']);
    const secrets = x.sender.Captured.map((m: IEmail) => m.model.Token as string);
    for (const [i, m] of x.sender.Captured.entries()) {
      expect(secrets[i]).to.be.a('string').and.not.equal('');
      expect(m.model.ResetUrl).to.contain(encodeURIComponent(secrets[i]));
    }

    expect(
      x.emitted.some((e) => e instanceof EmailSend),
      'nothing is queued as a job',
    ).to.equal(false);
    expect(x.emitted.every((e) => e instanceof EmailSent)).to.equal(true);
    expectNothingHolds(dump(x.emitted), secrets);
    expectNothingHolds(dump([x.logged, x.perf]), secrets);
    expectNothingHolds(dump([x.warnings, x.events.all()]), secrets);
  });

  it('SR-09 a transport error holding the secret leaves it in no log, event or thrown error', async () => {
    const x = setup();
    x.sender.fail = (m: IEmail) => new Error(`550 rejected ${m.model.ResetUrl} token ${m.model.Token}`, { cause: new Error(m.model.Token) });

    const thrown = await x.service.invite(x.dave, ctx()).then(
      () => null,
      (e: unknown) => e,
    );
    await x.service.requestReset(LOGIN, ctx());
    await x.service.drain();

    expect(thrown).to.not.equal(null);
    expect(x.sender.Captured).to.have.length(2);
    const secrets = x.sender.Captured.map((m: IEmail) => m.model.Token as string);
    expect(x.perf.filter((m) => m.error !== undefined)).to.have.length(2);
    expectNothingHolds(dump(thrown), secrets);
    expectNothingHolds(dump(x.emitted), secrets);
    expectNothingHolds(dump([x.logged, x.perf]), secrets);
    expectNothingHolds(dump([x.warnings, x.events.all()]), secrets);
    expect(x.emitted).to.have.length(0);
  });
});
