import { MemoryNonceStore } from '@spinajs/authn-orm';
import { ExternalLoginHook } from '@spinajs/authn/contracts';
import type { AuthnContext, ExternalSubject, IdentityRef, SessionHandle } from '@spinajs/authn/contracts';
import { EnrolledMfaPolicy, FakeAuthnService, FakeBackoffThrottle, FakeIdentityStore, MemoryLinkStore, MemorySessionIssuer, RecordingEventSink, RecordingPrincipalFactory, throttleParams } from '@spinajs/authn-testing';

import { readOidcOptions } from '../../src/config/options.js';
import { OidcProvider } from '../../src/provider.js';
import { OidcStrategy } from '../../src/strategy.js';
import { OidcLogin } from '../../src/login.js';
import type { OidcAnswer, OidcRequest } from '../../src/login.js';
import { flowCookieName } from '../../src/flow/cookie.js';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeIdp } from './fake-idp.js';
import type { FakeLogin } from './fake-idp.js';

export const ORIGIN = 'https://app.example.test';
export const ENV = 'production';
export const SESSION_COOKIE = 'ssid';

export class RecordingHook extends ExternalLoginHook {
  public readonly calls: [IdentityRef, ExternalSubject][] = [];
  public fail = false;
  async afterLogin(identity: IdentityRef, external: ExternalSubject): Promise<void> {
    this.calls.push([identity, external]);
    if (this.fail) throw new Error('hook failed');
  }
}

export interface WorldOptions {
  readonly provider?: Record<string, unknown>;
  readonly linking?: { jit: boolean; byVerifiedEmail: boolean };
  readonly idp?: FakeIdp;
  readonly name?: string;
}

/** One provider over a fake IdP, with the kit's fake AuthnService, stores and a recording hook. */
export async function world(o: WorldOptions = {}) {
  const idp = o.idp ?? (await FakeIdp.create());
  const name = o.name ?? 'corp';
  const options = readOidcOptions({ providers: { [name]: { issuer: idp.issuer, clientId: FAKE_CLIENT_ID, clientSecret: { secret: FAKE_CLIENT_SECRET }, ...o.provider } } }, ENV).providers.get(name)!;
  const nonces = new MemoryNonceStore();
  const provider = new OidcProvider(options, idp, nonces, false);
  const linking = o.linking ?? { jit: false, byVerifiedEmail: false };
  const identities = new FakeIdentityStore({ jit: linking.jit });
  const links = new MemoryLinkStore();
  const strategy = new OidcStrategy({ provider, links, identities });
  const sessions = new MemorySessionIssuer();
  const events = new RecordingEventSink();
  const service = new FakeAuthnService({
    strategies: [strategy],
    throttle: new FakeBackoffThrottle(throttleParams({})),
    identities,
    links,
    linking,
    policy: new EnrolledMfaPolicy([]),
    steps: [],
    sessions,
    sinks: [events],
    principals: new RecordingPrincipalFactory(),
  });
  const hook = new RecordingHook();
  const login = new OidcLogin({
    strategies: new Map([[name, strategy]]),
    service,
    sessions,
    hooks: () => [hook],
    redirects: { success: '/home', failure: '/login' },
    env: ENV,
    sessionCookie: (h: SessionHandle) => ({ Name: SESSION_COOKIE, Value: h.id, Options: { httpOnly: true } }),
    callbackPath: (p) => `/auth/oidc/${p}/callback`,
  });
  const ctx = (): AuthnContext => ({ now: new Date(), purpose: 'login', ip: '192.0.2.10' });
  const request = (query: Record<string, unknown> = {}, cookies: Record<string, string> = {}, navigation = false): OidcRequest => ({ origin: ORIGIN, cookies, query, navigation, ctx: ctx() });
  const flowOf = (a: OidcAnswer): string => a.cookies.find((c) => c.Name === flowCookieName(ENV))!.Value;

  /** begin, play the IdP, callback; returns both answers. */
  async function roundTrip(l: FakeLogin, opts: { withIss?: boolean; returnTo?: string; navigation?: boolean } = {}) {
    const begun = await login.begin(name, request(opts.returnTo ? { returnTo: opts.returnTo } : {}));
    const query = idp.authorize(begun.location!, l, { withIss: opts.withIss });
    const done = await login.callback(name, request(query, { [flowCookieName(ENV)]: flowOf(begun) }, opts.navigation));
    return { begun, query, done, flow: flowOf(begun) };
  }

  return { idp, name, options, nonces, provider, identities, links, strategy, sessions, events, service, hook, login, ctx, request, flowOf, roundTrip };
}
