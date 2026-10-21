/* eslint-disable @typescript-eslint/no-unsafe-member-access -- the tamper tests write into hook inputs untyped, as a careless hook would */
import 'mocha';
import { expect } from 'chai';
import { ActionRefused } from '@spinajs/hooks';
import { IdentityAddressVerifier } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnFacts, IdentityRef, PrincipalRef } from '@spinajs/authn/contracts';
import { DEFAULT_THROTTLE, FakeBackoffThrottle, FakeIdentityStore, MemoryPasswordCredentialStore, MemorySecretStore, MemorySessionIssuer, RecordingEventSink, ScriptedActionHook, kitHooks } from '@spinajs/authn-testing';

import { Argon2PasswordHasher, EXPIRED_PASSWORD_MARKER } from '../src/hasher.js';
import { PasswordMail, PasswordMailer } from '../src/mailer.js';
import { LocalPasswordPolicy } from '../src/policy.js';
import { LocalPasswordService } from '../src/service.js';

const LOGIN = 'alice@example.com';
const OLD = 'Old-Password-1';
const NEW = 'New-Password-2';
const CODE = 'not-today';
const ADMIN: PrincipalRef = { type: 'user', id: 'admin-1' };
const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => ({ now: new Date(), purpose: 'request', ip: '198.51.100.4', userAgent: 'mocha', ...over });
const facts = (): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() });

/** Counts the writes made after `arm()`. */
class SpyPasswordStore extends MemoryPasswordCredentialStore {
  public armedWrites = 0;
  private armed = false;

  public arm(): void {
    this.armed = true;
  }

  public async set(id: IdentityRef, hash: string, expected?: string | null): Promise<boolean> {
    if (this.armed) this.armedWrites++;
    return super.set(id, hash, expected);
  }
}

/** Records the keys of every attempt. */
class KeyThrottle extends FakeBackoffThrottle {
  public readonly keys: string[] = [];

  public async attempt(...args: Parameters<FakeBackoffThrottle['attempt']>) {
    this.keys.push(...args[0].map((k) => `${k.kind}=${k.value}`));
    return super.attempt(...args);
  }
}

class RecordingMailer extends PasswordMailer {
  public readonly mails: PasswordMail[] = [];
  public async send(mail: PasswordMail): Promise<void> {
    this.mails.push(mail);
  }
}

class RecordingVerifier extends IdentityAddressVerifier {
  public readonly marked: IdentityRef[] = [];
  public async markVerified(id: IdentityRef): Promise<void> {
    this.marked.push(id);
  }
}

async function setup() {
  const identities = new FakeIdentityStore();
  const passwords = new SpyPasswordStore();
  const sessions = new MemorySessionIssuer();
  const events = new RecordingEventSink();
  const secrets = new MemorySecretStore();
  const mailer = new RecordingMailer();
  const verifier = new RecordingVerifier();
  const hasher = new Argon2PasswordHasher({});
  await hasher.resolve();
  const hook = new ScriptedActionHook();
  const throttle = new KeyThrottle(DEFAULT_THROTTLE);
  const service = new LocalPasswordService({
    identities,
    passwords,
    sessions,
    throttle,
    tokens: null,
    secrets,
    mailer,
    verifier,
    sinks: [events],
    hasher,
    policy: new LocalPasswordPolicy({}),
    hooks: await kitHooks([hook]),
  });
  const alice = identities.add({ login: LOGIN, email: LOGIN });
  await passwords.set(alice, await hasher.hash(OLD));
  passwords.arm();
  const session = await sessions.issue(alice, facts());
  const audited = (type: string, reason: string) => events.all().some((e) => e.type === type && e.outcome === 'failure' && e.reason === reason);
  const mailsOf = async (purpose: string) => {
    await service.drain();
    return mailer.mails.filter((m) => m.purpose === purpose);
  };
  return { identities, passwords, sessions, events, secrets, mailer, verifier, hook, service, alice, session, audited, mailsOf, throttle };
}

/** Requests a reset for alice and returns the secret its mail holds. */
async function resetSecret(x: Awaited<ReturnType<typeof setup>>): Promise<string> {
  expect(await x.service.requestReset(LOGIN, ctx())).to.deep.equal({ status: 'accepted' });
  const [mail] = await x.mailsOf('reset');
  expect(mail, 'the reset mail').to.not.equal(undefined);
  return mail.secret;
}

const phases = (hook: ScriptedActionHook, action: string) => hook.calls(action).map((c) => c.phase);
const afterOf = (hook: ScriptedActionHook, action: string) => hook.calls(action).find((c) => c.phase === 'after')?.output;

