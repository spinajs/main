import 'mocha';
import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { PasswordService } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnFacts, IdentityRef, PasswordExpiry } from '@spinajs/authn/contracts';
import { DEFAULT_THROTTLE, FakeBackoffThrottle, FakeIdentityStore, MemoryPasswordCredentialStore, MemorySecretStore, MemorySessionIssuer, RecordingEventSink } from '@spinajs/authn-testing';

import { Argon2PasswordHasher, EXPIRED_PASSWORD_MARKER } from '../src/hasher.js';
import { PasswordMail, PasswordMailer } from '../src/mailer.js';
import { LocalPasswordPolicy } from '../src/policy.js';
import { LocalPasswordService, LocalPasswordServiceDeps } from '../src/service.js';
import { LocalPasswordStrategy } from '../src/strategy.js';
import { PasswordAgeSource, PasswordExpirationJob, PasswordExpirationJobDeps } from '../src/expiration.js';
import { RecordingTokenService } from './recording-token-service.js';

const OLD = 'Old-Password-1';
const NEW = 'New-Password-2';
const LOGIN = 'alice@example.com';
const NOW = new Date('2026-10-03T12:00:00Z');
const DAY = 86_400_000;
const ADMIN: IdentityRef = { type: 'user', id: 'admin-1' };
const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => ({ now: NOW, purpose: 'request', ip: '198.51.100.4', userAgent: 'mocha', ...over });
const later = (seconds: number) => ctx({ now: new Date(NOW.getTime() + seconds * 1000) });
const facts = (impersonator?: IdentityRef): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: NOW, ...(impersonator ? { impersonator } : {}) });
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

class ExpiryRecordingMailer extends PasswordMailer {
  public readonly mails: PasswordMail[] = [];
  public async send(mail: PasswordMail): Promise<void> {
    this.mails.push(mail);
  }
}

async function setup(over: Partial<LocalPasswordServiceDeps> = {}) {
  const identities = new FakeIdentityStore();
  const passwords = new MemoryPasswordCredentialStore();
  const sessions = new MemorySessionIssuer();
  const events = new RecordingEventSink();
  const tokens = new RecordingTokenService();
  const secrets = new MemorySecretStore();
  const mailer = new ExpiryRecordingMailer();
  const hasher = new Argon2PasswordHasher({});
  await hasher.resolve();
  const warnings: string[] = [];
  const service = new LocalPasswordService({
    identities,
    passwords,
    sessions,
    throttle: new FakeBackoffThrottle(DEFAULT_THROTTLE),
    tokens,
    secrets,
    mailer,
    sinks: [events],
    hasher,
    policy: new LocalPasswordPolicy({}),
    log: { warn: (m: string) => warnings.push(m) },
    resetUrl: 'https://app.example.com/password-reset',
    ...over,
  });
  const strategy = new LocalPasswordStrategy({ identities, passwords, hasher });
  await strategy.resolve();

  const alice = identities.add({ login: LOGIN, email: LOGIN, name: 'Alice' });
  await passwords.set(alice, await hasher.hash(OLD));
  const login = async (password: string) => strategy.verify({ kind: 'password', login: LOGIN, password }, ctx({ purpose: 'login' }));
  return { identities, passwords, sessions, events, tokens, secrets, mailer, hasher, service, strategy, alice, warnings, login };
}

