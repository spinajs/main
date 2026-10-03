import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { AuthnEventSink, AuthnThrottle, IdentityStore, PasswordCredentialStore, PasswordService, SecretStore, SessionIssuer, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnEvent, AuthnFacts, IdentityRef, SessionHandle, ThrottleKey } from '@spinajs/authn/contracts';
import { DEFAULT_THROTTLE, FakeBackoffThrottle, FakeIdentityStore, MemoryPasswordCredentialStore, MemorySecretStore, MemorySessionIssuer, RecordingEventSink } from '@spinajs/authn-testing';

import { Argon2PasswordHasher, PasswordHasher } from '../src/hasher.js';
import { LocalPasswordPolicy, PasswordBlocklist } from '../src/policy.js';
import { LocalPasswordService, LocalPasswordServiceDeps } from '../src/service.js';
import { PasswordMail, PasswordMailer } from '../src/mailer.js';
import { RecordingTokenService } from './recording-token-service.js';

const OLD = 'Old-Password-1';
const NEW = 'New-Password-2';
const BLOCKED = 'Blocked-Pass-3';
const NOW = new Date('2026-10-03T12:00:00Z');
const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => ({ now: NOW, purpose: 'reauth', ip: '198.51.100.4', userAgent: 'mocha', ...over });
const facts = (impersonator?: IdentityRef): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: NOW, ...(impersonator ? { impersonator } : {}) });

class ListBlocklist extends PasswordBlocklist {
  constructor(private readonly list: readonly string[]) {
    super();
  }
  public async isBlocked(password: string): Promise<boolean> {
    return this.list.includes(password);
  }
}

class CountingThrottle extends FakeBackoffThrottle {
  public attempts = 0;
  public succeeds = 0;
  public readonly calls: { keys: readonly ThrottleKey[]; flow: string }[] = [];
  public async attempt(...args: Parameters<FakeBackoffThrottle['attempt']>) {
    this.attempts++;
    this.calls.push({ keys: args[0], flow: args[1] });
    return super.attempt(...args);
  }
  public async succeed(...args: Parameters<FakeBackoffThrottle['succeed']>) {
    this.succeeds++;
    return super.succeed(...args);
  }
}

class FailingSink extends AuthnEventSink {
  public async publish(): Promise<void> {
    throw new Error('sink is down');
  }
}

async function setup(over: Partial<LocalPasswordServiceDeps> = {}) {
  const identities = new FakeIdentityStore();
  const passwords = new MemoryPasswordCredentialStore();
  const sessions = new MemorySessionIssuer();
  const throttle = new CountingThrottle(DEFAULT_THROTTLE);
  const events = new RecordingEventSink();
  const tokens = new RecordingTokenService();
  const hasher = new Argon2PasswordHasher({});
  // As at boot: the hasher makes its dummy hash in resolve() (D4).
  await hasher.resolve();
  const policy = new LocalPasswordPolicy({ blocklist: new ListBlocklist([BLOCKED]) });
  const warnings: string[] = [];
  const deps: LocalPasswordServiceDeps = {
    identities,
    passwords,
    sessions,
    throttle,
    tokens,
    sinks: [events],
    hasher,
    policy,
    log: { warn: (m: string) => warnings.push(m) },
    ...over,
  };
  const service = new LocalPasswordService(deps);

  const alice = identities.add({ login: 'alice@example.com' });
  const bob = identities.add({ login: 'bob@example.com' });
  await passwords.set(alice, await hasher.hash(OLD));
  const session = await sessions.issue(alice, facts());
  return { identities, passwords, sessions, throttle, events, tokens, hasher, policy, service, alice, bob, session, warnings };
}

async function verifies(hasher: PasswordHasher, passwords: MemoryPasswordCredentialStore, id: IdentityRef, password: string) {
  return hasher.verify(await passwords.get(id), password);
}

