import * as chai from 'chai';
import 'mocha';

import * as credentialsModule from '../../src/contracts/credentials.js';
import * as sessionModule from '../../src/contracts/session.js';
import type { AuthenticationResult, AuthnContext, AuthnFailure, Credentials, ExternalSubject, IdentityRef, SignedRequest, StrategyOutcome } from '../../src/contracts/credentials.js';
import type { SessionHandle } from '../../src/contracts/session.js';
import type { AuthnFacts, Ceiling } from '../../src/contracts/principal.js';
import type * as index from '../../src/contracts/index.js';
import { memberDocs } from './source-shape.js';

const expect = chai.expect;

// Strict identity: readonly, optionality and union members must all match.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(ok: Equals<A, B>): Equals<A, B> => ok;

type Delegation = { readonly onBehalfOf: IdentityRef; readonly mode: 'inherit' | 'intersect' };
type Attributes = Readonly<Record<string, unknown>>;

const session: SessionHandle = { id: 'raw', state: 'active' };
const pending: SessionHandle = { id: 'raw-pending', state: 'pending' };
const facts: Omit<AuthnFacts, 'authenticatedAt'> = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [] };
const user: IdentityRef = { type: 'user', id: 'u1' };

describe('credential, context and result contracts', () => {
  it('has no runtime exports besides SessionIssuer', () => {
    expect(Object.keys(credentialsModule)).to.deep.eq([]);
    expect(Object.keys(sessionModule)).to.deep.eq(['SessionIssuer']);
  });

  it('re-exports every type from the contracts index', () => {
    same<index.Credentials, Credentials>(true);
    same<index.SignedRequest, SignedRequest>(true);
    same<index.AuthnContext, AuthnContext>(true);
    same<index.IdentityRef, IdentityRef>(true);
    same<index.ExternalSubject, ExternalSubject>(true);
    same<index.AuthenticationResult, AuthenticationResult>(true);
    same<index.AuthnFailure, AuthnFailure>(true);
    same<index.StrategyOutcome, StrategyOutcome>(true);
    same<index.SessionHandle, SessionHandle>(true);
  });

  describe('Credentials', () => {
    it('is exactly the design union, open last member included', () => {
      same<Credentials, { readonly kind: 'password'; readonly login: string; readonly password: string } | { readonly kind: 'bearer'; readonly token: string } | { readonly kind: 'jws-assertion'; readonly jws: string } | { readonly kind: 'http-signature'; readonly request: SignedRequest } | { readonly kind: 'key-challenge'; readonly keyId: string; readonly challengeId: string; readonly signature: string } | { readonly kind: 'external'; readonly provider: string; readonly payload: Readonly<Record<string, unknown>> } | { readonly kind: string; readonly [k: string]: unknown }>(true);
    });

    it('accepts each known kind and an app-defined kind', () => {
      const all: Credentials[] = [
        { kind: 'password', login: 'a@b.c', password: 'secret' },
        { kind: 'bearer', token: 'spt_x' },
        { kind: 'jws-assertion', jws: 'a.b.c' },
        { kind: 'http-signature', request: { method: 'POST', targetUri: 'https://x/y', headers: { date: 'now' }, body: new Uint8Array([1]) } },
        { kind: 'key-challenge', keyId: 'k', challengeId: 'c', signature: 's' },
        { kind: 'external', provider: 'google', payload: { code: 'x' } },
        { kind: 'magic-link', anything: 1 },
      ];
      expect(all.map((c) => c.kind)).to.deep.eq(['password', 'bearer', 'jws-assertion', 'http-signature', 'key-challenge', 'external', 'magic-link']);
    });

    it('requires login and password on a password credential', () => {
      type Password = Extract<Credentials, { kind: 'password' }>;
      same<Password, { readonly kind: 'password'; readonly login: string; readonly password: string }>(true);
      // @ts-expect-error login is required
      const noLogin: Password = { kind: 'password', password: 'secret' };
      // @ts-expect-error password is required
      const noPassword: Password = { kind: 'password', login: 'a@b.c' };
      // @ts-expect-error password must be a string
      const numeric: Password = { kind: 'password', login: 'a@b.c', password: 1 };
      expect([noLogin, noPassword, numeric]).to.have.length(3);
    });

    // The open member keeps app-defined kinds compiling, so strategies need a runtime guard.
    it('does not narrow by kind alone', () => {
      const login = (c: Credentials) => (c.kind === 'password' ? c.login : undefined);
      same<ReturnType<typeof login>, unknown>(true);
      expect(login({ kind: 'password', login: 'a@b.c', password: 'secret' })).to.eq('a@b.c');
    });
  });

  describe('SignedRequest', () => {
    it('has the design members', () => {
      same<SignedRequest, { readonly method: string; readonly targetUri: string; readonly headers: Readonly<Record<string, string>>; readonly body?: Uint8Array }>(true);
      // @ts-expect-error targetUri is required
      const noTarget: SignedRequest = { method: 'GET', headers: {} };
      // @ts-expect-error headers is required
      const noHeaders: SignedRequest = { method: 'GET', targetUri: '/' };
      // @ts-expect-error method is required
      const noMethod: SignedRequest = { targetUri: '/', headers: {} };
      expect([noTarget, noHeaders, noMethod]).to.have.length(3);
    });
  });

  describe('AuthnContext', () => {
    it('has the design members', () => {
      same<AuthnContext, { readonly ip?: string; readonly userAgent?: string; readonly now: Date; readonly session?: SessionHandle; readonly purpose: 'login' | 'request' | 'reauth' | 'link' }>(true);
      same<AuthnContext['purpose'], 'login' | 'request' | 'reauth' | 'link'>(true);
    });

    it('needs now and purpose only', () => {
      const min: AuthnContext = { now: new Date(0), purpose: 'login' };
      const full: AuthnContext = { now: new Date(0), purpose: 'reauth', ip: '10.0.0.1', userAgent: 'ua', session };
      // @ts-expect-error now is required
      const noNow: AuthnContext = { purpose: 'login' };
      // @ts-expect-error purpose is required
      const noPurpose: AuthnContext = { now: new Date(0) };
      // @ts-expect-error purpose is a closed union
      const badPurpose: AuthnContext = { now: new Date(0), purpose: 'mfa' };
      expect([min, full, noNow, noPurpose, badPurpose]).to.have.length(5);
    });
  });

  describe('IdentityRef and ExternalSubject', () => {
    it('IdentityRef has an open type union', () => {
      same<IdentityRef, { readonly type: 'user' | 'service' | (string & {}); readonly id: string }>(true);
      const app: IdentityRef = { type: 'robot', id: 'r1' };
      // @ts-expect-error id is required
      const noId: IdentityRef = { type: 'user' };
      expect([app, noId]).to.have.length(2);
    });

    it('ExternalSubject has the design members', () => {
      same<ExternalSubject, { readonly provider: string; readonly subject: string; readonly email?: string; readonly emailVerified?: boolean; readonly claims?: Readonly<Record<string, unknown>> }>(true);
      const min: ExternalSubject = { provider: 'google', subject: 's' };
      // @ts-expect-error subject is required
      const noSubject: ExternalSubject = { provider: 'google' };
      // @ts-expect-error provider is required
      const noProvider: ExternalSubject = { subject: 's' };
      expect([min, noSubject, noProvider]).to.have.length(3);
    });
  });

  describe('AuthnFailure', () => {
    it('is exactly the design union', () => {
      same<AuthnFailure, 'invalid_credentials' | 'throttled' | 'unsupported_credentials' | 'expired' | 'revoked' | 'not_linked'>(true);
      // @ts-expect-error not a failure reason
      const locked: AuthnFailure = 'locked';
      expect(locked).to.eq('locked');
    });
  });

  describe('AuthenticationResult', () => {
    it('is exactly the design union', () => {
      same<AuthenticationResult, { readonly status: 'success'; readonly identity: IdentityRef; readonly facts: Omit<AuthnFacts, 'authenticatedAt'>; readonly ceiling?: Ceiling; readonly delegation?: Delegation; readonly session?: SessionHandle; readonly attributes?: Attributes } | { readonly status: 'mfa_required'; readonly pending: SessionHandle; readonly steps: readonly string[] } | { readonly status: 'failure'; readonly reason: AuthnFailure; readonly retryAfterSeconds?: number }>(true);
    });

    it('a throttled failure carries retryAfterSeconds, and success carries attributes (review I1, I3)', () => {
      const throttled: AuthenticationResult = { status: 'failure', reason: 'throttled', retryAfterSeconds: 30 };
      const pinned: AuthenticationResult = { status: 'success', identity: user, facts, attributes: { profile: 'dev' } };
      // @ts-expect-error retryAfterSeconds is a number of seconds
      const late: AuthenticationResult = { status: 'failure', reason: 'throttled', retryAfterSeconds: new Date(0) };
      expect([throttled, pinned, late]).to.have.length(3);
      const docs = memberDocs('credentials.ts', 'AuthenticationResult');
      for (const s of ["Set only when reason is 'throttled'", 'Retry-After', 'A02', 'A06']) expect(docs.retryAfterSeconds).to.contain(s);
      expect(docs.attributes).to.contain('Principal.attributes');
    });

    it('rejects incomplete members', () => {
      // @ts-expect-error success needs facts
      const noFacts: AuthenticationResult = { status: 'success', identity: user };
      // @ts-expect-error success facts carry no authenticatedAt
      const withAt: AuthenticationResult = { status: 'success', identity: user, facts: { ...facts, authenticatedAt: new Date(0) } };
      // @ts-expect-error mfa_required needs steps
      const noSteps: AuthenticationResult = { status: 'mfa_required', pending };
      // @ts-expect-error failure needs a reason
      const noReason: AuthenticationResult = { status: 'failure' };
      // @ts-expect-error status is a closed union
      const badStatus: AuthenticationResult = { status: 'pending', reason: 'expired' };
      expect([noFacts, withAt, noSteps, noReason, badStatus]).to.have.length(5);
    });

    it('narrows by status', () => {
      const describeResult = (r: AuthenticationResult): string => {
        switch (r.status) {
          case 'success':
            return `${r.identity.id}:${r.facts.strategy}:${r.session?.state ?? '-'}:${r.delegation?.mode ?? '-'}:${r.ceiling?.roles?.join() ?? '-'}`;
          case 'mfa_required':
            return `${r.pending.state}:${r.steps.join()}`;
          case 'failure':
            return r.reason;
        }
      };
      const results: AuthenticationResult[] = [
        { status: 'success', identity: user, facts, session, ceiling: { roles: ['admin'] }, delegation: { onBehalfOf: user, mode: 'intersect' } },
        { status: 'success', identity: user, facts },
        { status: 'mfa_required', pending, steps: ['totp'] },
        { status: 'failure', reason: 'throttled' },
      ];
      expect(results.map(describeResult)).to.deep.eq(['u1:local:active:intersect:admin', 'u1:local:-:-:-', 'pending:totp', 'throttled']);
    });
  });

  describe('StrategyOutcome', () => {
    it('is exactly the design union', () => {
      same<StrategyOutcome, { readonly ok: true; readonly identity?: IdentityRef; readonly external?: ExternalSubject; readonly method: string; readonly ceiling?: Ceiling; readonly delegation?: Delegation; readonly attributes?: Attributes } | { readonly ok: false; readonly reason: AuthnFailure }>(true);
    });

    it('attributes add to the principal, never authority (review I3)', () => {
      const pinned: StrategyOutcome = { ok: true, method: 'token', identity: user, attributes: { profile: 'dev' } };
      expect(pinned.ok && pinned.attributes).to.deep.eq({ profile: 'dev' });
      for (const s of ['Merged into Principal.attributes', 'never authority', 'attributes.profile', '§18.3(e)']) expect(memberDocs('credentials.ts', 'StrategyOutcome').attributes).to.contain(s);
    });

    it('rejects incomplete members', () => {
      // @ts-expect-error success needs a method
      const noMethod: StrategyOutcome = { ok: true, identity: user };
      // @ts-expect-error failure needs a reason
      const noReason: StrategyOutcome = { ok: false };
      // @ts-expect-error delegation mode is a closed union
      const badMode: StrategyOutcome = { ok: true, method: 'token', identity: user, delegation: { onBehalfOf: user, mode: 'union' } };
      expect([noMethod, noReason, badMode]).to.have.length(3);
    });

    it('narrows by ok', () => {
      const subjectOf = (o: StrategyOutcome): string => (o.ok ? o.identity?.id ?? o.external?.subject ?? '?' : o.reason);
      expect(subjectOf({ ok: true, method: 'password', identity: user })).to.eq('u1');
      expect(subjectOf({ ok: true, method: 'oidc', external: { provider: 'google', subject: 'g1' } })).to.eq('g1');
      expect(subjectOf({ ok: false, reason: 'invalid_credentials' })).to.eq('invalid_credentials');
    });
  });

  describe('SessionHandle', () => {
    it('has a raw id and a pending or active state', () => {
      same<SessionHandle, { readonly id: string; readonly state: 'pending' | 'active' }>(true);
      same<SessionHandle['state'], 'pending' | 'active'>(true);
      // @ts-expect-error state is only pending or active
      const revoked: SessionHandle = { id: 'x', state: 'revoked' };
      // @ts-expect-error id is required
      const noId: SessionHandle = { state: 'active' };
      expect([revoked, noId]).to.have.length(2);
    });
  });
});