describe('LocalPasswordService expire (D15, A30)', function () {
  this.timeout(60_000);

  it('admin expiry stores the marker, revokes every session incl. impersonations and the tokens with the actor', async () => {
    const x = await setup();
    const carol = x.identities.add({ login: 'carol@example.com' });
    const own = await x.sessions.issue(x.alice, facts());
    const impersonating = await x.sessions.issue(carol, facts(x.alice));
    const carols = await x.sessions.issue(carol, facts());

    await x.service.expire(x.alice, { cause: 'admin', actor: ADMIN }, ctx());

    expect(await x.passwords.get(x.alice)).to.equal(EXPIRED_PASSWORD_MARKER);
    expect(await x.sessions.restore(own.id)).to.equal(null);
    expect(await x.sessions.restore(impersonating.id)).to.equal(null);
    expect(await x.sessions.restore(carols.id)).to.not.equal(null);
    expect(x.tokens.calls.map((c) => c.method)).to.deep.equal(['revokeAllFor']);
    expect(x.tokens.calls[0].args[0]).to.deep.equal(x.alice);
    expect(x.tokens.calls[0].args[2]).to.deep.equal({ actor: ADMIN });

    const [e] = x.events.ofType('password.change');
    expect(e).to.include({ outcome: 'success' });
    expect(e.identity).to.deep.equal(x.alice);
    expect(e.actor).to.deep.equal(ADMIN);
    expect(e.data).to.deep.equal({ cause: 'admin', expired: true });
  });

  it('admin expiry with revokeTokens false keeps the tokens', async () => {
    const x = await setup({ revokeTokens: false });
    await x.service.expire(x.alice, { cause: 'admin', actor: ADMIN }, ctx());
    expect(await x.passwords.get(x.alice)).to.equal(EXPIRED_PASSWORD_MARKER);
    expect(x.tokens.calls).to.deep.equal([]);
  });

  it('admin expiry without sendReset mails nothing and issues no secret', async () => {
    for (const opts of [
      { cause: 'admin', actor: ADMIN },
      { cause: 'admin', actor: ADMIN, sendReset: false },
    ] as PasswordExpiry[]) {
      const x = await setup();
      await x.service.expire(x.alice, opts, ctx());
      expect(x.mailer.mails).to.have.length(0);
      expect(x.secrets.rows()).to.have.length(0);
    }
  });

  it('admin expiry with sendReset mails a reset link', async () => {
    const x = await setup();
    await x.service.expire(x.alice, { cause: 'admin', actor: ADMIN, sendReset: true }, ctx());
    expect(x.mailer.mails).to.have.length(1);
    expect(x.mailer.mails[0]).to.include({ purpose: 'reset', ttlSeconds: 3600, url: 'https://app.example.com/password-reset' });
    expect(x.mailer.mails[0].identity).to.deep.equal(x.alice);
  });

  it('aged expiry revokes every session, keeps the tokens (H32) and mails a reset link', async () => {
    const x = await setup();
    const carol = x.identities.add({ login: 'carol@example.com' });
    const own = await x.sessions.issue(x.alice, facts());
    const impersonating = await x.sessions.issue(carol, facts(x.alice));

    await x.service.expire(x.alice, { cause: 'aged' }, ctx());

    expect(await x.passwords.get(x.alice)).to.equal(EXPIRED_PASSWORD_MARKER);
    expect(await x.sessions.restore(own.id)).to.equal(null);
    expect(await x.sessions.restore(impersonating.id)).to.equal(null);
    expect(x.tokens.calls).to.deep.equal([]);
    expect(x.mailer.mails.map((m) => m.purpose)).to.deep.equal(['reset']);
    const [e] = x.events.ofType('password.change');
    expect(e.actor).to.equal(undefined);
    expect(e.data).to.deep.equal({ cause: 'aged', expired: true });
  });

  it('mails no reset link to an identity that could not redeem it', async () => {
    const x = await setup();
    x.identities.setStatus(x.alice, { banned: true });
    await x.service.expire(x.alice, { cause: 'aged' }, ctx());
    await x.service.expire(x.alice, { cause: 'admin', actor: ADMIN, sendReset: true }, ctx());
    expect(await x.passwords.get(x.alice)).to.equal(EXPIRED_PASSWORD_MARKER);
    expect(x.mailer.mails).to.have.length(0);
  });

  for (const [label, opts] of [
    ['admin', { cause: 'admin', actor: ADMIN }],
    ['aged', { cause: 'aged' }],
  ] as [string, PasswordExpiry][]) {
    it(`A30 after an ${label} expiry the old password no longer logs in and the stored value never verifies`, async () => {
      const x = await setup();
      expect((await x.login(OLD)).ok).to.equal(true);
      await x.service.expire(x.alice, opts, ctx());
      expect(await x.login(OLD)).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
      const stored = await x.passwords.get(x.alice);
      for (const p of [OLD, NEW, EXPIRED_PASSWORD_MARKER, '']) {
        expect(await x.hasher.verify(stored, p)).to.equal(false);
      }
    });
  }

  it('A30 a reset after expiry restores login with the new password', async () => {
    const x = await setup();
    await x.service.expire(x.alice, { cause: 'aged' }, ctx());
    const secret = x.mailer.mails[0].secret;
    expect(await x.service.redeemReset(LOGIN, secret, NEW, later(1))).to.deep.equal({ status: 'reset', purpose: 'reset' });
    expect((await x.login(NEW)).ok).to.equal(true);
    expect((await x.login(OLD)).ok).to.equal(false);
  });

  it('a failing mailer is logged by name; the expiry holds and the caller gets no error', async () => {
    class BrokenMailer extends PasswordMailer {
      public async send(mail: PasswordMail): Promise<void> {
        throw new Error(`smtp refused ${mail.secret}`);
      }
    }
    const x = await setup({ mailer: new BrokenMailer() });
    await x.service.expire(x.alice, { cause: 'aged' }, ctx());
    expect(await x.passwords.get(x.alice)).to.equal(EXPIRED_PASSWORD_MARKER);
    expect(x.warnings).to.have.length(1);
    expect(x.warnings[0]).to.contain('Error');
    expect(x.warnings[0]).to.not.contain('smtp refused');
  });

  it('events and log lines never hold the reset secret', async () => {
    const x = await setup();
    await x.service.expire(x.alice, { cause: 'admin', actor: ADMIN, sendReset: true }, ctx());
    const secret = x.mailer.mails[0].secret;
    const text = JSON.stringify([x.events.all(), x.warnings]);
    expect(text).to.not.contain(secret);
    expect(text).to.not.contain(sha256hex(secret));
  });
});

