import 'mocha';
import { expect } from 'chai';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthnContext, AuthnFacts, IdentityRef } from '@spinajs/authn/contracts';
import { DEFAULT_THROTTLE, FakeBackoffThrottle, FakeIdentityStore, MemoryPasswordCredentialStore, MemorySecretStore, MemorySessionIssuer, RecordingEventSink } from '@spinajs/authn-testing';

import { Argon2PasswordHasher } from '../src/hasher.js';
import { PasswordMail, PasswordMailer } from '../src/mailer.js';
import { DeferredWork } from '../src/deferred.js';
import { LocalPasswordPolicy } from '../src/policy.js';
import { LocalPasswordService, LocalPasswordServiceDeps } from '../src/service.js';
import { RecordingTokenService } from './recording-token-service.js';

const OLD = 'Old-Password-1';
const NEW = 'New-Password-2';
const LOGIN = 'alice@example.com';
const NOW = new Date('2026-10-03T12:00:00Z');
const IP = '198.51.100.4';
const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => ({ now: NOW, purpose: 'request', ip: IP, userAgent: 'mocha', ...over });
const later = (seconds: number, over: Partial<AuthnContext> = {}) => ctx({ now: new Date(NOW.getTime() + seconds * 1000), ...over });
const facts = (impersonator?: IdentityRef): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: NOW, ...(impersonator ? { impersonator } : {}) });
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

class RecordingMailer extends PasswordMailer {
  public readonly mails: PasswordMail[] = [];
  public async send(mail: PasswordMail): Promise<void> {
    this.mails.push(mail);
  }
  public secretFor(id: IdentityRef, purpose: 'reset' | 'invite'): string | null {
    const m = [...this.mails].reverse().find((x) => x.identity.type === id.type && x.identity.id === id.id && x.purpose === purpose);
    return m ? m.secret : null;
  }
}

class CountingSecretStore extends MemorySecretStore {
  public readonly redeems: { identity: IdentityRef; purpose: string }[] = [];
  public async redeem(identity: IdentityRef, purpose: string, raw: string): Promise<boolean> {
    this.redeems.push({ identity, purpose });
    return super.redeem(identity, purpose, raw);
  }
}

/** findByLogin waits for `release()`. */
class SlowIdentityStore extends FakeIdentityStore {
  private gate: Promise<void> = new Promise(() => undefined);
  private open!: () => void;
  constructor() {
    super();
    this.gate = new Promise((res) => (this.open = res));
  }
  public release(): void {
    this.open();
  }
  public async findByLogin(login: string): Promise<IdentityRef | null> {
    await this.gate;
    return super.findByLogin(login);
  }
}

