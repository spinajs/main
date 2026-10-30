/** OpenID Connect RP-Initiated Logout 1.0 (FLOW-3): the end_session_endpoint URL of an OIDC session, over the fake IdP. */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { AuthnLogoutExtension } from '@spinajs/authn-http';
import type { Session } from '@spinajs/authn/contracts';
import type { Request } from '@spinajs/http';

import { OidcDiscovery } from '../src/discovery.js';
import { OIDC_ID_TOKEN_KEY, OidcLogoutExtension, OidcRpLogout } from '../src/logout-extension.js';
import { AUTHN_OIDC_CONFIGURATION_SCHEMA } from '../src/options/schema.js';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';
import { FAKE_CLIENT_ID, FAKE_ISSUER, FakeIdp } from './support/fake-idp.js';
import { ORIGIN, SESSION_COOKIE, world } from './support/world.js';
import type { WorldOptions } from './support/world.js';
import { configurationViolations, disposeTestApps, fakeContainer, readingFrom } from '@spinajs/testing';

const END = `${FAKE_ISSUER}/protocol/openid-connect/logout`;
const STRATEGY = 'oidc:corp';
const CLAIMS = { sub: 'kc-1', sid: 'idp-1' };

type World = Awaited<ReturnType<typeof world>>;

/** A provider whose discovery advertises `endpoint` (null: the member is left out). */
async function worldWith(endpoint: unknown = END, o: WorldOptions = {}): Promise<World> {
  const idp = o.idp ?? (await FakeIdp.create());
  if (endpoint === null) delete idp.discovery.end_session_endpoint;
  else idp.discovery.end_session_endpoint = endpoint;
  return world({ ...o, idp });
}

/** A real login through OidcLogin.callback; the session as the next request would restore it. */
async function loggedIn(w: World, claims: Record<string, unknown> = CLAIMS): Promise<Session> {
  const alice = w.identities.add({ login: 'alice' });
  await w.links.link(alice, { provider: STRATEGY, subject: String(claims.sub) });
  const { done } = await w.roundTrip({ claims });
  const id = done.cookies.find((c) => c.Name === SESSION_COOKIE)?.Value;
  expect(id, 'the callback issued a session').to.be.a('string');
  return (await w.sessions.restore(id!))!;
}

const rp = (w: World): OidcRpLogout => new OidcRpLogout(new Map([[w.name, w.strategy]]));
const payloadOf = (jwt: string): Record<string, unknown> => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;

