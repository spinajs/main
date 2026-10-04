/** The strategy under N1's real StrategyRegistry and DefaultAuthnService (merged after the lane started). */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { AuthenticationStrategy, AuthnEventSink, AuthnService, AuthnThrottle, DefaultAuthnService, IdentityLinkStore, IdentityStore, MemoryAuthnThrottle, MfaStep, PrincipalFactory, SessionIssuer, StrategyRegistry } from '@spinajs/authn';
import type { AuthenticationResult, Credentials, IdentityRef } from '@spinajs/authn';
import { FakeIdentityStore, FakeMfaStep, MemoryLinkStore, MemorySessionIssuer, RecordingEventSink, RecordingPrincipalFactory } from '@spinajs/authn-testing';
import { MemoryNonceStore, NonceStore } from '@spinajs/authn-orm';

import { encodeFlow } from '../src/flow/cookie.js';
import { OidcHttpClient } from '../src/http/client.js';
import { OidcProviders, registerOidcStrategies } from '../src/providers.js';
import { OidcLogin } from '../src/login.js';
import { CoreOidcAccountLinks, OidcAccountLinks } from '../src/links.js';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_ISSUER, FakeIdp } from './support/fake-idp.js';
import { RecordingHook } from './support/world.js';

const ORIGIN = 'https://app.example.test';

function configurationOf(values: Record<string, unknown>): Class<Configuration> {
  const json = JSON.stringify(values);
  return class CoreTestConfiguration extends FrameworkConfiguration {
    constructor() {
      super();
      this.Env = 'test';
    }

    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  } as unknown as Class<Configuration>;
}

/** Registries find services by registration name, so each value goes in as a named factory. */
function bind(child: IContainer, base: Class<unknown>, name: string, value: unknown): void {
  const factory = { [name]: () => value }[name];
  child.register(factory).as(base);
}

interface Core {
  child: IContainer;
  service: AuthnService;
  idp: FakeIdp;
  identities: FakeIdentityStore;
  links: MemoryLinkStore;
  sessions: MemorySessionIssuer;
  events: RecordingEventSink;
  credentials(sub: string, extra?: Record<string, unknown>): Promise<Credentials>;
}

async function core(linking: { jit: boolean; byVerifiedEmail: boolean }, providerLinking: { jit?: boolean; byVerifiedEmail?: boolean } = {}): Promise<Core> {
  const idp = await FakeIdp.create(FAKE_ISSUER, ['RS256']);
  const identities = new FakeIdentityStore({ jit: linking.jit });
  const links = new MemoryLinkStore();
  const sessions = new MemorySessionIssuer();
  const step = new FakeMfaStep();
  const child = DI.RootContainer.child();
  child.register(
    configurationOf({
      authn: {
        strategies: [{ name: 'oidc:corp', service: 'oidc:corp' }],
        throttle: { service: 'MemoryAuthnThrottle' },
        mfa: { steps: [{ name: step.name, service: 'KitMfaStep' }] },
        linking,
        oidc: { providers: { corp: { issuer: FAKE_ISSUER, clientId: FAKE_CLIENT_ID, clientSecret: { secret: FAKE_CLIENT_SECRET }, linking: providerLinking } } },
      },
    }),
  ).as(Configuration);
  const configuration = await child.resolve(Configuration);
  bind(child, AuthnThrottle, 'MemoryAuthnThrottle', new MemoryAuthnThrottle(configuration));
  bind(child, IdentityStore, 'KitIdentityStore', identities);
  bind(child, IdentityLinkStore, 'KitIdentityLinkStore', links);
  bind(child, SessionIssuer, 'KitSessionIssuer', sessions);
  bind(child, PrincipalFactory, 'KitPrincipalFactory', new RecordingPrincipalFactory());
  bind(child, MfaStep, 'KitMfaStep', step);
  const events = new RecordingEventSink();
  bind(child, AuthnEventSink, 'KitEvents', events);
  bind(child, OidcHttpClient, 'KitIdp', idp);
  bind(child, NonceStore, 'KitNonces', new MemoryNonceStore());
  registerOidcStrategies(['corp'], child);
  // Named here, so a factory another suite left in the root never stands in for the core service.
  child.register(DefaultAuthnService).as(AuthnService);
  const service = await child.resolve(AuthnService);
  const providers = await child.resolve(OidcProviders);
  const credentials = async (sub: string, extra: Record<string, unknown> = {}): Promise<Credentials> => {
    const { flow, location } = await providers.strategy('corp').provider.begin({ redirectUri: `${ORIGIN}/auth/oidc/corp/callback`, mode: 'login', now: new Date() });
    return { kind: 'external', provider: 'oidc:corp', payload: { flow: encodeFlow(flow), query: idp.authorize(location, { claims: { sub, ...extra } }) } };
  };
  return { child, service, idp, identities, links, sessions, events, credentials };
}

const ctx = () => ({ now: new Date(), purpose: 'login' as const, ip: '192.0.2.10' });
const statusOf = (r: AuthenticationResult) => (r.status === 'failure' ? `failure:${r.reason}` : r.status);