class MapAgeSource extends PasswordAgeSource {
  public readonly cutoffs: Date[] = [];
  constructor(private readonly setAt: ReadonlyMap<IdentityRef, Date>) {
    super();
  }
  public async passwordsSetBefore(cutoff: Date): Promise<readonly IdentityRef[]> {
    this.cutoffs.push(cutoff);
    return [...this.setAt].filter(([, at]) => at.getTime() < cutoff.getTime()).map(([id]) => id);
  }
}

class RecordingExpiryService extends PasswordService {
  public readonly expired: { id: IdentityRef; opts: PasswordExpiry; ctx: AuthnContext }[] = [];
  constructor(private readonly failFor: IdentityRef | null = null) {
    super();
  }
  public async expire(id: IdentityRef, opts: PasswordExpiry, ctx: AuthnContext): Promise<void> {
    if (this.failFor && this.failFor.id === id.id) {
      throw new TypeError('store refused $argon2id$v=19$secret-hash');
    }
    this.expired.push({ id, opts, ctx });
  }
  public change(): never {
    throw new Error('unused');
  }
  public requestReset(): never {
    throw new Error('unused');
  }
  public redeemReset(): never {
    throw new Error('unused');
  }
  public invite(): never {
    throw new Error('unused');
  }
  public policy(): never {
    throw new Error('unused');
  }
  public check(): never {
    throw new Error('unused');
  }
  public set(): never {
    throw new Error('unused');
  }
}

