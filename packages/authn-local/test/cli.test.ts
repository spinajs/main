import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { AuthnEventSink, AuthnThrottle, IdentityStore, PasswordCredentialStore, PasswordService, SecretStore, SessionIssuer } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { DEFAULT_THROTTLE, FakeBackoffThrottle, FakeIdentityStore, MemoryPasswordCredentialStore, MemorySecretStore, MemorySessionIssuer, RecordingEventSink } from '@spinajs/authn-testing';

import { Argon2PasswordHasher, EXPIRED_PASSWORD_MARKER, PasswordHasher } from '../src/hasher.js';
import { PasswordMail, PasswordMailer } from '../src/mailer.js';
import { LocalPasswordPolicy } from '../src/policy.js';
import { LocalPasswordService } from '../src/service.js';
import { PasswordAgeSource, PasswordExpirationJob } from '../src/expiration.js';
import { ExpirePasswords } from '../src/cli/ExpirePasswords.js';

const OLD = 'Old-Password-1';
const DAY = 86_400_000;

class CliRecordingMailer extends PasswordMailer {
  public readonly mails: PasswordMail[] = [];
  public async send(mail: PasswordMail): Promise<void> {
    this.mails.push(mail);
  }
}

class CliAgeSource extends PasswordAgeSource {
  public readonly setAt = new Map<IdentityRef, Date>();
  public async passwordsSetBefore(cutoff: Date): Promise<readonly IdentityRef[]> {
    return [...this.setAt].filter(([, at]) => at.getTime() < cutoff.getTime()).map(([id]) => id);
  }
}

class CliBackoffThrottle extends FakeBackoffThrottle {
  constructor() {
    super(DEFAULT_THROTTLE);
  }
}

class CliTestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      authn: { local: { hasher: { maxConcurrent: 2 }, expiration: { enabled: true, maxAgeDays: 10 } } },
    };
  }
}

describe('authn-local cli commands', function () {
  this.timeout(60_000);

  before(async () => {
    DI.setESMModuleSupport();
    DI.register(CliTestConfiguration).as(Configuration);
    DI.register(FakeIdentityStore).as(IdentityStore);
    DI.register(MemoryPasswordCredentialStore).as(PasswordCredentialStore);
    DI.register(MemorySessionIssuer).as(SessionIssuer);
    DI.register(RecordingEventSink).as(AuthnEventSink);
    DI.register(CliBackoffThrottle).as(AuthnThrottle);
    DI.register(MemorySecretStore).as(SecretStore);
    DI.register(CliRecordingMailer).as(PasswordMailer);
    DI.register(CliAgeSource).as(PasswordAgeSource);
    await DI.resolve(Configuration);
  });

  after(() => {
    DI.unregister(CliTestConfiguration);
    DI.unregister(FakeIdentityStore);
    DI.unregister(MemoryPasswordCredentialStore);
    DI.unregister(MemorySessionIssuer);
    DI.unregister(RecordingEventSink);
    DI.unregister(CliBackoffThrottle);
    DI.unregister(MemorySecretStore);
    DI.unregister(CliRecordingMailer);
    DI.unregister(CliAgeSource);
    // Singletons are cached under the concrete class name too (task 4 report, decision 8).
    DI.uncache(FakeIdentityStore);
    DI.uncache(MemoryPasswordCredentialStore);
    DI.uncache(MemorySessionIssuer);
    DI.uncache(RecordingEventSink);
    DI.uncache(CliBackoffThrottle);
    DI.uncache(MemorySecretStore);
    DI.uncache(CliRecordingMailer);
    DI.uncache(CliAgeSource);
    DI.uncache(Configuration);
    DI.uncache(IdentityStore);
    DI.uncache(PasswordCredentialStore);
    DI.uncache(SessionIssuer);
    DI.uncache(AuthnEventSink);
    DI.uncache(AuthnThrottle);
    DI.uncache(SecretStore);
    DI.uncache(PasswordMailer);
    DI.uncache(PasswordAgeSource);
    DI.uncache(PasswordHasher);
    DI.uncache(Argon2PasswordHasher);
    DI.uncache(LocalPasswordPolicy);
    DI.uncache(PasswordService);
    DI.uncache(LocalPasswordService);
    DI.uncache(PasswordExpirationJob);
    DI.uncache(ExpirePasswords);
  });

  describe('authn:password-expire', () => {
    it('runs the expiration job with authn.local.expiration from the config', async () => {
      const identities = DI.resolve(IdentityStore) as FakeIdentityStore;
      const passwords = DI.resolve(PasswordCredentialStore) as MemoryPasswordCredentialStore;
      const hasher = (await DI.resolve(PasswordHasher)) as Argon2PasswordHasher;
      const ages = DI.resolve(PasswordAgeSource) as CliAgeSource;
      const mailer = DI.resolve(PasswordMailer) as CliRecordingMailer;
      const stale = identities.add({ login: 'stale@example.com', email: 'stale@example.com' });
      const recent = identities.add({ login: 'recent@example.com', email: 'recent@example.com' });
      const hash = await hasher.hash(OLD);
      await passwords.set(stale, hash);
      await passwords.set(recent, hash);
      ages.setAt.set(stale, new Date(Date.now() - 11 * DAY));
      ages.setAt.set(recent, new Date(Date.now() - 9 * DAY));

      const command = await DI.resolve(ExpirePasswords);
      await command.execute();

      expect(await passwords.get(stale)).to.equal(EXPIRED_PASSWORD_MARKER);
      expect(await passwords.get(recent)).to.equal(hash);
      expect(mailer.mails.map((m) => m.identity)).to.deep.equal([stale]);
    });
  });
});
