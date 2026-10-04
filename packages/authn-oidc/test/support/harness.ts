import type { Credentials, ExternalSubject, Principal, SessionHandle } from '@spinajs/authn/contracts';
import { FakeStrategy, MemoryPasswordCredentialStore, UnsupportedConfig, fakeSeedPort } from '@spinajs/authn-testing';
import type { ConfigOverrides, Harness, HarnessContext, HttpRequest, HttpResponse, IdTokenTamper, ProbeBody } from '@spinajs/authn-testing';
import { EnrolledMfaPolicy, FakeAuthnService, FakeBackoffThrottle, FakeIdentityStore, MemoryLinkStore, MemorySessionIssuer, RecordingEventSink, RecordingPrincipalFactory, throttleParams } from '@spinajs/authn-testing';
import { MemoryNonceStore } from '@spinajs/authn-orm';

import { readOidcOptions } from '../../src/config/options.js';
import { OidcProvider } from '../../src/provider.js';
import { OidcStrategy } from '../../src/strategy.js';
import { OIDC_FAILURE_BODY, OidcLogin } from '../../src/login.js';
import type { OidcAnswer } from '../../src/login.js';
import { encodeFlow } from '../../src/flow/cookie.js';
import type { FlowCookie } from '../../src/flow/cookie.js';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeIdp } from './fake-idp.js';
import type { FakeLogin } from './fake-idp.js';

export const KIT_PROVIDER = 'kit';
export const KIT_STRATEGY = 'oidc:kit';
const ORIGIN = 'https://app.example.test';
const ENV = 'test';
const SESSION_COOKIE = 'ssid';
const PROBE = '/__authn-oidc-probe';
const SUPPORTED = ['authn.linking.jit', 'authn.linking.byVerifiedEmail'];

function leafKeys(o: unknown, prefix = ''): string[] {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return [prefix];
  return Object.entries(o).flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k));
}

function cookieLine(c: FlowCookie): string {
  const o = c.Options as { maxAge?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string; path?: string };
  return [`${c.Name}=${c.Value}`, `Path=${o.path ?? '/'}`, ...(o.maxAge !== undefined ? [`Max-Age=${Math.floor(o.maxAge / 1000)}`] : []), ...(o.httpOnly ? ['HttpOnly'] : []), ...(o.secure ? ['Secure'] : []), ...(o.sameSite ? [`SameSite=${o.sameSite}`] : [])].join('; ');
}

const loginOf = (subject: ExternalSubject, tamper?: IdTokenTamper): FakeLogin => ({
  claims: { sub: subject.subject, ...(subject.email !== undefined ? { email: subject.email, email_verified: subject.emailVerified === true } : {}) },
  ...(tamper ? { tamper } : {}),
});

/**
 * N10's behaviour harness: one provider 'kit' over the fake IdP, the kit's FakeAuthnService (N1 not merged), and a
 * minimal in-memory HTTP layer standing in for authn-http (N8a not merged): the OIDC routes over OidcLogin, a password
 * login route and the probe. Both linking switches of the provider follow the global ones, so a case that turns the
 * global switch on gets the documented both-switches setup.
 */
