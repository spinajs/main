import * as chai from 'chai';
import 'mocha';

import { PasswordService } from '../../src/contracts/password.js';
import type { PasswordChangeResult, PasswordExpiry, PasswordPolicy, PasswordRefusal, PasswordResetRequestResult, PasswordResetResult, PasswordSetResult, PasswordViolation } from '../../src/contracts/password.js';
import type { AuthnContext, IdentityRef } from '../../src/contracts/credentials.js';
import type { PrincipalRef } from '../../src/contracts/principal.js';
import type { SessionHandle } from '../../src/contracts/session.js';
import * as index from '../../src/contracts/index.js';
import { classMembers, declarationDocs, docOf, memberDocs, same, shapeOf, unionLiterals } from './source-shape.js';

const expect = chai.expect;

const alice: IdentityRef = { type: 'user', id: 'alice' };
const ctx: AuthnContext = { now: new Date(0), ip: '10.0.0.1', purpose: 'reauth' };
const admin: PrincipalRef = { type: 'user', id: 'root' };

type Refusal = { readonly status: 'invalid' } | { readonly status: 'throttled'; readonly retryAfterSeconds: number } | { readonly status: 'rejected'; readonly violations: readonly PasswordViolation[] };

// Enough of a service to show the contract can be implemented as §22.7 describes it.
class MemoryPasswords extends PasswordService {
  readonly passwords = new Map<string, string>([['alice', 'correct horse']]);
  readonly secrets = new Map<string, { purpose: 'reset' | 'invite'; raw: string }>();
  readonly invitePending = new Set<string>();
  readonly sessions = new Map<string, string>([
    ['s1', 'alice'],
    ['s2', 'alice'],
  ]);
  tokens = 2;
  mails: string[] = [];
  private seq = 2;

  async change(id: IdentityRef, oldPassword: string, newPassword: string, session: SessionHandle, _ctx: AuthnContext): Promise<PasswordChangeResult> {
    const violations = await this.check(newPassword);
    if (violations.length > 0) return { status: 'rejected', violations };
    if (this.sessions.get(session.id) !== id.id || this.passwords.get(id.id) !== oldPassword) return { status: 'invalid' };
    this.passwords.set(id.id, newPassword);
    for (const [s, owner] of this.sessions) if (owner === id.id) this.sessions.delete(s);
    const rotated = `s${++this.seq}`;
    this.sessions.set(rotated, id.id);
    return { status: 'changed', session: { id: rotated, state: 'active' } };
  }
  async requestReset(login: string, _ctx: AuthnContext): Promise<PasswordResetRequestResult> {
    if (this.passwords.has(login)) this.mails.push(login);
    return { status: 'accepted' };
  }
  async redeemReset(login: string, secret: string, newPassword: string, _ctx: AuthnContext): Promise<PasswordResetResult> {
    const violations = await this.check(newPassword);
    if (violations.length > 0) return { status: 'rejected', violations };
    const s = this.secrets.get(login);
    if (!s || s.raw !== secret || (s.purpose === 'invite' && !this.invitePending.has(login))) return { status: 'invalid' };
    this.secrets.delete(login);
    this.passwords.set(login, newPassword);
    this.revokeEverything(login);
    return { status: 'reset', purpose: s.purpose };
  }
  async invite(id: IdentityRef, _ctx: AuthnContext, _opts?: { readonly actor?: PrincipalRef }): Promise<void> {
    this.secrets.set(id.id, { purpose: 'invite', raw: 'i-secret' });
  }
  policy(): PasswordPolicy {
    return { minLength: 8, maxLength: 128 };
  }
  async check(password: string): Promise<readonly PasswordViolation[]> {
    const out: PasswordViolation[] = [];
    if (password.length < 8) out.push('too_short');
    if (password.length > 128) out.push('too_long');
    if (password === 'password1') out.push('blocklisted');
    return out;
  }
  async set(id: IdentityRef, newPassword: string, _ctx: AuthnContext, _opts?: { readonly actor?: PrincipalRef }): Promise<PasswordSetResult> {
    const violations = await this.check(newPassword);
    if (violations.length > 0) return { status: 'rejected', violations };
    this.passwords.set(id.id, newPassword);
    this.revokeEverything(id.id);
    return { status: 'set' };
  }
  async expire(id: IdentityRef, opts: PasswordExpiry, _ctx: AuthnContext): Promise<void> {
    this.passwords.delete(id.id);
    this.revokeEverything(id.id, opts.cause === 'admin');
    if (opts.cause === 'aged' || opts.sendReset) this.mails.push(id.id);
  }
  private revokeEverything(owner: string, tokens = true): void {
    for (const [s, o] of this.sessions) if (o === owner) this.sessions.delete(s);
    if (tokens) this.tokens = 0;
  }
}