function assertNoSecrets(events: readonly AuthnEvent[], ...secrets: string[]) {
  const text = JSON.stringify(events);
  for (const s of [...secrets, '$argon2']) {
    expect(text, `events carry ${s}`).to.not.contain(s);
  }
}

describe('LocalPasswordService', function () {
  this.timeout(60_000);

  it('is a PasswordService', async () => {
    const { service } = await setup();
    expect(service).to.be.instanceOf(PasswordService);
  });

  describe('change (D9, A30, H32)', () => {
    it('changes the password, rotates the session and revokes the other sessions incl. impersonations', async () => {
      const { service, sessions, passwords, hasher, events, alice, bob, session } = await setup();
      const other = await sessions.issue(alice, facts());
      const impersonating = await sessions.issue(bob, facts(alice));
      const bobs = await sessions.issue(bob, facts());

      const res = await service.change(alice, OLD, NEW, session, ctx());

      expect(res.status).to.equal('changed');
      const rotated = (res as { session: SessionHandle }).session;
      expect(rotated.id).to.not.equal(session.id);
      const restored = await sessions.restore(rotated.id);
      expect(restored?.identity).to.deep.equal(alice);
      expect(restored?.handle.state).to.equal('active');
      expect(await sessions.restore(session.id)).to.equal(null);
      expect(await sessions.restore(other.id)).to.equal(null);
      expect(await sessions.restore(impersonating.id)).to.equal(null);
      expect(await sessions.restore(bobs.id)).to.not.equal(null);

      expect(await verifies(hasher, passwords, alice, NEW)).to.equal(true);
      expect(await verifies(hasher, passwords, alice, OLD)).to.equal(false);

      const changes = events.ofType('password.change');
      expect(changes).to.have.length(1);
      expect(changes[0]).to.include({ outcome: 'success', ip: '198.51.100.4', userAgent: 'mocha' });
      expect(changes[0].identity).to.deep.equal(alice);
      expect(changes[0].at).to.deep.equal(NOW);
      expect(changes[0].session).to.be.a('string');
      expect(changes[0].session).to.not.equal(session.id);
      expect(changes[0].session).to.not.equal(rotated.id);
      assertNoSecrets(events.all(), OLD, NEW, session.id, rotated.id);
    });

    it('counts the attempt in reauth and gives it back on success', async () => {
      const { service, throttle, alice, session } = await setup();
      await service.change(alice, OLD, NEW, session, ctx());
      expect(throttle.attempts).to.equal(1);
      expect(throttle.succeeds).to.equal(1);
    });

    it('never touches API or agent tokens', async () => {
      const { service, tokens, alice, session } = await setup();
      expect((await service.change(alice, OLD, NEW, session, ctx())).status).to.equal('changed');
      expect(tokens.calls).to.deep.equal([]);
    });

    for (const [label, password, violation] of [
      ['7 characters', 'Short-7', 'too_short'],
      ['129 characters', 'x'.repeat(129), 'too_long'],
      ['a blocklisted password', BLOCKED, 'blocklisted'],
    ] as const) {
      it(`rejects ${label} without counting and keeps the old password`, async () => {
        const { service, throttle, passwords, hasher, alice, session } = await setup();
        const res = await service.change(alice, OLD, password, session, ctx());
        expect(res).to.deep.equal({ status: 'rejected', violations: [violation] });
        expect(throttle.attempts).to.equal(0);
        expect(await verifies(hasher, passwords, alice, OLD)).to.equal(true);
      });
    }

    it("is invalid with another identity's session and keeps the old password", async () => {
      const { service, sessions, passwords, hasher, throttle, alice, bob } = await setup();
      const bobs = await sessions.issue(bob, facts());
      expect(await service.change(alice, OLD, NEW, bobs, ctx())).to.deep.equal({ status: 'invalid' });
      expect(throttle.attempts).to.equal(0);
      expect(await verifies(hasher, passwords, alice, OLD)).to.equal(true);
      expect(await sessions.restore(bobs.id)).to.not.equal(null);
    });

    it('is invalid with a pending session', async () => {
      const { service, sessions, passwords, hasher, alice } = await setup();
      const pending = await sessions.issue(alice, facts(), { pending: { steps: ['totp'] } });
      expect(await service.change(alice, OLD, NEW, pending, ctx())).to.deep.equal({ status: 'invalid' });
      expect(await verifies(hasher, passwords, alice, OLD)).to.equal(true);
    });

    it('is invalid with an unknown or revoked session', async () => {
      const { service, sessions, alice, session } = await setup();
      expect(await service.change(alice, OLD, NEW, { id: 'no-such-session', state: 'active' }, ctx())).to.deep.equal({ status: 'invalid' });
      await sessions.revoke(session);
      expect(await service.change(alice, OLD, NEW, session, ctx())).to.deep.equal({ status: 'invalid' });
    });

    it('is invalid, before the throttle, in a session someone is impersonating', async () => {
      const { service, sessions, passwords, hasher, throttle, events, alice } = await setup();
      const admin = { type: 'user' as const, id: 'admin-7' };
      const impersonated = await sessions.issue(alice, facts(admin));
      const other = await sessions.issue(alice, facts());

      expect(await service.change(alice, OLD, NEW, impersonated, ctx())).to.deep.equal({ status: 'invalid' });

      expect(throttle.attempts).to.equal(0);
      expect(await verifies(hasher, passwords, alice, OLD)).to.equal(true);
      expect(await sessions.restore(other.id)).to.not.equal(null);
      expect(await sessions.restore(impersonated.id)).to.not.equal(null);
      const [e] = events.ofType('password.change');
      expect(e).to.include({ outcome: 'failure', reason: 'impersonation' });
      expect(e.identity).to.deep.equal(alice);
      expect(e.actor).to.deep.equal(admin);
    });

    it('is invalid with a session where the identity only impersonates', async () => {
      const { service, sessions, alice, bob } = await setup();
      const impersonating = await sessions.issue(bob, facts(alice));
      expect(await service.change(alice, OLD, NEW, impersonating, ctx())).to.deep.equal({ status: 'invalid' });
    });

    it('is invalid for a wrong old password and when nothing is stored, and the session survives', async () => {
      const { service, sessions, passwords, alice, session } = await setup();
      expect(await service.change(alice, 'Wrong-Password-0', NEW, session, ctx())).to.deep.equal({ status: 'invalid' });
      expect(await sessions.restore(session.id)).to.not.equal(null);

      await passwords.set(alice, '!expired');
      expect(await service.change(alice, OLD, NEW, session, ctx({ now: new Date(NOW.getTime() + 60_000) }))).to.deep.equal({ status: 'invalid' });
    });

    it('an old password outside 8–128 is invalid even when it is the stored one', async () => {
      const { service, passwords, hasher, alice, session } = await setup();
      for (const old of ['Seven-7', 'x'.repeat(129)]) {
        await passwords.set(alice, await hasher.hash(old));
        expect(await service.change(alice, old, NEW, session, ctx()), `length ${old.length}`).to.deep.equal({ status: 'invalid' });
        expect(await verifies(hasher, passwords, alice, old)).to.equal(true);
      }
    });

    it('every old-password check costs exactly one argon2 verify', async () => {
      const { service, passwords, hasher, alice, session } = await setup();
      const cases: [string, string, string | null][] = [
        ['wrong', 'Wrong-Password-0', null],
        ['too short', 'Seven-7', null],
        ['too long', 'x'.repeat(129), null],
        ['expired', OLD, '!expired'],
      ];
      // Each case at its own instant, so the reauth backoff never refuses one.
      let minute = 0;
      for (const [label, old, stored] of cases) {
        if (stored !== null) {
          await passwords.set(alice, stored);
        }
        const before = hasher.limiter.runs;
        expect(await service.change(alice, old, NEW, session, ctx({ now: new Date(NOW.getTime() + ++minute * 3_600_000) })), label).to.deep.equal({ status: 'invalid' });
        expect(hasher.limiter.runs - before, label).to.equal(1);
      }
    });

    it('counts in the reauth flow under the account, account-ip and ip keys', async () => {
      const { service, throttle, alice, session } = await setup();
      await service.change(alice, 'Wrong-Password-0', NEW, session, ctx());
      expect(throttle.calls).to.deep.equal([
        {
          flow: 'reauth',
          keys: [
            { kind: 'account', value: alice.id },
            { kind: 'account-ip', value: `${alice.id}|198.51.100.4` },
            { kind: 'ip', value: '198.51.100.4' },
          ],
        },
      ]);
    });

    it('without an ip there is no ip key and account-ip ends with |', async () => {
      const { service, throttle, alice, session } = await setup();
      await service.change(alice, 'Wrong-Password-0', NEW, session, { now: NOW, purpose: 'reauth' });
      expect(throttle.calls.map((c) => c.keys)).to.deep.equal([
        [
          { kind: 'account', value: alice.id },
          { kind: 'account-ip', value: `${alice.id}|` },
        ],
      ]);
    });

    it('A13 local: three wrong old passwords, then the right one at the same instant is throttled', async () => {
      const { service, passwords, hasher, alice, session } = await setup();
      for (let i = 0; i < 3; i++) {
        expect(await service.change(alice, 'Wrong-Password-0', NEW, session, ctx()), `try ${i + 1}`).to.deep.equal({ status: 'invalid' });
      }
      expect(await service.change(alice, OLD, NEW, session, ctx())).to.deep.equal({ status: 'throttled', retryAfterSeconds: 1 });
      expect(await verifies(hasher, passwords, alice, OLD)).to.equal(true);
    });

    it('audits refusals as failures with the reason, without secrets', async () => {
      const { service, events, sessions, alice, bob, session } = await setup();
      const bobs = await sessions.issue(bob, facts());
      await service.change(alice, OLD, BLOCKED, session, ctx());
      await service.change(alice, OLD, NEW, bobs, ctx());
      await service.change(alice, 'Wrong-Password-0', NEW, session, ctx());
      const failures = events.ofType('password.change').filter((e) => e.outcome === 'failure');
      expect(failures.map((e) => e.reason)).to.deep.equal(['policy', 'session', 'wrong_password']);
      assertNoSecrets(events.all(), OLD, NEW, BLOCKED, 'Wrong-Password-0', session.id, bobs.id);
    });

    it('a failing sink does not fail the change and is logged', async () => {
      const { service, warnings, alice, session } = await setup({ sinks: [new FailingSink()] });
      expect((await service.change(alice, OLD, NEW, session, ctx())).status).to.equal('changed');
      expect(warnings.some((w) => w.includes('FailingSink'))).to.equal(true);
    });
  });

  describe('set (D14)', () => {
    it('rejects a violation and stores nothing', async () => {
      const { service, passwords, hasher, alice } = await setup();
      expect(await service.set(alice, 'Short-7', ctx())).to.deep.equal({ status: 'rejected', violations: ['too_short'] });
      expect(await service.set(alice, BLOCKED, ctx())).to.deep.equal({ status: 'rejected', violations: ['blocklisted'] });
      expect(await verifies(hasher, passwords, alice, OLD)).to.equal(true);
    });

    it('sets the password, revokes every session incl. impersonations and every token', async () => {
      const { service, sessions, passwords, hasher, tokens, events, alice, bob, session } = await setup();
      const impersonating = await sessions.issue(bob, facts(alice));
      const bobs = await sessions.issue(bob, facts());
      const actor = { type: 'user' as const, id: 'admin-1' };

      expect(await service.set(alice, NEW, ctx(), { actor })).to.deep.equal({ status: 'set' });

      expect(await verifies(hasher, passwords, alice, NEW)).to.equal(true);
      expect(await sessions.restore(session.id)).to.equal(null);
      expect(await sessions.restore(impersonating.id)).to.equal(null);
      expect(await sessions.restore(bobs.id)).to.not.equal(null);
      expect(tokens.calls.map((c) => c.method)).to.deep.equal(['revokeAllFor']);
      expect(tokens.calls[0].args[0]).to.deep.equal(alice);
      expect(tokens.calls[0].args[2]).to.deep.equal({ actor });

      const [e] = events.ofType('password.change');
      expect(e).to.include({ outcome: 'success' });
      expect(e.identity).to.deep.equal(alice);
      expect(e.actor).to.deep.equal(actor);
      expect(e.data).to.deep.equal({ cause: 'set' });
      assertNoSecrets(events.all(), OLD, NEW);
    });

    it('with reset.revokeTokens false keeps the tokens', async () => {
      const { service, tokens, alice } = await setup({ revokeTokens: false });
      expect(await service.set(alice, NEW, ctx())).to.deep.equal({ status: 'set' });
      expect(tokens.calls).to.deep.equal([]);
    });

    it('without a TokenService there are no tokens to revoke', async () => {
      const { service, alice } = await setup({ tokens: null });
      expect(await service.set(alice, NEW, ctx())).to.deep.equal({ status: 'set' });
    });
  });

  describe('check and policy', () => {
    it('delegate to the policy', async () => {
      const { service } = await setup();
      expect(await service.check('Short-7')).to.deep.equal(['too_short']);
      expect(await service.check(BLOCKED)).to.deep.equal(['blocklisted']);
      expect(await service.check(NEW)).to.deep.equal([]);
      expect(service.policy()).to.deep.equal({ minLength: 8, maxLength: 128 });
    });
  });

  describe('later tasks', () => {
    for (const method of ['expire'] as const) {
      it(`${method} says it is not implemented yet`, async () => {
        const { service, alice } = await setup();
        const call = {
          expire: () => service.expire(alice, { cause: 'aged' }, ctx()),
        }[method];
        let error: unknown;
        try {
          await call();
        } catch (e) {
          error = e;
        }
        expect((error as Error)?.message).to.contain('not implemented yet');
      });
    }
  });
});