async function setup(over: Partial<LocalPasswordServiceDeps> = {}) {
  const identities = (over.identities as FakeIdentityStore | undefined) ?? new FakeIdentityStore();
  const passwords = new MemoryPasswordCredentialStore();
  const sessions = new MemorySessionIssuer();
  const throttle = new FakeBackoffThrottle(DEFAULT_THROTTLE);
  const events = new RecordingEventSink();
  const tokens = new RecordingTokenService();
  const secrets = new CountingSecretStore();
  const mailer = new RecordingMailer();
  const hasher = new Argon2PasswordHasher({});
  await hasher.resolve();
  const policy = new LocalPasswordPolicy({});
  const warnings: string[] = [];
  const service = new LocalPasswordService({
    identities,
    passwords,
    sessions,
    throttle,
    tokens,
    secrets,
    mailer,
    sinks: [events],
    hasher,
    policy,
    log: { warn: (m: string) => warnings.push(m) },
    resetUrl: 'https://app.example.com/password-reset',
    ...over,
  });

  const alice = identities.add({ login: LOGIN, email: LOGIN, name: 'Alice' });
  await passwords.set(alice, await hasher.hash(OLD));
  return { identities, passwords, sessions, throttle, events, tokens, secrets, mailer, hasher, service, alice, warnings };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function requestAndTake(x: Setup, at: AuthnContext = ctx()): Promise<string> {
  expect(await x.service.requestReset(LOGIN, at)).to.deep.equal({ status: 'accepted' });
  await x.service.drain();
  const secret = x.mailer.secretFor(x.alice, 'reset');
  expect(secret, 'the reset mail holds a secret').to.be.a('string');
  return secret!;
}

describe('LocalPasswordService reset and invite', function () {
  this.timeout(60_000);

  describe('requestReset (D11, A11)', () => {
    it('answers accepted for known and unknown logins alike', async () => {
      const x = await setup();
      const known = await x.service.requestReset(LOGIN, ctx());
      const unknown = await x.service.requestReset('nobody@example.com', ctx({ ip: '203.0.113.9' }));
      expect(known).to.deep.equal({ status: 'accepted' });
      expect(unknown).to.deep.equal(known);
    });

    it('mails only after the work ran, with a secret that redeems and the reset url', async () => {
      const x = await setup();
      await x.service.requestReset(LOGIN, ctx());
      expect(x.mailer.mails).to.have.length(0);
      await x.service.drain();

      expect(x.mailer.mails).to.have.length(1);
      const m = x.mailer.mails[0];
      expect(m.identity).to.deep.equal(x.alice);
      expect(m.purpose).to.equal('reset');
      expect(m.to).to.deep.equal({ email: LOGIN, name: 'Alice' });
      expect(m.url).to.equal('https://app.example.com/password-reset');
      expect(m.ttlSeconds).to.equal(3600);
      expect(await x.secrets.redeem(x.alice, 'reset', m.secret)).to.equal(true);
    });

    it('mails nothing for an unknown login', async () => {
      const x = await setup();
      await x.service.requestReset('nobody@example.com', ctx());
      await x.service.drain();
      expect(x.mailer.mails).to.have.length(0);
    });

    for (const [label, status, mailed] of [
      ['banned', { banned: true }, false],
      ['deleted', { deleted: true }, false],
      ['inactive', { active: false }, false],
      ['inactive with a pending invite', { active: false, invitePending: true }, true],
    ] as const) {
      it(`${mailed ? 'mails' : 'does not mail'} an identity that is ${label}`, async () => {
        const x = await setup();
        x.identities.setStatus(x.alice, status);
        expect(await x.service.requestReset(LOGIN, ctx())).to.deep.equal({ status: 'accepted' });
        await x.service.drain();
        expect(x.mailer.mails).to.have.length(mailed ? 1 : 0);
      });
    }

    it('a second request for one login at the same instant is throttled for 60 s', async () => {
      const x = await setup();
      expect(await x.service.requestReset(LOGIN, ctx())).to.deep.equal({ status: 'accepted' });
      expect(await x.service.requestReset(LOGIN, ctx({ ip: '203.0.113.9' }))).to.deep.equal({ status: 'throttled', retryAfterSeconds: 60 });
      expect(await x.service.requestReset('nobody@example.com', ctx({ ip: '203.0.113.9' }))).to.deep.equal({ status: 'accepted' });
      expect(await x.service.requestReset('nobody@example.com', ctx({ ip: '203.0.113.10' }))).to.deep.equal({ status: 'throttled', retryAfterSeconds: 60 });
    });

    it('normalises the login for the account key', async () => {
      const x = await setup();
      await x.service.requestReset(LOGIN, ctx());
      expect(await x.service.requestReset('  ALICE@example.com ', ctx({ ip: '203.0.113.9' }))).to.deep.equal({ status: 'throttled', retryAfterSeconds: 60 });
    });

    it('a request after 61 s voids the older secret', async () => {
      const x = await setup();
      const first = await requestAndTake(x);
      const second = await requestAndTake(x, later(61));
      expect(second).to.not.equal(first);
      expect(await x.service.redeemReset(LOGIN, first, NEW, later(62))).to.deep.equal({ status: 'invalid' });
      expect(await x.service.redeemReset(LOGIN, second, NEW, later(63))).to.deep.equal({ status: 'reset', purpose: 'reset' });
    });

    it('SR-04 reset request answers before the work', async () => {
      const identities = new SlowIdentityStore();
      const x = await setup({ identities });
      const answer = await x.service.requestReset(LOGIN, ctx());
      expect(answer).to.deep.equal({ status: 'accepted' });
      expect(x.mailer.mails).to.have.length(0);
      identities.release();
      await x.service.drain();
      expect(x.mailer.mails).to.have.length(1);
    });

    it('without a mailer logs a warning, issues and sends nothing', async () => {
      const x = await setup({ mailer: null });
      expect(await x.service.requestReset(LOGIN, ctx())).to.deep.equal({ status: 'accepted' });
      await x.service.drain();
      expect(x.secrets.rows()).to.have.length(0);
      expect(x.warnings.some((w) => w.includes('PasswordMailer'))).to.equal(true);
    });

    it('a failing mailer is logged by name and never reaches the caller', async () => {
      class BrokenMailer extends PasswordMailer {
        public async send(mail: PasswordMail): Promise<void> {
          throw new Error(`smtp refused ${mail.secret}`);
        }
      }
      const x = await setup({ mailer: new BrokenMailer() });
      expect(await x.service.requestReset(LOGIN, ctx())).to.deep.equal({ status: 'accepted' });
      await x.service.drain();
      expect(x.warnings).to.have.length(1);
      expect(x.warnings[0]).to.contain('Error');
      expect(x.warnings[0]).to.not.contain('smtp refused');
    });

    it('audits the request with the identity, never the login or the secret', async () => {
      const x = await setup();
      const secret = await requestAndTake(x);
      await x.service.requestReset('nobody@example.com', ctx({ ip: '203.0.113.9' }));
      await x.service.drain();
      const requests = x.events.ofType('password.reset.request');
      expect(requests.map((e) => e.outcome)).to.deep.equal(['success', 'failure']);
      expect(requests[0].identity).to.deep.equal(x.alice);
      const text = JSON.stringify(x.events.all());
      for (const s of [secret, sha256hex(secret), LOGIN, 'nobody@example.com']) {
        expect(text).to.not.contain(s);
      }
    });

    it('no event, log line or mailer field but `secret` holds the secret or its hash', async () => {
      const x = await setup();
      const secret = await requestAndTake(x);
      await x.service.redeemReset(LOGIN, secret, NEW, later(1));
      const { secret: _secret, ...rest } = x.mailer.mails[0];
      const text = JSON.stringify([rest, x.events.all(), x.warnings]);
      expect(text).to.not.contain(secret);
      expect(text).to.not.contain(sha256hex(secret));
    });
  });

  describe('redeemReset (D12, A11)', () => {
    it('resets the password, revokes every session incl. impersonations and the tokens (SR-08)', async () => {
      const x = await setup();
      const carol = x.identities.add({ login: 'carol@example.com' });
      const s1 = await x.sessions.issue(x.alice, facts());
      const si = await x.sessions.issue(carol, facts(x.alice));
      const carols = await x.sessions.issue(carol, facts());
      const secret = await requestAndTake(x);

      expect(await x.service.redeemReset(LOGIN, secret, NEW, later(1))).to.deep.equal({ status: 'reset', purpose: 'reset' });

      expect(await x.hasher.verify(await x.passwords.get(x.alice), NEW)).to.equal(true);
      expect(await x.hasher.verify(await x.passwords.get(x.alice), OLD)).to.equal(false);
      expect(await x.sessions.restore(s1.id)).to.equal(null);
      expect(await x.sessions.restore(si.id)).to.equal(null);
      expect(await x.sessions.restore(carols.id)).to.not.equal(null);
      expect(x.tokens.calls.map((c) => c.method)).to.deep.equal(['revokeAllFor']);
      expect(x.tokens.calls[0].args[0]).to.deep.equal(x.alice);
      const [e] = x.events.ofType('password.reset');
      expect(e).to.include({ outcome: 'success' });
      expect(e.identity).to.deep.equal(x.alice);
    });

    it('with revokeTokens false keeps the tokens', async () => {
      const x = await setup({ revokeTokens: false });
      const secret = await requestAndTake(x);
      expect((await x.service.redeemReset(LOGIN, secret, NEW, later(1))).status).to.equal('reset');
      expect(x.tokens.calls).to.deep.equal([]);
    });

    it('a policy violation is rejected and leaves the secret usable', async () => {
      const x = await setup();
      const secret = await requestAndTake(x);
      expect(await x.service.redeemReset(LOGIN, secret, 'Short-7', later(1))).to.deep.equal({ status: 'rejected', violations: ['too_short'] });
      expect(x.secrets.redeems).to.have.length(0);
      expect(await x.service.redeemReset(LOGIN, secret, NEW, later(2))).to.deep.equal({ status: 'reset', purpose: 'reset' });
    });

    it('a secret redeems once', async () => {
      const x = await setup();
      const secret = await requestAndTake(x);
      expect((await x.service.redeemReset(LOGIN, secret, NEW, later(1))).status).to.equal('reset');
      expect(await x.service.redeemReset(LOGIN, secret, 'Third-Password-3', later(2))).to.deep.equal({ status: 'invalid' });
    });

    it('a wrong, expired, other identity or other purpose secret is invalid', async () => {
      const x = await setup();
      const bob = x.identities.add({ login: 'bob@example.com', email: 'bob@example.com' });
      expect(await x.service.redeemReset(LOGIN, 'not-the-secret', NEW, later(1))).to.deep.equal({ status: 'invalid' });

      const expired = randomUUID();
      x.secrets.seedHash(x.alice, 'reset', sha256hex(expired), new Date(Date.now() - 1000), new Date(Date.now() - 3_601_000));
      expect(await x.service.redeemReset(LOGIN, expired, NEW, later(2))).to.deep.equal({ status: 'invalid' });

      const bobs = await x.secrets.issue(bob, 'reset', 3600);
      expect(await x.service.redeemReset(LOGIN, bobs, NEW, later(3))).to.deep.equal({ status: 'invalid' });

      const other = await x.secrets.issue(x.alice, 'email-confirm', 3600);
      expect(await x.service.redeemReset(LOGIN, other, NEW, later(4))).to.deep.equal({ status: 'invalid' });
      expect(await x.hasher.verify(await x.passwords.get(x.alice), OLD)).to.equal(true);
    });

    it('SR-17 a redeem without a pending reset fails with invalid', async () => {
      const x = await setup();
      expect(await x.service.redeemReset(LOGIN, randomUUID(), NEW, ctx())).to.deep.equal({ status: 'invalid' });
      const [e] = x.events.ofType('password.reset');
      expect(e).to.include({ outcome: 'failure', reason: 'secret' });
    });

    it('an unknown login is invalid after two redeems on throwaway identities', async () => {
      const x = await setup();
      expect(await x.service.redeemReset('nobody@example.com', randomUUID(), NEW, ctx())).to.deep.equal({ status: 'invalid' });
      expect(x.secrets.redeems.map((r) => r.purpose)).to.deep.equal(['reset', 'invite']);
      expect(x.identities.calls.status).to.have.length(1);
      for (const r of x.secrets.redeems) {
        expect((await x.identities.status(r.identity)).exists).to.equal(false);
      }
    });

    for (const [label, status] of [
      ['banned', { banned: true }],
      ['deleted', { deleted: true }],
      ['inactive without an invite', { active: false }],
    ] as const) {
      it(`a ${label} identity is invalid after two throwaway redeems, and its secret is untouched`, async () => {
        const x = await setup();
        const secret = await requestAndTake(x);
        x.identities.setStatus(x.alice, status);
        expect(await x.service.redeemReset(LOGIN, secret, NEW, later(1))).to.deep.equal({ status: 'invalid' });
        expect(x.secrets.redeems).to.have.length(2);
        for (const r of x.secrets.redeems) {
          expect(r.identity).to.not.deep.equal(x.alice);
        }
        const [e] = x.events.ofType('password.reset');
        expect(e).to.include({ outcome: 'failure', reason: 'status' });
        expect(await x.secrets.redeem(x.alice, 'reset', secret)).to.equal(true);
      });
    }

    it('a made-up secret costs exactly two redeems on every path, so a pending invite does not show in the timing (A02)', async () => {
      const x = await setup();
      const bob = x.identities.add({ login: 'bob@example.com' });
      const dave = x.identities.add({ login: 'dave@example.com', status: { active: false, invitePending: true } });
      x.identities.setStatus(x.alice, { banned: true });
      const real = [x.alice, bob, dave];
      const isReal = (r: IdentityRef) => real.some((i) => i.type === r.type && i.id === r.id);

      const paths: [string, string, (r: { identity: IdentityRef; purpose: string }[]) => void][] = [
        ['unknown', 'nobody@example.com', (r) => expect(r.some((c) => isReal(c.identity))).to.equal(false)],
        ['ineligible', LOGIN, (r) => expect(r.some((c) => isReal(c.identity))).to.equal(false)],
        ['not invite-pending', 'bob@example.com', (r) => expect(r.map((c) => isReal(c.identity))).to.deep.equal([true, false])],
        ['invite-pending', 'dave@example.com', (r) => expect(r.map((c) => isReal(c.identity))).to.deep.equal([true, true])],
      ];
      for (const [label, login, check] of paths) {
        x.secrets.redeems.length = 0;
        expect(await x.service.redeemReset(login, randomUUID(), NEW, ctx({ ip: randomUUID() })), label).to.deep.equal({ status: 'invalid' });
        expect(
          x.secrets.redeems.map((r) => r.purpose),
          label,
        ).to.deep.equal(['reset', 'invite']);
        check(x.secrets.redeems);
      }
    });

    it('a reset secret completes a pending invite and also records invite.redeem', async () => {
      const x = await setup();
      x.identities.setStatus(x.alice, { active: false, invitePending: true });
      const secret = await requestAndTake(x);
      expect(await x.service.redeemReset(LOGIN, secret, NEW, later(1))).to.deep.equal({ status: 'reset', purpose: 'reset' });
      expect(x.events.ofType('password.reset').map((e) => e.outcome)).to.deep.equal(['success']);
      const invites = x.events.ofType('invite.redeem');
      expect(invites).to.have.length(1);
      expect(invites[0]).to.include({ outcome: 'success' });
      expect(invites[0].identity).to.deep.equal(x.alice);
      expect(invites[0].data).to.deep.equal({ via: 'reset' });
    });

    it('a reset on an identity without a pending invite records no invite.redeem', async () => {
      const x = await setup();
      const secret = await requestAndTake(x);
      expect((await x.service.redeemReset(LOGIN, secret, NEW, later(1))).status).to.equal('reset');
      expect(x.events.ofType('invite.redeem')).to.have.length(0);
    });

    it('a redeem 1 s after the request is not refused by the throttle', async () => {
      const x = await setup();
      const secret = await requestAndTake(x);
      expect((await x.service.redeemReset(LOGIN, secret, NEW, later(1))).status).to.equal('reset');
    });

    it('counts redeems against the ip key only', async () => {
      const x = await setup();
      for (let i = 0; i < 5; i++) {
        expect(await x.service.redeemReset(LOGIN, randomUUID(), NEW, ctx())).to.deep.equal({ status: 'invalid' });
      }
      expect(await x.service.redeemReset(LOGIN, randomUUID(), NEW, ctx())).to.deep.equal({ status: 'throttled', retryAfterSeconds: 10 });
      expect(await x.service.redeemReset(LOGIN, randomUUID(), NEW, ctx({ ip: '203.0.113.9' }))).to.deep.equal({ status: 'invalid' });
    });
  });

  describe('invite (D13, A32)', () => {
    it('mails an invite secret that redeems with purpose invite while the identity is invite-pending', async () => {
      const x = await setup();
      const dave = x.identities.add({ login: 'dave@example.com', email: 'dave@example.com', status: { active: false, invitePending: true } });
      await x.service.invite(dave, ctx());

      expect(x.mailer.mails).to.have.length(1);
      expect(x.mailer.mails[0]).to.include({ purpose: 'invite', ttlSeconds: 900, url: 'https://app.example.com/password-reset' });
      const secret = x.mailer.secretFor(dave, 'invite')!;
      expect(await x.service.redeemReset('dave@example.com', secret, NEW, later(1))).to.deep.equal({ status: 'reset', purpose: 'invite' });
      expect(await x.hasher.verify(await x.passwords.get(dave), NEW)).to.equal(true);
      expect(x.events.ofType('invite.redeem').map((e) => e.outcome)).to.deep.equal(['success']);
      expect(x.events.ofType('invite.redeem')[0].data).to.equal(undefined);
      expect(x.events.ofType('password.reset')).to.have.length(0);
    });

    it('an invite secret is invalid once the invite is no longer pending', async () => {
      const x = await setup();
      const dave = x.identities.add({ login: 'dave@example.com', status: { active: true } });
      await x.service.invite(dave, ctx());
      const secret = x.mailer.secretFor(dave, 'invite')!;
      expect(await x.service.redeemReset('dave@example.com', secret, NEW, later(1))).to.deep.equal({ status: 'invalid' });
    });

    for (const [label, status] of [
      ['banned', { active: false, invitePending: true, banned: true }],
      ['deleted', { active: false, invitePending: true, deleted: true }],
    ] as const) {
      it(`a ${label} identity never redeems its invite`, async () => {
        const x = await setup();
        const dave = x.identities.add({ login: 'dave@example.com', status: { active: false, invitePending: true } });
        await x.service.invite(dave, ctx());
        x.identities.setStatus(dave, status);
        const secret = x.mailer.secretFor(dave, 'invite')!;
        expect(await x.service.redeemReset('dave@example.com', secret, NEW, later(1))).to.deep.equal({ status: 'invalid' });
      });
    }

    it('an invite never holds the secret in an event', async () => {
      const x = await setup();
      const dave = x.identities.add({ login: 'dave@example.com', status: { active: false, invitePending: true } });
      await x.service.invite(dave, ctx(), { actor: { type: 'user', id: 'admin-1' } });
      const secret = x.mailer.secretFor(dave, 'invite')!;
      expect(JSON.stringify(x.events.all())).to.not.contain(secret);
    });
  });

  describe('DeferredWork', () => {
    it('runs work after the caller continues and drain waits for all of it, including work added while draining', async () => {
      const work = new DeferredWork({ warn: () => undefined });
      const order: string[] = [];
      work.defer(async () => {
        order.push('a');
        work.defer(async () => {
          order.push('b');
        });
      });
      order.push('caller');
      await work.drain();
      expect(order).to.deep.equal(['caller', 'a', 'b']);
    });

    it('starts the work only after setImmediate, not in a microtask', async () => {
      const work = new DeferredWork({ warn: () => undefined });
      const order: string[] = [];
      work.defer(async () => {
        order.push('job');
      });
      order.push('caller');
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }
      expect(order).to.deep.equal(['caller']);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await work.drain();
      expect(order).to.deep.equal(['caller', 'job']);
    });
  });
});