describe('password service contract', () => {
  describe('runtime', () => {
    it('exports PasswordService from the contracts index as a plain abstract class', () => {
      expect(index.PasswordService).to.eq(PasswordService);
      expect(PasswordService).to.be.a('function');
      expect(Object.getPrototypeOf(PasswordService)).to.eq(Function.prototype);
    });

    it('a change rotates the current session, ends the others and keeps tokens', async () => {
      const p = new MemoryPasswords();
      expect(await p.change(alice, 'wrong', 'a new password', { id: 's1', state: 'active' }, ctx)).to.deep.eq({ status: 'invalid' });
      expect(await p.change(alice, 'correct horse', 'short', { id: 's1', state: 'active' }, ctx)).to.deep.eq({ status: 'rejected', violations: ['too_short'] });
      const r = await p.change(alice, 'correct horse', '  spaces kept  ', { id: 's1', state: 'active' }, ctx);
      expect(r).to.deep.eq({ status: 'changed', session: { id: 's3', state: 'active' } });
      expect([...p.sessions.keys()]).to.deep.eq(['s3']);
      expect(p.passwords.get('alice')).to.eq('  spaces kept  ');
      expect(p.tokens).to.eq(2);
    });

    it('a reset request answers alike for known and unknown logins and a redeem is single use', async () => {
      const p = new MemoryPasswords();
      expect(await p.requestReset('alice', ctx)).to.deep.eq(await p.requestReset('nobody', ctx));
      p.secrets.set('alice', { purpose: 'reset', raw: 'r-secret' });
      expect(await p.redeemReset('alice', 'r-secret', 'short', ctx)).to.deep.eq({ status: 'rejected', violations: ['too_short'] });
      expect(await p.redeemReset('alice', 'r-secret', 'brand new pass', ctx)).to.deep.eq({ status: 'reset', purpose: 'reset' });
      expect(await p.redeemReset('alice', 'r-secret', 'brand new pass', ctx)).to.deep.eq({ status: 'invalid' });
      expect(await p.redeemReset('nobody', 'r-secret', 'brand new pass', ctx)).to.deep.eq({ status: 'invalid' });
      expect(p.sessions.size).to.eq(0);
      expect(p.tokens).to.eq(0);
    });

    it('an invite redeems only while the invite is pending', async () => {
      const p = new MemoryPasswords();
      const bob: IdentityRef = { type: 'user', id: 'bob' };
      await p.invite(bob, ctx, { actor: admin });
      expect(await p.redeemReset('bob', 'i-secret', 'brand new pass', ctx)).to.deep.eq({ status: 'invalid' });
      p.invitePending.add('bob');
      expect(await p.redeemReset('bob', 'i-secret', 'brand new pass', ctx)).to.deep.eq({ status: 'reset', purpose: 'invite' });
    });

    it('policy, check, set and expire', async () => {
      const p = new MemoryPasswords();
      expect(p.policy()).to.deep.eq({ minLength: 8, maxLength: 128 });
      expect(await p.check('password1')).to.deep.eq(['blocklisted']);
      expect(await p.set(alice, 'x'.repeat(129), ctx)).to.deep.eq({ status: 'rejected', violations: ['too_long'] });
      expect(await p.set(alice, 'a fine password', ctx, { actor: admin })).to.deep.eq({ status: 'set' });
      await p.expire(alice, { cause: 'admin', actor: admin, sendReset: true }, ctx);
      expect(p.passwords.has('alice')).to.eq(false);
      expect(p.mails).to.deep.eq(['alice']);
      expect(p.tokens).to.eq(0);
    });

    it('an aged password ends the sessions but keeps the tokens (H32)', async () => {
      const p = new MemoryPasswords();
      await p.expire(alice, { cause: 'aged' }, ctx);
      expect(p.passwords.has('alice')).to.eq(false);
      expect(p.sessions.size).to.eq(0);
      expect(p.tokens).to.eq(2);
      expect(p.mails).to.deep.eq(['alice']);
    });
  });

  describe('source shape (member names, modifiers, parameter names)', () => {
    it('password.ts holds PasswordService with the design methods plus check, set and expire', () => {
      expect(shapeOf(classMembers('password.ts'))).to.deep.eq({
        PasswordService: {
          base: null,
          members: [
            { name: 'change', modifiers: ['abstract'], optional: false, params: ['id', 'oldPassword', 'newPassword', 'session', 'ctx'] },
            { name: 'requestReset', modifiers: ['abstract'], optional: false, params: ['login', 'ctx'] },
            { name: 'redeemReset', modifiers: ['abstract'], optional: false, params: ['login', 'secret', 'newPassword', 'ctx'] },
            { name: 'invite', modifiers: ['abstract'], optional: false, params: ['id', 'ctx', 'opts'] },
            { name: 'policy', modifiers: ['abstract'], optional: false, params: [] },
            { name: 'check', modifiers: ['abstract'], optional: false, params: ['password'] },
            { name: 'set', modifiers: ['abstract'], optional: false, params: ['id', 'newPassword', 'ctx', 'opts'] },
            { name: 'expire', modifiers: ['abstract'], optional: false, params: ['id', 'opts', 'ctx'] },
          ],
        },
      });
    });

    it('PasswordViolation lists its codes in order', () => {
      expect(unionLiterals('password.ts', 'PasswordViolation')).to.deep.eq(['too_short', 'too_long', 'rule', 'blocklisted']);
    });

    it('docs carry the rules a reader needs', () => {
      const c = classMembers('password.ts').PasswordService;
      expect(c.doc).to.contain('never trimmed');
      expect(c.doc).to.contain('A04');
      const change = docOf(c.members, 'change');
      for (const s of ['PATCH /user/password', 'Checks the policy, then counts the attempt', 'fresh auth', "'reauth' throttle", 'A13', 'SR-20', 'must be an active session of `id`', 'fails closed', 'incl. those where it is the impersonator', 'keeps every API and agent token', 'A30', 'H32']) expect(change).to.contain(s);
      const request = docOf(c.members, 'requestReset');
      for (const s of ['POST /auth/password/reset-request', "Counts the attempt in the 'reset' flow (IP and account keys) before anything else", 'same result whether or not the account exists', 'A11', 'SR-04', "'reset' flow", 'Returns no secret', 'SR-09']) expect(request).to.contain(s);
      const redeem = docOf(c.members, 'redeemReset');
      for (const s of ['POST /auth/password/reset', "Counts the attempt against the 'reset' flow's IP key only", 'then checks the policy, then the secret', 'Single use', "'invite' while the identity has a pending invite", 'A32', 'authn.local.reset.revokeTokens', 'does not use up the secret', 'same time for an unknown login']) expect(redeem).to.contain(s);
      expect(docOf(c.members, 'invite')).to.contain('SR-09');
      expect(docOf(c.members, 'policy')).to.contain('GET /auth/password/policy');
      expect(docOf(c.members, 'check')).to.contain('A04');
      expect(docOf(c.members, 'set')).to.contain('A04');
      expect(docOf(c.members, 'set')).to.contain('A30');
      expect(docOf(c.members, 'expire')).to.contain('unusable');
      const cause = memberDocs('password.ts', 'PasswordExpiry').cause;
      for (const s of ['/authn/admin/users/:uuid/password-reset', 'expire password', 'A25', 'authn.local.reset.revokeTokens', 'never receives a secret', 'target guard']) expect(cause).to.contain(s);
      for (const s of ['authn.local.expiration', 'revokes every session', 'keeps every API and agent token (H32)']) expect(cause).to.contain(s);
      expect(memberDocs('password.ts', 'PasswordExpiry').sendReset).to.contain('reset link');
      const docs = declarationDocs('password.ts');
      expect(docs.PasswordRefusal).to.contain('A02');
      expect(docs.PasswordRefusal).to.contain('audit only');
      expect(docs.PasswordViolation).to.contain('says nothing about the account');
      expect(memberDocs('password.ts', 'PasswordChangeResult').session).to.contain('rotated');
    });
  });

  describe('types', () => {
    it('re-exports the password types from the contracts index', () => {
      same<index.PasswordService, PasswordService>(true);
      same<index.PasswordPolicy, PasswordPolicy>(true);
      same<index.PasswordViolation, PasswordViolation>(true);
      same<index.PasswordRefusal, PasswordRefusal>(true);
      same<index.PasswordChangeResult, PasswordChangeResult>(true);
      same<index.PasswordResetRequestResult, PasswordResetRequestResult>(true);
      same<index.PasswordResetResult, PasswordResetResult>(true);
      same<index.PasswordSetResult, PasswordSetResult>(true);
      same<index.PasswordExpiry, PasswordExpiry>(true);
    });

    it('policy and violations have the planned shapes', () => {
      same<PasswordPolicy, { readonly minLength: number; readonly maxLength: number; readonly pattern?: string; readonly description?: string }>(true);
      same<PasswordViolation, 'too_short' | 'too_long' | 'rule' | 'blocklisted'>(true);
      same<PasswordRefusal, Refusal>(true);
      same<PasswordChangeResult, { readonly status: 'changed'; readonly session: SessionHandle } | Refusal>(true);
      same<PasswordResetRequestResult, { readonly status: 'accepted' } | { readonly status: 'throttled'; readonly retryAfterSeconds: number }>(true);
      same<PasswordResetResult, { readonly status: 'reset'; readonly purpose: 'reset' | 'invite' } | Refusal>(true);
      same<PasswordSetResult, { readonly status: 'set' } | { readonly status: 'rejected'; readonly violations: readonly PasswordViolation[] }>(true);
      same<PasswordExpiry, { readonly cause: 'admin'; readonly actor: PrincipalRef; readonly sendReset?: boolean } | { readonly cause: 'aged' }>(true);
    });

    it('members have the planned types', () => {
      type Actor = { readonly actor?: PrincipalRef };
      same<Parameters<PasswordService['change']>, [IdentityRef, string, string, SessionHandle, AuthnContext]>(true);
      same<ReturnType<PasswordService['change']>, Promise<PasswordChangeResult>>(true);
      same<Parameters<PasswordService['requestReset']>, [string, AuthnContext]>(true);
      same<ReturnType<PasswordService['requestReset']>, Promise<PasswordResetRequestResult>>(true);
      same<Parameters<PasswordService['redeemReset']>, [string, string, string, AuthnContext]>(true);
      same<ReturnType<PasswordService['redeemReset']>, Promise<PasswordResetResult>>(true);
      same<Parameters<PasswordService['invite']>, [IdentityRef, AuthnContext, Actor?]>(true);
      same<ReturnType<PasswordService['invite']>, Promise<void>>(true);
      same<Parameters<PasswordService['policy']>, []>(true);
      same<ReturnType<PasswordService['policy']>, PasswordPolicy>(true);
      same<Parameters<PasswordService['check']>, [string]>(true);
      same<ReturnType<PasswordService['check']>, Promise<readonly PasswordViolation[]>>(true);
      same<Parameters<PasswordService['set']>, [IdentityRef, string, AuthnContext, Actor?]>(true);
      same<ReturnType<PasswordService['set']>, Promise<PasswordSetResult>>(true);
      same<Parameters<PasswordService['expire']>, [IdentityRef, PasswordExpiry, AuthnContext]>(true);
      same<ReturnType<PasswordService['expire']>, Promise<void>>(true);
    });

    it('results narrow on status and carry no reason or secret', async () => {
      const p: PasswordService = new MemoryPasswords();
      const r = await p.redeemReset('alice', 'x', 'brand new pass', ctx);
      // @ts-expect-error violations exist only on a rejection
      const early = r.violations;
      const out = r.status === 'reset' ? r.purpose : r.status === 'throttled' ? r.retryAfterSeconds : r.status === 'rejected' ? r.violations : r.status;
      expect(out).to.eq('invalid');
      if (r.status === 'invalid') {
        // @ts-expect-error an invalid answer has no reason a route could leak (A02)
        void r.reason;
      }
      const q = await p.requestReset('alice', ctx);
      if (q.status === 'accepted') {
        // @ts-expect-error the request returns no secret (SR-09)
        void q.secret;
      }
      void early;
    });

    it('wrong shapes do not compile', () => {
      // @ts-expect-error abstract
      const a = () => new PasswordService();
      const p: PasswordService = new MemoryPasswords();
      // @ts-expect-error change needs the caller's session, which it rotates
      const b = () => p.change(alice, 'old', 'new password', ctx);
      // @ts-expect-error requestReset takes the login string, not an identity
      const c = () => p.requestReset(alice, ctx);
      // @ts-expect-error minLength and maxLength are always known (A04)
      const d: PasswordPolicy = { pattern: '.*' };
      // @ts-expect-error no other violation codes
      const e: PasswordViolation = 'too_common';
      // @ts-expect-error a throttled refusal carries retryAfterSeconds
      const f: PasswordRefusal = { status: 'throttled' };
      // @ts-expect-error a successful change returns the rotated session
      const g: PasswordChangeResult = { status: 'changed' };
      // @ts-expect-error an admin reset names its actor (A21)
      const h: PasswordExpiry = { cause: 'admin' };
      // @ts-expect-error an aged expiry takes no admin options
      const i: PasswordExpiry = { cause: 'aged', actor: admin };
      // @ts-expect-error the cause is required
      const j = () => p.expire(alice, {}, ctx);
      expect([a, b, c, d, e, f, g, h, i, j]).to.have.length(10);
    });

    it('policy is synchronous and check is not', () => {
      class AsyncPolicy extends MemoryPasswords {
        // @ts-expect-error policy() answers from config, synchronously
        async policy(): Promise<PasswordPolicy> {
          return { minLength: 8, maxLength: 128 };
        }
      }
      class SyncCheck extends MemoryPasswords {
        // @ts-expect-error check() may consult a remote blocklist, so it is async
        check(): readonly PasswordViolation[] {
          return [];
        }
      }
      expect([AsyncPolicy, SyncCheck]).to.have.length(2);
    });
  });
});