export async function oidcHarness(ctx: HarnessContext): Promise<Harness> {
  const config: ConfigOverrides = ctx.config ?? {};
  const unsupported = leafKeys(config).filter((k) => k !== '' && !SUPPORTED.includes(k) && !k.startsWith('authn.throttle.'));
  if (unsupported.length > 0) throw new UnsupportedConfig(unsupported);
  const linking = { jit: config.authn?.linking?.jit ?? false, byVerifiedEmail: config.authn?.linking?.byVerifiedEmail ?? false };

  const idp = await FakeIdp.create();
  const options = readOidcOptions({ providers: { [KIT_PROVIDER]: { issuer: idp.issuer, clientId: FAKE_CLIENT_ID, clientSecret: { secret: FAKE_CLIENT_SECRET }, linking } } }, ENV).providers.get(KIT_PROVIDER)!;
  const provider = new OidcProvider(options, idp, new MemoryNonceStore(), true);
  const identities = new FakeIdentityStore({ jit: linking.jit });
  const passwords = new MemoryPasswordCredentialStore();
  const links = new MemoryLinkStore();
  const strategy = new OidcStrategy({ provider, links, identities });
  const sessions = new MemorySessionIssuer();
  const events = new RecordingEventSink();
  const principals = new RecordingPrincipalFactory();
  const service = new FakeAuthnService({
    strategies: [FakeStrategy.password({ identities, passwords }), strategy],
    throttle: new FakeBackoffThrottle(throttleParams(config)),
    identities,
    links,
    linking,
    policy: new EnrolledMfaPolicy([]),
    steps: [],
    sessions,
    sinks: [events],
    principals,
  });
  const login = new OidcLogin({
    strategies: new Map([[KIT_PROVIDER, strategy]]),
    service,
    sessions,
    hooks: () => [],
    redirects: { success: '/', failure: '/' },
    env: ENV,
    sessionCookie: (h: SessionHandle) => ({ Name: SESSION_COOKIE, Value: h.id, Options: { httpOnly: true, sameSite: 'strict', path: '/' } }),
    callbackPath: (p) => `/auth/oidc/${p}/callback`,
  });

  let hits = 0;
  const answer = (a: OidcAnswer): HttpResponse => ({
    status: a.status,
    headers: { ...(a.location ? { location: a.location } : {}), ...(a.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    setCookie: a.cookies.map(cookieLine),
    body: a.body,
  });
  const json = (status: number, body: unknown, setCookie: string[] = []): HttpResponse => ({ status, headers: { 'content-type': 'application/json' }, setCookie, body });

  async function principalOf(raw: string | undefined): Promise<ProbeBody['principal']> {
    const restored = raw ? await sessions.restore(raw) : null;
    if (!restored || restored.handle.state !== 'active') return null;
    const f = restored.facts;
    return { type: restored.identity.type, id: restored.identity.id, authn: { method: f.method, strategy: f.strategy, assurance: f.assurance, mfa: [...f.mfa], authenticatedAt: f.authenticatedAt.toISOString(), ...(f.sessionHandle ? { sessionHandle: f.sessionHandle } : {}) } };
  }

  async function send(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.path, ORIGIN);
    const cookies = req.cookies ?? {};
    const query = Object.fromEntries([...new Set(url.searchParams.keys())].map((k) => {
      const all = url.searchParams.getAll(k);
      return [k, all.length === 1 ? all[0] : all];
    }));
    const restored = cookies[SESSION_COOKIE] ? await sessions.restore(cookies[SESSION_COOKIE]) : null;
    const oidcReq = { origin: ORIGIN, cookies, query, navigation: false, ctx: { now: new Date(), purpose: 'login' as const, ip: '192.0.2.10' }, session: restored?.handle ?? null };
    const route = /^\/auth\/oidc\/([^/]+)(\/callback)?$/.exec(url.pathname);
    if (req.method === 'GET' && route) {
      return answer(route[2] ? await login.callback(route[1], oidcReq) : await login.begin(route[1], oidcReq));
    }
    if (req.method === 'POST' && url.pathname === '/auth/login') {
      const body = (req.body ?? {}) as { login?: unknown; password?: unknown };
      const c: Credentials = { kind: 'password', login: String(body.login ?? ''), password: String(body.password ?? '') };
      const r = await service.authenticate(c, { now: new Date(), purpose: 'login', ip: '192.0.2.10' });
      if (r.status !== 'success' || !r.session) return json(401, OIDC_FAILURE_BODY);
      return json(200, { ok: true }, [`${SESSION_COOKIE}=${r.session.id}; Path=/; HttpOnly; SameSite=Strict`]);
    }
    if (url.pathname === PROBE) {
      hits += 1;
      const body: ProbeBody = { principal: await principalOf(cookies[SESSION_COOKIE]), clientIp: null, hits };
      return json(200, body);
    }
    return json(404, { error: { code: 'E_NOT_FOUND' } });
  }

  async function credentialsFor(subject: ExternalSubject, tamper?: IdTokenTamper): Promise<Credentials> {
    const { flow, location } = await provider.begin({ redirectUri: `${ORIGIN}/auth/oidc/${KIT_PROVIDER}/callback`, mode: 'login', now: new Date() });
    return { kind: 'external', provider: KIT_STRATEGY, payload: { flow: encodeFlow(flow), query: idp.authorize(location, loginOf(subject, tamper)) } };
  }

  return {
    service,
    events,
    links,
    seed: fakeSeedPort(identities, passwords),
    external: { provider: KIT_STRATEGY, credentialsFor: (s) => credentialsFor(s) },
    oidc: {
      provider: KIT_PROVIDER,
      linkProvider: KIT_STRATEGY,
      authorize: async (location, subject, tamper) => idp.authorize(location, loginOf(subject, tamper)),
    },
    http: {
      send,
      origin: ORIGIN,
      sessionCookie: SESSION_COOKIE,
      socketAddress: '192.0.2.10',
      probePath: PROBE,
      routes: { login: (l, p) => ({ method: 'POST', path: '/auth/login', body: { login: l, password: p } }) },
    },
  };
}

export type { Principal };