describe('authn-oidc RP-initiated logout (FLOW-3)', () => {
  describe('discovery', () => {
    const metadata = async (endpoint: unknown, relaxed = false) => {
      const idp = await FakeIdp.create();
      if (endpoint !== undefined) idp.discovery.end_session_endpoint = endpoint;
      return new OidcDiscovery(FAKE_ISSUER, idp, relaxed).metadata();
    };

    it('reads end_session_endpoint', async () => {
      expect((await metadata(END)).end_session_endpoint).to.eq(END);
    });

    it('leaves it out when the provider advertises none', async () => {
      expect(await metadata(undefined)).to.not.have.property('end_session_endpoint');
    });

    it('ignores one that is not a usable URL, and the login discovery still succeeds', async () => {
      for (const bad of ['http://idp.example.test/logout', 'javascript:alert(1)', 'not a url', 42, null, `${END}#fragment`]) {
        const m = await metadata(bad);
        expect(m, JSON.stringify(bad)).to.not.have.property('end_session_endpoint');
        expect(m.token_endpoint).to.be.a('string');
      }
    });

    it('takes an http endpoint in development and test', async () => {
      expect((await metadata('http://idp.example.test/logout', true)).end_session_endpoint).to.eq('http://idp.example.test/logout');
    });
  });

  describe('the end_session_endpoint URL', () => {
    it('carries client_id, post_logout_redirect_uri on the request origin and the sid as logout_hint, and no id_token_hint by default', async () => {
      const w = await worldWith();
      const url = await rp(w).endSessionUrl(await loggedIn(w), ORIGIN);
      const u = new URL(url!);
      expect(`${u.origin}${u.pathname}`).to.eq(END);
      expect(u.searchParams.get('client_id')).to.eq(FAKE_CLIENT_ID);
      expect(u.searchParams.get('post_logout_redirect_uri')).to.eq(`${ORIGIN}/`);
      expect(u.searchParams.get('logout_hint')).to.eq('idp-1');
      expect(u.searchParams.has('id_token_hint')).to.eq(false);
    });

    it('keeps the query the endpoint already has', async () => {
      const w = await worldWith(`${END}?tenant=corp`);
      const u = new URL((await rp(w).endSessionUrl(await loggedIn(w), ORIGIN))!);
      expect(u.searchParams.get('tenant')).to.eq('corp');
      expect(u.searchParams.get('client_id')).to.eq(FAKE_CLIENT_ID);
    });

    it('sends logout.postLogoutRedirectUri when it is configured', async () => {
      const w = await worldWith(END, { provider: { logout: { postLogoutRedirectUri: 'https://app.example.test/signed-out' } } });
      const u = new URL((await rp(w).endSessionUrl(await loggedIn(w), ORIGIN))!);
      expect(u.searchParams.get('post_logout_redirect_uri')).to.eq('https://app.example.test/signed-out');
    });

    it('takes the default post_logout_redirect_uri from the origin of the provider redirectUri, never from the request', async () => {
      const w = await worldWith(END, { provider: { redirectUri: 'https://login.example.test/auth/oidc/corp/callback' } });
      const session = await loggedIn(w);
      for (const origin of [ORIGIN, 'https://evil.example', undefined]) {
        const u = new URL((await rp(w).endSessionUrl(session, origin))!);
        expect(u.searchParams.get('post_logout_redirect_uri'), String(origin)).to.eq('https://login.example.test/');
      }
    });

    it('a configured logout.postLogoutRedirectUri still wins over the redirectUri origin', async () => {
      const w = await worldWith(END, { provider: { redirectUri: 'https://login.example.test/cb', logout: { postLogoutRedirectUri: 'https://app.example.test/signed-out' } } });
      const u = new URL((await rp(w).endSessionUrl(await loggedIn(w), ORIGIN))!);
      expect(u.searchParams.get('post_logout_redirect_uri')).to.eq('https://app.example.test/signed-out');
    });

    it('leaves out logout_hint for a login whose ID token had no sid', async () => {
      const w = await worldWith();
      const u = new URL((await rp(w).endSessionUrl(await loggedIn(w, { sub: 'kc-1' }), ORIGIN))!);
      expect(u.searchParams.has('logout_hint')).to.eq(false);
      expect(u.searchParams.get('client_id')).to.eq(FAKE_CLIENT_ID);
    });

    it('does not keep the ID token without logout.storeIdToken', async () => {
      const w = await worldWith();
      const session = await loggedIn(w);
      expect(session.has(OIDC_ID_TOKEN_KEY)).to.eq(false);
      expect([...session.data.values()].some((v) => typeof v === 'string' && v.split('.').length === 3)).to.eq(false);
    });

    it('with logout.storeIdToken keeps the validated ID token in the session and sends it as id_token_hint', async () => {
      const w = await worldWith(END, { provider: { logout: { storeIdToken: true } } });
      const session = await loggedIn(w);
      const token = session.get(OIDC_ID_TOKEN_KEY);
      expect(token).to.be.a('string');
      expect(payloadOf(token!)).to.deep.include({ sub: 'kc-1', sid: 'idp-1', iss: FAKE_ISSUER, aud: FAKE_CLIENT_ID });
      const u = new URL((await rp(w).endSessionUrl(session, ORIGIN))!);
      expect(u.searchParams.get('id_token_hint')).to.eq(token);
    });

    it('stores no ID token when the login failed', async () => {
      const w = await worldWith(END, { provider: { logout: { storeIdToken: true } } });
      const { done } = await w.roundTrip({ claims: CLAIMS, tamper: 'wrong-nonce' });
      expect(done.status).to.eq(401);
      expect(done.cookies.find((c) => c.Name === SESSION_COOKIE)).to.eq(undefined);
    });

    it('answers nothing for a provider without an end_session_endpoint', async () => {
      const w = await worldWith(null);
      expect(await rp(w).endSessionUrl(await loggedIn(w), ORIGIN)).to.eq(undefined);
    });

    it('answers nothing for a password session, an external login of another kind and a provider that is gone', async () => {
      const w = await worldWith();
      const alice = w.identities.add({ login: 'alice' });
      const facts = { method: 'password', strategy: 'local', assurance: 'aal1' as const, mfa: [], authenticatedAt: new Date() };
      const sessionOf = async (extra: object): Promise<Session> => (await w.sessions.restore((await w.sessions.issue(alice, { ...facts, ...extra })).id))!;
      expect(await rp(w).endSessionUrl(await sessionOf({}), ORIGIN), 'password').to.eq(undefined);
      expect(await rp(w).endSessionUrl(await sessionOf({ external: { provider: 'saml:corp', sid: 'x' } }), ORIGIN), 'another kind').to.eq(undefined);
      expect(await rp(w).endSessionUrl(await sessionOf({ external: { provider: 'oidc:gone', sid: 'x' } }), ORIGIN), 'unknown provider').to.eq(undefined);
    });
  });

  describe('OidcLogoutExtension', () => {
    const extensionFor = (w: World, trust: { own?: unknown; shared?: unknown; publicOrigin?: string } = {}): OidcLogoutExtension => {
      const ext = readingFrom(new OidcLogoutExtension(), fakeContainer({ 'authn.http.trustProxy': trust.own ?? null, 'http.trustProxy': trust.shared ?? null, 'authn.http.publicOrigin': trust.publicOrigin ?? null }));
      Object.defineProperty(ext, 'Providers', { value: { strategies: () => new Map([[w.name, w.strategy]]) } });
      return ext;
    };
    const requestOf = (headers: Record<string, string> = {}, peer = '203.0.113.9'): Request =>
      ({ get: (name: string) => ({ host: 'app.example.test', ...headers })[name.toLowerCase()], socket: { encrypted: true, remoteAddress: peer } }) as unknown as Request;

    it('is registered as an AuthnLogoutExtension', () => {
      expect((DI.getRegisteredTypes(AuthnLogoutExtension) ?? []).map((t) => t.name)).to.include('OidcLogoutExtension');
    });

    it('answers the redirect to the end_session_endpoint for an OIDC session', async () => {
      const w = await worldWith();
      const answer = await extensionFor(w).afterLogout(await loggedIn(w), requestOf());
      const u = new URL((answer as { redirect: string }).redirect);
      expect(`${u.origin}${u.pathname}`).to.eq(END);
      expect(u.searchParams.get('post_logout_redirect_uri')).to.eq(`${ORIGIN}/`);
    });

    it('takes the origin from forwarded headers only through a trusted proxy', async () => {
      const w = await worldWith();
      const session = await loggedIn(w);
      const forwarded = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'public.example.test' };
      const trusted = (await extensionFor(w, { shared: '203.0.113.0/24' }).afterLogout(session, requestOf(forwarded))) as { redirect: string };
      expect(new URL(trusted.redirect).searchParams.get('post_logout_redirect_uri')).to.eq('https://public.example.test/');
      const untrusted = (await extensionFor(w).afterLogout(session, requestOf(forwarded))) as { redirect: string };
      expect(new URL(untrusted.redirect).searchParams.get('post_logout_redirect_uri')).to.eq(`${ORIGIN}/`);
    });

    const postLogoutOf = (answer: unknown) => new URL((answer as { redirect: string }).redirect).searchParams.get('post_logout_redirect_uri');

    it('ends the provider session without a post_logout_redirect_uri when the request gives no valid origin', async () => {
      const w = await worldWith();
      const session = await loggedIn(w);
      for (const headers of [{ host: 'evil.example/x' }, { host: 'a@evil.example' }, { host: 'h'.repeat(2049) }, { host: '' }]) {
        const answer = await extensionFor(w).afterLogout(session, requestOf(headers));
        const u = new URL((answer as { redirect: string }).redirect);
        expect(`${u.origin}${u.pathname}`, headers.host.slice(0, 20)).to.eq(END);
        expect(u.searchParams.has('post_logout_redirect_uri'), headers.host.slice(0, 20)).to.eq(false);
      }
    });

    it('ignores a forged X-Forwarded-Host from an untrusted peer', async () => {
      const w = await worldWith();
      const answer = await extensionFor(w).afterLogout(await loggedIn(w), requestOf({ 'x-forwarded-host': 'evil.example' }));
      expect(postLogoutOf(answer)).to.eq(`${ORIGIN}/`);
    });

    it('takes the origin from authn.http.publicOrigin when set, whatever Host and X-Forwarded-Host say', async () => {
      const w = await worldWith();
      const session = await loggedIn(w);
      const ext = extensionFor(w, { shared: 1, publicOrigin: 'https://public.example.test' });
      const forged: Record<string, string>[] = [{}, { host: 'evil.example' }, { host: 'evil.example/x' }, { 'x-forwarded-host': 'evil.example' }];
      for (const headers of forged) {
        expect(postLogoutOf(await ext.afterLogout(session, requestOf(headers))), JSON.stringify(headers)).to.eq('https://public.example.test/');
      }
    });

    it('answers nothing for a session without an OIDC login', async () => {
      const w = await worldWith();
      const alice = w.identities.add({ login: 'alice' });
      const h = await w.sessions.issue(alice, { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() });
      expect(await extensionFor(w).afterLogout((await w.sessions.restore(h.id))!, requestOf())).to.eq(undefined);
    });

    it('answers nothing, and does not throw, when the provider cannot be reached', async () => {
      const w = await worldWith();
      const session = await loggedIn(w);
      (w.provider.discovery as unknown as { metadata(): Promise<never> }).metadata = async () => {
        throw new Error('discovery failed');
      };
      expect(await extensionFor(w).afterLogout(session, requestOf())).to.eq(undefined);
    });
  });

  describe('configuration', () => {
    afterEach(disposeTestApps);
    const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, AUTHN_OIDC_CONFIGURATION_SCHEMA];
    const provider = (logout: unknown) => ({ authn: { oidc: { providers: { corp: { issuer: FAKE_ISSUER, clientId: 'canvas', clientSecret: { secret: 'a-client-secret' }, logout } } } } });

    it('defaults logout.storeIdToken to false and takes no postLogoutRedirectUri', async () => {
      const w = await world();
      expect(w.options.logout).to.deep.eq({ storeIdToken: false, postLogoutRedirectUri: null });
    });

    it('accepts logout.storeIdToken and logout.postLogoutRedirectUri', async () => {
      expect(await configurationViolations({ schemas: SCHEMAS, config: provider({ storeIdToken: true, postLogoutRedirectUri: 'https://app.example.test/bye' }) })).to.deep.eq([]);
    });

    it('refuses an unknown logout member, a non-boolean storeIdToken and an empty postLogoutRedirectUri', async () => {
      for (const [logout, path] of [
        [{ typo: true }, 'logout.typo'],
        [{ storeIdToken: 'maybe' }, 'logout.storeIdToken'],
        [{ postLogoutRedirectUri: '' }, 'logout.postLogoutRedirectUri'],
      ] as const) {
        expect(await configurationViolations({ schemas: SCHEMAS, config: provider(logout) }), path).to.include(`authn.oidc.providers.corp.${path}`);
      }
    });

    it('refuses a postLogoutRedirectUri that is not an https URL outside development and test', async () => {
      let message = 'accepted';
      try {
        await world({ provider: { logout: { postLogoutRedirectUri: 'http://app.example.test/bye' } } });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).to.contain('authn.oidc.providers.corp.logout.postLogoutRedirectUri');
    });
  });
});