class DefaultBackoffThrottle extends FakeBackoffThrottle {
  constructor() {
    super(DEFAULT_THROTTLE);
  }
}

class DiRecordingMailer extends PasswordMailer {
  public readonly mails: PasswordMail[] = [];
  public async send(mail: PasswordMail): Promise<void> {
    this.mails.push(mail);
  }
}

class ServiceTestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      authn: { local: { hasher: { maxConcurrent: 2 }, reset: { revokeTokens: false, url: 'https://di.example.com/reset' }, invite: { ttlSeconds: 120 } } },
    };
  }
}

describe('LocalPasswordService DI wiring', function () {
  this.timeout(60_000);

  before(async () => {
    DI.setESMModuleSupport();
    DI.register(ServiceTestConfiguration).as(Configuration);
    DI.register(FakeIdentityStore).as(IdentityStore);
    DI.register(MemoryPasswordCredentialStore).as(PasswordCredentialStore);
    DI.register(MemorySessionIssuer).as(SessionIssuer);
    DI.register(RecordingEventSink).as(AuthnEventSink);
    DI.register(RecordingTokenService).as(TokenService);
    DI.register(DefaultBackoffThrottle).as(AuthnThrottle);
    DI.register(MemorySecretStore).as(SecretStore);
    DI.register(DiRecordingMailer).as(PasswordMailer);
    await DI.resolve(Configuration);
  });

  after(() => {
    DI.unregister(ServiceTestConfiguration);
    DI.unregister(FakeIdentityStore);
    DI.unregister(MemoryPasswordCredentialStore);
    DI.unregister(MemorySessionIssuer);
    DI.unregister(RecordingEventSink);
    DI.unregister(RecordingTokenService);
    DI.unregister(DefaultBackoffThrottle);
    DI.unregister(MemorySecretStore);
    DI.unregister(DiRecordingMailer);
    DI.uncache(SecretStore);
    DI.uncache(PasswordMailer);
    DI.uncache(MemorySecretStore);
    DI.uncache(DiRecordingMailer);
    DI.uncache(Configuration);
    DI.uncache(IdentityStore);
    DI.uncache(PasswordCredentialStore);
    DI.uncache(SessionIssuer);
    DI.uncache(AuthnEventSink);
    DI.uncache(TokenService);
    DI.uncache(AuthnThrottle);
    DI.uncache(PasswordHasher);
    DI.uncache(Argon2PasswordHasher);
    DI.uncache(LocalPasswordPolicy);
    DI.uncache(PasswordService);
    DI.uncache(LocalPasswordService);
    // Singletons are also cached under the concrete class name; without these a later suite registering the same fakes gets
    // these instances back.
    DI.uncache(FakeIdentityStore);
    DI.uncache(MemoryPasswordCredentialStore);
    DI.uncache(MemorySessionIssuer);
    DI.uncache(RecordingEventSink);
    DI.uncache(RecordingTokenService);
    DI.uncache(DefaultBackoffThrottle);
  });

  it('resolves its collaborators from the container and reads authn.local.reset.revokeTokens', async () => {
    const service = await DI.resolve(PasswordService);
    expect(service).to.be.instanceOf(LocalPasswordService);

    const identities = DI.resolve(IdentityStore) as FakeIdentityStore;
    const passwords = DI.resolve(PasswordCredentialStore) as MemoryPasswordCredentialStore;
    const sessions = DI.resolve(SessionIssuer) as MemorySessionIssuer;
    const tokens = DI.resolve(TokenService) as RecordingTokenService;
    const hasher = (await DI.resolve(PasswordHasher)) as Argon2PasswordHasher;
    const alice = identities.add({ login: 'alice@example.com' });
    await passwords.set(alice, await hasher.hash(OLD));
    const session = await sessions.issue(alice, facts());

    expect((await service.change(alice, OLD, NEW, session, ctx())).status).to.equal('changed');
    expect(await service.set(alice, 'Another-Pass-4', ctx())).to.deep.equal({ status: 'set' });
    expect(tokens.calls).to.deep.equal([]);
    const sink = DI.resolve(Array.ofType(AuthnEventSink))[0] as RecordingEventSink;
    expect(sink.ofType('password.change').map((e) => e.outcome)).to.deep.equal(['success', 'success']);
  });

  it('takes the SecretStore, the PasswordMailer and the reset and invite settings from the container', async () => {
    const service = (await DI.resolve(PasswordService)) as LocalPasswordService;
    const identities = DI.resolve(IdentityStore) as FakeIdentityStore;
    const mailer = DI.resolve(PasswordMailer) as DiRecordingMailer;
    const secrets = DI.resolve(SecretStore);
    const erin = identities.add({ login: 'erin@example.com', email: 'erin@example.com', status: { active: false, invitePending: true } });

    expect(await service.requestReset('erin@example.com', ctx({ purpose: 'request' }))).to.deep.equal({ status: 'accepted' });
    await service.drain();
    await service.invite(erin, ctx({ purpose: 'request' }));

    expect(mailer.mails.map((m) => [m.purpose, m.url, m.ttlSeconds])).to.deep.equal([
      ['reset', 'https://di.example.com/reset', 3600],
      ['invite', 'https://di.example.com/reset', 120],
    ]);
    expect(await secrets.redeem(erin, 'invite', mailer.mails[1].secret)).to.equal(true);
  });
});