describe('PasswordExpirationJob (D16)', () => {
  const old1: IdentityRef = { type: 'user', id: 'old-1' };
  const old2: IdentityRef = { type: 'user', id: 'old-2' };
  const marked: IdentityRef = { type: 'user', id: 'marked' };
  const fresh: IdentityRef = { type: 'user', id: 'fresh' };

  async function jobSetup(over: Partial<PasswordExpirationJobDeps> = {}, failFor: IdentityRef | null = null) {
    const passwords = new MemoryPasswordCredentialStore();
    for (const id of [old1, old2, fresh]) {
      await passwords.set(id, '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$aGFzaA');
    }
    await passwords.set(marked, EXPIRED_PASSWORD_MARKER);
    const ages = new MapAgeSource(
      new Map([
        [old1, new Date(NOW.getTime() - 40 * DAY)],
        [old2, new Date(NOW.getTime() - 31 * DAY - 1)],
        [marked, new Date(NOW.getTime() - 90 * DAY)],
        [fresh, new Date(NOW.getTime() - 30 * DAY)],
      ]),
    );
    const service = new RecordingExpiryService(failFor);
    const warnings: string[] = [];
    const job = new PasswordExpirationJob({ ages, passwords, service, enabled: true, log: { warn: (m: string) => warnings.push(m) }, ...over });
    return { passwords, ages, service, warnings, job };
  }

  it('expires only identities older than now − maxAgeDays (default 31) and skips marked ones', async () => {
    const x = await jobSetup();
    expect(await x.job.run(NOW)).to.deep.equal({ expired: 2, skipped: 1, failed: 0 });
    expect(x.ages.cutoffs).to.deep.equal([new Date(NOW.getTime() - 31 * DAY)]);
    expect(x.service.expired.map((e) => e.id)).to.deep.equal([old1, old2]);
    for (const e of x.service.expired) {
      expect(e.opts).to.deep.equal({ cause: 'aged' });
      expect(e.ctx.now).to.deep.equal(NOW);
    }
  });

  it('takes maxAgeDays from its settings', async () => {
    const x = await jobSetup({ maxAgeDays: 35 });
    expect(await x.job.run(NOW)).to.deep.equal({ expired: 1, skipped: 1, failed: 0 });
    expect(x.ages.cutoffs).to.deep.equal([new Date(NOW.getTime() - 35 * DAY)]);
  });

  it('defaults now to the current time', async () => {
    const x = await jobSetup();
    const before = Date.now();
    await x.job.run();
    const cutoff = x.ages.cutoffs[0].getTime() + 31 * DAY;
    expect(cutoff).to.be.within(before, Date.now());
  });

  it('does nothing when disabled (the default)', async () => {
    const x = await jobSetup({ enabled: undefined });
    expect(await x.job.run(NOW)).to.deep.equal({ idle: 'disabled', expired: 0, skipped: 0, failed: 0 });
    expect(x.ages.cutoffs).to.deep.equal([]);
    expect(x.service.expired).to.deep.equal([]);
  });

  it('does nothing and logs without a PasswordAgeSource', async () => {
    const x = await jobSetup({ ages: null });
    expect(await x.job.run(NOW)).to.deep.equal({ idle: 'no_source', expired: 0, skipped: 0, failed: 0 });
    expect(x.service.expired).to.deep.equal([]);
    expect(x.warnings.some((w) => w.includes('PasswordAgeSource'))).to.equal(true);
  });

  it('one failing identity does not stop the rest and is logged by error name only', async () => {
    const x = await jobSetup({}, old1);
    expect(await x.job.run(NOW)).to.deep.equal({ expired: 1, skipped: 1, failed: 1 });
    expect(x.service.expired.map((e) => e.id)).to.deep.equal([old2]);
    expect(x.warnings).to.have.length(1);
    expect(x.warnings[0]).to.contain('TypeError');
    expect(x.warnings[0]).to.contain('old-1');
    expect(x.warnings[0]).to.not.contain('$argon2');
  });

  it('refuses a maxAgeDays that is not a positive number', async () => {
    for (const maxAgeDays of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const x = await jobSetup({ maxAgeDays });
      let error: unknown;
      try {
        await x.job.run(NOW);
      } catch (e) {
        error = e;
      }
      expect(error, String(maxAgeDays)).to.be.instanceOf(Error);
      expect(x.ages.cutoffs).to.deep.equal([]);
    }
  });

  it('expires through the real service: the old password no longer verifies and the owner gets a reset mail', async () => {
    const x = await setup();
    const ages = new MapAgeSource(new Map([[x.alice, new Date(NOW.getTime() - 40 * DAY)]]));
    const job = new PasswordExpirationJob({ ages, passwords: x.passwords, service: x.service, enabled: true });
    expect(await job.run(NOW)).to.deep.equal({ expired: 1, skipped: 0, failed: 0 });
    expect((await x.login(OLD)).ok).to.equal(false);
    expect(x.mailer.mails.map((m) => m.purpose)).to.deep.equal(['reset']);
    expect(await job.run(NOW)).to.deep.equal({ expired: 0, skipped: 1, failed: 0 });
  });
});
