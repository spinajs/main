import 'mocha';
import { expect } from 'chai';
import { MemoryNonceStore } from '@spinajs/authn-orm';

import { OIDC_FLOW_COOKIE_MAX_LENGTH, OIDC_FLOW_TTL_SECONDS, appPathOrNull, clearFlowCookie, codeChallengeOf, decodeFlow, encodeFlow, flowCookie, flowCookieName, flowIsLive, flowSecrets, newFlow, sha256hex, stateClaim } from '../src/flow/cookie.js';
import type { OidcFlow } from '../src/flow/cookie.js';
import { authorizationUrl } from '../src/flow/authorize.js';

const NOW = new Date('2026-10-04T10:00:00.000Z');
const REDIRECT = 'https://app.example.test/auth/oidc/corp/callback';
const login = (over: Partial<Parameters<typeof newFlow>[0]> = {}): OidcFlow => newFlow({ provider: 'corp', redirectUri: REDIRECT, returnTo: '/app', mode: 'login', now: NOW, ...over });
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

describe('authn-oidc flow', () => {
  describe('flow cookie', () => {
    it('round-trips a login flow and a link flow', () => {
      const f = login();
      expect(decodeFlow(encodeFlow(f))).to.deep.eq(f);
      const link = newFlow({ provider: 'corp', redirectUri: REDIRECT, mode: 'link', sessionHash: sha256hex('raw-session'), now: NOW });
      expect(decodeFlow(encodeFlow(link))).to.deep.eq(link);
      expect(link.r).to.eq(null);
    });

    it('holds a fresh 256-bit seed per flow and the issue time in seconds', () => {
      const a = login();
      const b = login();
      expect(a.s).to.match(/^[A-Za-z0-9_-]{43}$/);
      expect(a.s).to.not.eq(b.s);
      expect(a.t).to.eq(NOW.getTime() / 1000);
    });

    it('keeps a returnTo only as an app-relative path', () => {
      for (const bad of ['https://evil.example/', '//evil.example', '/\\evil.example', 'app', '/a b', `/${'x'.repeat(1024)}`, 42]) {
        expect(login({ returnTo: bad }).r, String(bad)).to.eq(null);
        expect(appPathOrNull(bad)).to.eq(null);
      }
      expect(login({ returnTo: '/app?tab=1' }).r).to.eq('/app?tab=1');
    });

    it('refuses malformed cookie values', () => {
      const f = login();
      const good = JSON.parse(Buffer.from(encodeFlow(f), 'base64url').toString('utf8')) as Record<string, unknown>;
      const bad: unknown[] = [
        undefined,
        '',
        'not base64!',
        'x'.repeat(OIDC_FLOW_COOKIE_MAX_LENGTH + 1),
        Buffer.from('not json').toString('base64url'),
        b64([good]),
        b64({ ...good, v: 2 }),
        b64({ ...good, p: '' }),
        b64({ ...good, s: 'short' }),
        b64({ ...good, t: 1.5 }),
        b64({ ...good, t: '1' }),
        b64({ ...good, r: 'https://evil.example/' }),
        b64({ ...good, u: '' }),
        b64({ ...good, u: 'javascript:alert(1)' }),
        b64({ ...good, p: 'Corp' }),
        b64({ ...good, r: '/caf\u00e9' }),
        b64({ ...good, m: 'implicit' }),
        b64({ ...good, x: 1 }),
        b64({ ...good, h: sha256hex('s') }),
        b64({ ...good, m: 'link' }),
        b64({ ...good, m: 'link', h: 'XYZ' }),
      ];
      for (const value of bad) {
        expect(decodeFlow(value), String(value)).to.eq(null);
      }
    });

    it('is HttpOnly, SameSite=Lax, Path=/, with __Host- and Secure outside development and test', () => {
      const f = login();
      const prod = flowCookie(f, 'production');
      expect(prod.Name).to.eq('__Host-spinajs-oidc');
      expect(prod.Value).to.eq(encodeFlow(f));
      expect(prod.Options).to.deep.include({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: OIDC_FLOW_TTL_SECONDS * 1000 });
      expect(prod.Options.domain).to.eq(undefined);
      expect(flowCookieName(undefined)).to.eq('__Host-spinajs-oidc');
      const test = flowCookie(f, 'test');
      expect(test.Name).to.eq('spinajs-oidc');
      expect(test.Options).to.deep.include({ httpOnly: true, secure: false, sameSite: 'lax' });
      expect(flowCookieName('development')).to.eq('spinajs-oidc');
      expect(clearFlowCookie('production')).to.deep.include({ Name: '__Host-spinajs-oidc', Value: '' });
      expect(clearFlowCookie('production').Options).to.deep.include({ maxAge: 0 });
    });
  });

  describe('derived secrets', () => {
    it('derives state, nonce and a 43-char PKCE verifier with its S256 challenge', () => {
      const s = flowSecrets(login());
      expect(s.codeVerifier).to.match(/^[A-Za-z0-9_-]{43}$/);
      expect(s.codeChallenge).to.eq(codeChallengeOf(s.codeVerifier));
      expect(new Set([s.state, s.nonce, s.codeVerifier, s.codeChallenge]).size).to.eq(4);
    });

    it('computes the S256 challenge as base64url(SHA-256(ASCII(verifier))) without padding', async () => {
      const verifier = flowSecrets(login()).codeVerifier;
      const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      expect(codeChallengeOf(verifier)).to.eq(Buffer.from(digest).toString('base64url'));
      expect(codeChallengeOf(verifier)).to.match(/^[A-Za-z0-9_-]{43}$/);
    });

    it('is stable for one flow, even after a round trip through the cookie', () => {
      const f = login();
      expect(flowSecrets(decodeFlow(encodeFlow(f))!)).to.deep.eq(flowSecrets(f));
    });

    it('binds the state to every member of the flow (provider: mix-up; browser: seed)', () => {
      const f = login();
      const base = flowSecrets(f).state;
      const changes: Partial<OidcFlow>[] = [{ p: 'other' }, { s: login().s }, { t: f.t + 1 }, { r: '/elsewhere' }, { r: null }, { u: 'https://evil.example/cb' }, { m: 'link', h: sha256hex('x') }];
      for (const c of changes) {
        expect(flowSecrets({ ...f, ...c } as OidcFlow).state, JSON.stringify(c)).to.not.eq(base);
      }
      const n = flowSecrets(f).nonce;
      expect(flowSecrets({ ...f, s: login().s }).nonce).to.not.eq(n);
    });
  });

  describe('lifetime and single use', () => {
    it('is live from its issue time for the TTL, and up to a minute early', () => {
      const f = login();
      expect(flowIsLive(f, NOW)).to.eq(true);
      expect(flowIsLive(f, new Date(NOW.getTime() + OIDC_FLOW_TTL_SECONDS * 1000 - 1))).to.eq(true);
      expect(flowIsLive(f, new Date(NOW.getTime() + OIDC_FLOW_TTL_SECONDS * 1000))).to.eq(false);
      expect(flowIsLive(f, new Date(NOW.getTime() - 60_000))).to.eq(true);
      expect(flowIsLive(f, new Date(NOW.getTime() - 61_000))).to.eq(false);
    });

    it('claims a state once in the nonce store until the flow expires', async () => {
      const f = login();
      const { key, expiresAt } = stateClaim(f, flowSecrets(f).state);
      expect(key).to.match(/^oidc-state:[0-9a-f]{64}$/);
      expect(key.length).to.be.at.most(160);
      expect(expiresAt.getTime()).to.eq(NOW.getTime() + OIDC_FLOW_TTL_SECONDS * 1000);
      const store = new MemoryNonceStore();
      expect(await store.claim(key, expiresAt, NOW)).to.eq(true);
      expect(await store.claim(key, expiresAt, new Date(NOW.getTime() + 1000))).to.eq(false);
    });
  });

  describe('authorization request', () => {
    const secrets = flowSecrets(login());
    const request = (over: Partial<Parameters<typeof authorizationUrl>[0]> = {}) =>
      new URL(authorizationUrl({ endpoint: 'https://idp.example.test/auth', clientId: 'canvas', redirectUri: REDIRECT, scopes: ['openid', 'email'], secrets, nonce: true, extra: {}, ...over }));

    it('asks for the code flow with PKCE S256, state and nonce', () => {
      const u = request();
      expect(Object.fromEntries(u.searchParams)).to.deep.eq({
        response_type: 'code',
        client_id: 'canvas',
        redirect_uri: REDIRECT,
        scope: 'openid email',
        state: secrets.state,
        nonce: secrets.nonce,
        code_challenge: secrets.codeChallenge,
        code_challenge_method: 'S256',
      });
      expect(u.origin + u.pathname).to.eq('https://idp.example.test/auth');
      expect(u.toString()).to.not.contain(secrets.codeVerifier);
    });

    it('adds the extra parameters, which never override the flow ones', () => {
      const extra = { prompt: 'select_account', hd: 'example.com', response_type: 'token', code_challenge_method: 'plain', response_mode: 'fragment', max_age: '0' } as never;
      const u = request({ extra });
      expect(u.searchParams.get('prompt')).to.eq('select_account');
      expect(u.searchParams.get('hd')).to.eq('example.com');
      expect(u.searchParams.get('response_type')).to.eq('code');
      expect(u.searchParams.get('code_challenge_method')).to.eq('S256');
      expect(u.searchParams.has('response_mode')).to.eq(false);
      expect(u.searchParams.has('max_age')).to.eq(false);
      const more = request({ extra: { request: 'jwt', request_uri: 'urn:x', acr_values: 'mfa' } as never });
      for (const k of ['request', 'request_uri', 'acr_values']) expect(more.searchParams.has(k), k).to.eq(false);
    });

    it('keeps the query of the endpoint and sends no nonce for plain OAuth2', () => {
      const u = request({ endpoint: 'https://idp.example.test/auth?tenant=x&nonce=evil', nonce: false });
      expect(u.searchParams.get('tenant')).to.eq('x');
      expect(u.searchParams.has('nonce')).to.eq(false);
    });
  });
});
