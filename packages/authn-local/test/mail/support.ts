import type { AuthnContext, IdentityRef } from '@spinajs/authn/contracts';
import { DEFAULT_THROTTLE, FakeBackoffThrottle, FakeIdentityStore, MemoryPasswordCredentialStore, MemorySecretStore, MemorySessionIssuer, RecordingEventSink } from '@spinajs/authn-testing';

import { Argon2PasswordHasher } from '../../src/hasher.js';
import { PasswordMail, PasswordMailer } from '../../src/mailer.js';
import { AuthnMailDispatcher } from '../../src/mail/contracts.js';
import type { AuthnMailDelivery, AuthnMailRequest } from '../../src/mail/contracts.js';
import { LocalPasswordPolicy } from '../../src/policy.js';
import { LocalPasswordService, LocalPasswordServiceDeps } from '../../src/service.js';
import { recordingLog } from '../support/recording-log.js';

export const LOGIN = 'alice@example.com';
export const RESET_URL = 'https://app.example.com/password-reset';
export const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => ({ now: new Date(), purpose: 'request', ip: '198.51.100.4', userAgent: 'mocha', ...over });

export class RecordingMailer extends PasswordMailer {
  public readonly mails: PasswordMail[] = [];
  public async send(mail: PasswordMail): Promise<void> {
    this.mails.push(mail);
  }
}

/** Records each request before handing it on. */
export class RecordingDispatcher extends AuthnMailDispatcher {
  public readonly requests: AuthnMailRequest[] = [];
  constructor(private readonly inner: AuthnMailDispatcher) {
    super();
  }
  public async dispatch(request: AuthnMailRequest): Promise<void> {
    this.requests.push(request);
    await this.inner.dispatch(request);
  }
  public drain(): Promise<void> {
    return this.inner.drain();
  }
}

/** `dispatcher` builds the dispatcher over the service's `deliver`; without it the service uses its default. */
export async function setup<D extends AuthnMailDispatcher = AuthnMailDispatcher>(over: Partial<LocalPasswordServiceDeps> = {}, dispatcher?: (deliver: AuthnMailDelivery) => D) {
  const identities = new FakeIdentityStore();
  const passwords = new MemoryPasswordCredentialStore();
  const events = new RecordingEventSink();
  const secrets = new MemorySecretStore();
  const mailer = new RecordingMailer();
  const hasher = new Argon2PasswordHasher({});
  await hasher.resolve();
  const warnings: string[] = [];
  let service: LocalPasswordService | undefined;
  const built = dispatcher?.((r) => service!.deliver(r));
  service = new LocalPasswordService({
    identities,
    passwords,
    sessions: new MemorySessionIssuer(),
    throttle: new FakeBackoffThrottle(DEFAULT_THROTTLE),
    tokens: null,
    secrets,
    mailer,
    sinks: [events],
    hasher,
    policy: new LocalPasswordPolicy({}),
    log: recordingLog(warnings),
    resetUrl: RESET_URL,
    ...(built ? { dispatcher: built } : {}),
    ...over,
  });
  const alice: IdentityRef = identities.add({ login: LOGIN, email: LOGIN, name: 'Alice' });
  return { identities, passwords, events, secrets, mailer, hasher, service, alice, warnings, dispatcher: built };
}