describe('authn-oidc under the core service', function () {
  this.timeout(30000);
  const opened: IContainer[] = [];
  const open = async (...a: Parameters<typeof core>) => {
    const c = await core(...a);
    opened.push(c.child);
    return c;
  };

  after(async () => {
    for (const c of opened) await c.dispose();
  });

  it('the registry lists the oidc:<name> service and picks it only for its own provider', async () => {
    const c = await open({ jit: false, byVerifiedEmail: false });
    const registry = await c.child.resolve(StrategyRegistry);
    expect(registry.strategies().map((s: AuthenticationStrategy) => s.name)).to.deep.eq(['oidc:corp']);
    expect(registry.candidates({ kind: 'external', provider: 'oidc:corp', payload: {} }).map((s: AuthenticationStrategy) => s.name)).to.deep.eq(['oidc:corp']);
    expect(registry.candidates({ kind: 'external', provider: 'oidc:other', payload: {} })).to.deep.eq([]);
  });

  it('a linked subject logs in; an unlinked one fails with not_linked', async () => {
    const c = await open({ jit: false, byVerifiedEmail: false });
    const alice = c.identities.add({ login: 'alice' });
    await c.links.link(alice, { provider: 'oidc:corp', subject: 'kc-1' });
    const ok = await c.service.authenticate(await c.credentials('kc-1'), ctx());
    expect(statusOf(ok), JSON.stringify(c.events.all())).to.eq('success');
    expect(ok.status === 'success' && ok.identity).to.deep.eq(alice);
    expect(statusOf(await c.service.authenticate(await c.credentials('kc-2'), ctx()))).to.eq('failure:not_linked');
  });

  for (const [label, global, own, expected] of [
    ['jit: global and provider on', { jit: true, byVerifiedEmail: false }, { jit: true }, 'success'],
    ['jit: global on, provider off', { jit: true, byVerifiedEmail: false }, {}, 'failure:not_linked'],
    ['jit: provider on, global off', { jit: false, byVerifiedEmail: false }, { jit: true }, 'failure:not_linked'],
  ] as const) {
    it(`provisions only with both switches (${label})`, async () => {
      const c = await open(global, own);
      expect(statusOf(await c.service.authenticate(await c.credentials('new-1', { email: 'new@example.test' }), ctx()))).to.eq(expected);
      expect(c.identities.calls.provision.length).to.eq(expected === 'success' ? 1 : 0);
    });
  }

  it('links by a verified email only to the stored email, never provisioning with the provider jit off', async () => {
    const c = await open({ jit: true, byVerifiedEmail: true }, { byVerifiedEmail: true });
    const alice = c.identities.add({ login: 'alice', email: 'alice@example.test' });
    c.identities.add({ login: 'bob@example.test', email: 'bob-real@example.test' });
    const byEmail = await c.service.authenticate(await c.credentials('e-1', { email: 'alice@example.test', email_verified: true }), ctx());
    expect(byEmail.status === 'success' && byEmail.identity).to.deep.eq(alice);
    // A login name that looks like the email is not the stored email.
    expect(statusOf(await c.service.authenticate(await c.credentials('e-2', { email: 'bob@example.test', email_verified: true }), ctx()))).to.eq('failure:not_linked');
    expect(c.identities.calls.provision).to.have.length(0);
  });

  it('the login route hands the verified subject to the hooks across the registry instance', async () => {
    const c = await open({ jit: false, byVerifiedEmail: false });
    const alice = c.identities.add({ login: 'alice' });
    await c.links.link(alice, { provider: 'oidc:corp', subject: 'kc-1' });
    const providers = await c.child.resolve(OidcProviders);
    const hook = new RecordingHook();
    const login = new OidcLogin({
      strategies: providers.strategies(),
      service: c.service,
      sessions: c.sessions,
      hooks: () => [hook],
      redirects: { success: '/', failure: '/' },
      env: 'test',
      sessionCookie: (h) => ({ Name: 'ssid', Value: h.id, Options: {} }),
      callbackPath: (p) => `/auth/oidc/${p}/callback`,
    });
    const begun = await login.begin('corp', { origin: ORIGIN, cookies: {}, query: {}, navigation: false, ctx: ctx() });
    const query = c.idp.authorize(begun.location!, { claims: { sub: 'kc-1', groups: ['eng'] } });
    const done = await login.callback('corp', { origin: ORIGIN, cookies: { 'spinajs-oidc': begun.cookies[0].Value }, query, navigation: false, ctx: ctx() });
    expect(done.status).to.eq(303);
    expect(hook.calls).to.have.length(1);
    expect(hook.calls[0][0] as IdentityRef).to.deep.eq(alice);
  });

  it("links and refuses to unlink the last credential through the core's AccountLinkService", async () => {
    const c = await open({ jit: false, byVerifiedEmail: false });
    c.child.register(CoreOidcAccountLinks).as(OidcAccountLinks);
    const linker = await c.child.resolve(OidcAccountLinks);
    expect(linker).to.be.instanceOf(CoreOidcAccountLinks);
    const alice = c.identities.add({ login: 'alice' });
    const session = await c.sessions.issue(alice, { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() });
    const providers = await c.child.resolve(OidcProviders);
    const login = new OidcLogin({
      strategies: providers.strategies(),
      service: c.service,
      sessions: c.sessions,
      hooks: () => [],
      redirects: { success: '/', failure: '/' },
      env: 'test',
      sessionCookie: (h) => ({ Name: 'ssid', Value: h.id, Options: {} }),
      callbackPath: (p) => `/auth/oidc/${p}/callback`,
      linker,
      links: c.links,
    });
    const req = (query: Record<string, unknown> = {}, cookies: Record<string, string> = {}) => ({ origin: ORIGIN, cookies, query, navigation: false, ctx: ctx(), session });
    const begun = await login.beginLink('corp', req());
    expect(begun.status).to.eq(302);
    const query = c.idp.authorize(begun.location!, { claims: { sub: 'kc-9' } });
    const done = await login.callback('corp', req(query, { 'spinajs-oidc': begun.cookies[0].Value }));
    expect(done.status).to.eq(303);
    expect((await c.links.find('oidc:corp', 'kc-9'))?.identity).to.deep.eq(alice);
    expect((await login.unlink('corp', req())).status).to.eq(403);
    expect(await c.links.find('oidc:corp', 'kc-9')).to.not.eq(null);
  });
});
