import 'mocha';
import { expect } from 'chai';
import { Readable } from 'node:stream';
import { DI } from '@spinajs/di';
import { META_ARGUMENT, META_COMMAND, META_OPTION } from '@spinajs/cli';
import type { IArgument, ICommand, IOption } from '@spinajs/cli';
import { InvalidArgument } from '@spinajs/exceptions';
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
import { SetUserPassword } from '../src/cli/SetUserPassword.js';

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

  describe('authn:password (D17)', () => {
    class ScriptedSetUserPassword extends SetUserPassword {
      public readonly printed: string[] = [];
      public readonly prompted: string[] = [];
      public readonly logged: string[] = [];
      constructor(
        private readonly stdin: readonly (string | Buffer)[] = [],
        private readonly tty = false,
      ) {
        super();
        const record = (...args: unknown[]) => {
          this.logged.push(args.map(String).join(' '));
        };
        // The @Logger getter lives on the prototype; an own property shadows it.
        Object.defineProperty(this, 'Log', { value: { error: record, success: record, info: record, warn: record, debug: record, trace: record } });
      }
      protected input(): NodeJS.ReadableStream {
        const stream = Readable.from(this.stdin);
        return Object.assign(stream, { isTTY: this.tty });
      }
      protected print(text: string): void {
        this.printed.push(text);
      }
      protected prompt(text: string): void {
        this.prompted.push(text);
      }
    }

    async function seed(login: string) {
      const identities = DI.resolve(IdentityStore) as FakeIdentityStore;
      const passwords = DI.resolve(PasswordCredentialStore) as MemoryPasswordCredentialStore;
      const hasher = (await DI.resolve(PasswordHasher)) as Argon2PasswordHasher;
      const sink = DI.resolve(Array.ofType(AuthnEventSink))[0] as RecordingEventSink;
      const id = identities.add({ login });
      const hash = await hasher.hash(OLD);
      await passwords.set(id, hash);
      return { id, hash, passwords, hasher, sink };
    }

    async function rejection(run: () => Promise<void>): Promise<Error> {
      try {
        await run();
      } catch (e) {
        return e as Error;
      }
      throw new Error('the command did not fail');
    }

    it('takes the login as its only argument, no password argument, and refuses excess arguments', () => {
      const args = Reflect.getMetadata(META_ARGUMENT, SetUserPassword) as IArgument[];
      const opts = Reflect.getMetadata(META_OPTION, SetUserPassword) as IOption[];
      const command = Reflect.getMetadata(META_COMMAND, SetUserPassword) as ICommand;
      expect(args.map((a) => a.name)).to.deep.equal(['login']);
      expect(opts.map((o) => o.flags)).to.deep.equal(['-g, --generate']);
      expect(command.nameAndArgs).to.equal('authn:password');
      expect(command.allowExcessArguments).to.equal(false);
    });

    it('sets the first stdin line, untrimmed, through PasswordService.set with the cli actor', async () => {
      const x = await seed('frank@example.com');
      const events = x.sink.ofType('password.change').length;
      const command = new ScriptedSetUserPassword(['  Typed-', 'Password-9 \r\nsecond line\n']);
      await command.execute('frank@example.com', {});

      const stored = await x.passwords.get(x.id);
      expect(await x.hasher.verify(stored, '  Typed-Password-9 ')).to.equal(true);
      expect(await x.hasher.verify(stored, 'Typed-Password-9')).to.equal(false);
      expect(await x.hasher.verify(stored, OLD)).to.equal(false);
      expect(command.printed).to.deep.equal([]);
      expect(command.prompted).to.deep.equal([]);
      expect(command.logged).to.have.length(1);
      expect(command.logged.join('\n')).to.not.contain('Typed-Password-9');
      const [e] = x.sink.ofType('password.change').slice(events);
      expect(e.identity).to.deep.equal(x.id);
      expect(e.actor).to.deep.equal({ type: 'service', id: 'cli' });
      expect(e.data).to.deep.equal({ cause: 'set' });
    });

    it('prompts on stderr when stdin is a terminal', async () => {
      const x = await seed('jill@example.com');
      const command = new ScriptedSetUserPassword(['Typed-Password-8\n'], true);
      await command.execute('jill@example.com', {});
      expect(command.prompted).to.have.length(1);
      expect(command.prompted[0]).to.contain('--generate');
      expect(await x.hasher.verify(await x.passwords.get(x.id), 'Typed-Password-8')).to.equal(true);
    });

    it('decodes a character split across stdin chunks', async () => {
      const x = await seed('gina@example.com');
      const bytes = Buffer.from('Zażółć-Gęślą-1\n', 'utf8');
      await new ScriptedSetUserPassword([bytes.subarray(0, 3), bytes.subarray(3)]).execute('gina@example.com', {});
      expect(await x.hasher.verify(await x.passwords.get(x.id), 'Zażółć-Gęślą-1')).to.equal(true);
    });

    it('with --generate prints a generated password once, which passes check and verifies, and never logs it', async () => {
      const x = await seed('hank@example.com');
      const command = new ScriptedSetUserPassword(['ignored-Stdin-1\n']);
      await command.execute('hank@example.com', { generate: true });

      expect(command.printed).to.have.length(1);
      const service = (await DI.resolve(PasswordService)) as LocalPasswordService;
      const stored = await x.passwords.get(x.id);
      const generated = command.printed[0].trim().split(/\s+/).pop()!;
      expect(generated).to.have.length(16);
      expect(await service.check(generated)).to.deep.equal([]);
      expect(await x.hasher.verify(stored, generated)).to.equal(true);
      expect(await x.hasher.verify(stored, 'ignored-Stdin-1')).to.equal(false);
      expect(command.logged).to.have.length(1);
      expect(command.logged.join('\n')).to.not.contain(generated);
    });

    it('a policy violation fails the command, leaves the stored hash unchanged and never echoes the password', async () => {
      const x = await seed('ivy@example.com');
      const writes = x.passwords.writes.length;
      const command = new ScriptedSetUserPassword(['Short-7\n']);
      const error = await rejection(() => command.execute('ivy@example.com', {}));
      expect(error).to.be.instanceOf(InvalidArgument);
      expect(error.message).to.contain('too_short');
      expect(await x.passwords.get(x.id)).to.equal(x.hash);
      expect(x.passwords.writes.length).to.equal(writes);
      expect(command.logged).to.have.length(1);
      expect(command.logged[0]).to.contain('too_short');
      expect([...command.printed, ...command.logged, error.message].join('\n')).to.not.contain('Short-7');
    });

    it('an unknown login fails the command without calling set or naming the login', async () => {
      const service = (await DI.resolve(PasswordService)) as LocalPasswordService;
      const passwords = DI.resolve(PasswordCredentialStore) as MemoryPasswordCredentialStore;
      const sink = DI.resolve(Array.ofType(AuthnEventSink))[0] as RecordingEventSink;
      const writes = passwords.writes.length;
      const events = sink.all().length;
      const original = service.set;
      let calls = 0;
      service.set = async (...args) => {
        calls++;
        return original.apply(service, args);
      };
      const command = new ScriptedSetUserPassword(['Valid-Password-5\n']);
      let error: Error;
      try {
        error = await rejection(() => command.execute('nobody@example.com', {}));
      } finally {
        service.set = original;
      }
      expect(error).to.be.instanceOf(InvalidArgument);
      expect(command.printed).to.deep.equal([]);
      expect([...command.logged, error.message].join('\n')).to.not.contain('nobody');
      expect(calls).to.equal(0);
      expect(passwords.writes.length).to.equal(writes);
      expect(sink.all().length).to.equal(events);
    });
  });
});