describe('LocalPasswordService action hooks', function () {
  this.timeout(60_000);

  describe('refused answers', () => {
    it('change answers { status: refused, code }, stores no hash and audits hook:<code>', async () => {
      const x = await setup();
      x.hook.refuse('authn.password.change', CODE);
      expect(await x.service.change(x.alice, OLD, NEW, x.session, ctx({ purpose: 'reauth' }))).to.deep.equal({ status: 'refused', code: CODE });
      expect(x.passwords.armedWrites).to.equal(0);
      expect(x.audited('password.change', `hook:${CODE}`)).to.equal(true);
      expect(await x.sessions.restore(x.session.id), 'the session is kept').to.not.equal(null);
    });

    it('change answers { status: refused, code: hook_error } for a hook that fails, audited as hook_error', async () => {
      const x = await setup();
      x.hook.fail('authn.password.change');
      expect(await x.service.change(x.alice, OLD, NEW, x.session, ctx({ purpose: 'reauth' }))).to.deep.equal({ status: 'refused', code: 'hook_error' });
      expect(x.passwords.armedWrites).to.equal(0);
      expect(x.audited('password.change', 'hook_error')).to.equal(true);
    });

    it('set answers { status: refused, code } and stores no hash', async () => {
      const x = await setup();
      x.hook.refuse('authn.password.set', CODE);
      expect(await x.service.set(x.alice, NEW, ctx(), { actor: ADMIN })).to.deep.equal({ status: 'refused', code: CODE });
      expect(x.passwords.armedWrites).to.equal(0);
      expect(x.audited('password.change', `hook:${CODE}`)).to.equal(true);
    });

    it('redeemReset answers { status: refused, code }, stores no hash and leaves the secret unspent', async () => {
      const x = await setup();
      const secret = await resetSecret(x);
      x.hook.refuse('authn.password.reset.redeem', CODE);
      expect(await x.service.redeemReset(LOGIN, secret, NEW, ctx())).to.deep.equal({ status: 'refused', code: CODE });
      expect(x.passwords.armedWrites).to.equal(0);
      expect(x.audited('password.reset', `hook:${CODE}`)).to.equal(true);
      x.hook.reset();
      expect(await x.service.redeemReset(LOGIN, secret, NEW, ctx())).to.deep.equal({ status: 'reset', purpose: 'reset' });
    });

    it('requestReset answers { status: accepted } and dispatches no mail', async () => {
      const x = await setup();
      x.hook.refuse('authn.password.reset.request', CODE);
      expect(await x.service.requestReset(LOGIN, ctx())).to.deep.equal({ status: 'accepted' });
      expect(await x.mailsOf('reset')).to.have.length(0);
      expect(x.audited('password.reset.request', `hook:${CODE}`)).to.equal(true);
    });

    it('requestReset answers the same for an unknown login when refused', async () => {
      const x = await setup();
      x.hook.refuse('authn.password.reset.request', CODE);
      expect(await x.service.requestReset('nobody@example.com', ctx())).to.deep.equal({ status: 'accepted' });
    });

    it('invite throws ActionRefused and dispatches no mail', async () => {
      const x = await setup();
      x.hook.refuse('authn.password.invite', CODE);
      const err = await x.service.invite(x.alice, ctx(), { actor: ADMIN }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).to.be.instanceOf(ActionRefused);
      expect((err as ActionRefused).code).to.equal(CODE);
      expect(await x.mailsOf('invite')).to.have.length(0);
    });

    it("expire({ cause: 'admin' }) refused throws ActionRefused and expires nothing; expire({ cause: 'aged' }) with a refusing hook still expires", async () => {
      const x = await setup();
      const stored = await x.passwords.get(x.alice);
      x.hook.refuse('authn.password.expire', CODE);
      const err = await x.service.expire(x.alice, { cause: 'admin', actor: ADMIN }, ctx()).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).to.be.instanceOf(ActionRefused);
      expect(await x.passwords.get(x.alice)).to.equal(stored);
      expect(x.passwords.armedWrites).to.equal(0);
      expect(await x.sessions.restore(x.session.id), 'no session is revoked').to.not.equal(null);
      expect(x.audited('password.change', `hook:${CODE}`)).to.equal(true);

      await x.service.expire(x.alice, { cause: 'aged' }, ctx());
      expect(await x.passwords.get(x.alice)).to.equal(EXPIRED_PASSWORD_MARKER);
      expect(phases(x.hook, 'authn.password.expire')).to.deep.equal(['before', 'before', 'after']);
    });

    it('requestVerification answers { status: accepted } with no mail; redeemVerification answers invalid', async () => {
      const x = await setup();
      x.identities.setStatus(x.alice, { addressVerified: false });
      // Another identity: the refused request already counted in the throttle, which runs before the hooks.
      const bob = x.identities.add({ login: 'bob@example.com', email: 'bob@example.com', status: { addressVerified: false } });
      x.hook.refuse('authn.address.verify.request', CODE);
      expect(await x.service.requestVerification(bob, ctx())).to.deep.equal({ status: 'accepted' });
      expect(await x.mailsOf('verify')).to.have.length(0);

      x.hook.reset();
      expect(await x.service.requestVerification(x.alice, ctx())).to.deep.equal({ status: 'accepted' });
      const [mail] = await x.mailsOf('verify');
      x.hook.refuse('authn.address.verify', CODE);
      expect(await x.service.redeemVerification(mail.secret, ctx())).to.deep.equal({ status: 'invalid' });
      expect(x.verifier.marked).to.deep.equal([]);
      expect(x.audited('address.verify', `hook:${CODE}`)).to.equal(true);
    });
  });

  describe('hooks get copies', () => {
    it('a hook writing ctx.ip, the session handle or the id in place reaches neither the throttle nor the change', async () => {
      const x = await setup();
      const bob = x.identities.add({ login: 'bob@example.com', email: 'bob@example.com' });
      x.hook.tamper('authn.password.change', (i) => {
        i.ctx.ip = '203.0.113.9';
        i.session.id = 'forged';
        i.id.id = bob.id;
      });
      const r = await x.service.change(x.alice, OLD, NEW, x.session, ctx({ purpose: 'reauth' }));
      expect(r.status).to.equal('changed');
      expect(x.throttle.keys.some((k) => k.includes('203.0.113.9'))).to.equal(false);
      expect(await x.passwords.get(bob)).to.equal(null, "bob's password is untouched");
      expect(x.hook.landed()).to.deep.equal([]);
    });

    it('a hook writing the id or the expiry options in place does not move set, invite, the verification request or expire', async () => {
      const x = await setup();
      const bob = x.identities.add({ login: 'bob@example.com', email: 'bob@example.com', status: { addressVerified: false } });
      x.identities.setStatus(x.alice, { addressVerified: false });
      x.hook.tamper('authn.password.*', (i) => {
        i.id.id = bob.id;
      });
      x.hook.tamper('authn.address.verify.request', (i) => {
        i.id.id = bob.id;
      });
      x.hook.tamper('authn.password.expire', (i) => {
        i.opts.cause = 'aged';
      });
      expect((await x.service.set(x.alice, NEW, ctx(), { actor: ADMIN })).status).to.equal('set');
      expect(await x.passwords.get(bob)).to.equal(null);
      await x.service.invite(x.alice, ctx(), { actor: ADMIN });
      await x.service.requestVerification(x.alice, ctx());
      for (const purpose of ['invite', 'verify']) {
        expect((await x.mailsOf(purpose)).map((m) => m.identity.id)).to.deep.equal([x.alice.id], purpose);
      }
      x.hook.refuse('authn.password.expire', CODE);
      const err = await x.service.expire(x.alice, { cause: 'admin', actor: ADMIN }, ctx()).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, 'still refusable: the cause the hook rewrote is not the one that decides').to.be.instanceOf(ActionRefused);
      expect(x.hook.landed()).to.deep.equal([]);
    });
  });

  describe('no passwords exposed', () => {
    it('no hook input on authn.password.* holds oldPassword or newPassword, or a password or secret value', async () => {
      const x = await setup();
      await x.service.change(x.alice, OLD, NEW, x.session, ctx({ purpose: 'reauth' }));
      await x.service.set(x.alice, OLD, ctx(), { actor: ADMIN });
      const secret = await resetSecret(x);
      await x.service.redeemReset(LOGIN, secret, NEW, ctx());

      const calls = x.hook.calls().filter((c) => c.action.startsWith('authn.password.'));
      expect(new Set(calls.map((c) => c.action))).to.deep.equal(new Set(['authn.password.change', 'authn.password.set', 'authn.password.reset.request', 'authn.password.reset.redeem']));
      for (const call of calls) {
        expect(call.input, call.action).to.not.have.any.keys('oldPassword', 'newPassword', 'password', 'secret');
      }
      const text = JSON.stringify(x.hook.calls());
      for (const value of [OLD, NEW, secret]) expect(text).to.not.contain(value);
    });
  });

  describe('after hooks', () => {
    it("see status 'changed', 'set' and 'reset' with its purpose", async () => {
      const x = await setup();
      expect((await x.service.change(x.alice, OLD, NEW, x.session, ctx({ purpose: 'reauth' }))).status).to.equal('changed');
      expect((await x.service.set(x.alice, OLD, ctx(), { actor: ADMIN })).status).to.equal('set');
      const secret = await resetSecret(x);
      expect((await x.service.redeemReset(LOGIN, secret, NEW, ctx())).status).to.equal('reset');

      expect(afterOf(x.hook, 'authn.password.change')).to.deep.equal({ status: 'changed' });
      expect(afterOf(x.hook, 'authn.password.set')).to.deep.equal({ status: 'set' });
      expect(afterOf(x.hook, 'authn.password.reset.redeem')).to.deep.equal({ status: 'reset', purpose: 'reset' });
      expect(phases(x.hook, 'authn.password.change')).to.deep.equal(['before', 'after']);
    });

    it('see failure results too: a wrong old password is an output, not an error', async () => {
      const x = await setup();
      expect(await x.service.change(x.alice, 'Wrong-Password-9', NEW, x.session, ctx({ purpose: 'reauth' }))).to.deep.equal({ status: 'invalid' });
      expect(afterOf(x.hook, 'authn.password.change')).to.deep.equal({ status: 'invalid' });
    });
  });
});
