/** OpenID Back-Channel Logout 1.0 receiver (FLOW-2) under the core's real service, over the fake IdP's JWKS. */
import 'mocha';
import { expect } from 'chai';
import { randomBytes } from 'node:crypto';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { AUTHN_CONFIGURATION_SCHEMA, AuthnEventSink, AuthnService, AuthnThrottle, DefaultAuthnService, DEFAULT_THROTTLE_PARAMS, IdentityLinkStore, IdentityStore, MemoryAuthnThrottle, MemoryNonceStore, MfaStep, NonceStore, PrincipalFactory, SessionIssuer } from '@spinajs/authn';
import type { IdentityRef, SessionHandle } from '@spinajs/authn';
import { FakeIdentityStore, FakeMfaStep, MemoryLinkStore, MemorySessionIssuer, RecordingEventSink, RecordingPrincipalFactory } from '@spinajs/authn-testing';
import type { Request } from '@spinajs/http';

import { encodeFlow } from '../src/flow/cookie.js';
import { mapClaims } from '../src/claims.js';
import { AUTHN_OIDC_CONFIGURATION_SCHEMA } from '../src/options/schema.js';
import { OidcHttpClient } from '../src/http/client.js';
import { OidcProviders, registerOidcStrategies } from '../src/providers.js';
import { OidcController } from '../src/controllers/OidcController.js';
import type { OidcAnswer } from '../src/login.js';
import { BACKCHANNEL_LOGOUT_EVENT, OidcBackchannelLogout } from '../src/token/logout-token.js';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_ISSUER, FakeIdp } from './support/fake-idp.js';
import type { FakeIdpKey } from './support/fake-idp.js';

const ORIGIN = 'https://app.example.test';
const STRATEGY = 'oidc:corp';
const FORM = 'application/x-www-form-urlencoded';
const INVALID = { error: 'invalid_request' };

function configurationOf(values: Record<string, unknown>): Class<Configuration> {
  const json = JSON.stringify(values);
  return class BackchannelTestConfiguration extends FrameworkConfiguration {
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
  };
}

function bind(child: IContainer, base: Class<unknown>, name: string, value: unknown): void {
  const factory = { [name]: () => value }[name];
  child.register(factory).as(base);
}

class Probe extends OidcController {}

interface World {
  child: IContainer;
  idp: FakeIdp;
  identities: FakeIdentityStore;
  links: MemoryLinkStore;
  sessions: MemorySessionIssuer;
  service: AuthnService;
  receiver: OidcBackchannelLogout;
  controller: Probe;
  /** A real OIDC login of `sub` whose ID token carries `sid` (when given). */
  login(sub: string, sid?: string): Promise<SessionHandle>;
}

async function world(): Promise<World> {
  const idp = await FakeIdp.create(FAKE_ISSUER, ['RS256']);
  const identities = new FakeIdentityStore();
  const links = new MemoryLinkStore();
  const sessions = new MemorySessionIssuer();
  const nonces = new MemoryNonceStore();
  const step = new FakeMfaStep();
  const child = DI.RootContainer.child();
  for (const schema of [AUTHN_CONFIGURATION_SCHEMA, AUTHN_OIDC_CONFIGURATION_SCHEMA]) child.register(schema).asValue('__configurationSchema__');
  child.register(
    configurationOf({
      authn: {
        strategies: [{ name: STRATEGY, service: STRATEGY }],
        throttle: { service: 'MemoryAuthnThrottle' },
        mfa: { steps: [{ name: step.name, service: 'KitMfaStep' }] },
        linking: { jit: false, byVerifiedEmail: false },
        oidc: { providers: { corp: { issuer: FAKE_ISSUER, clientId: FAKE_CLIENT_ID, clientSecret: { secret: FAKE_CLIENT_SECRET } } } },
      },
    }),
  ).as(Configuration);
  await child.resolve(Configuration);
  bind(child, AuthnThrottle, 'MemoryAuthnThrottle', new MemoryAuthnThrottle(DEFAULT_THROTTLE_PARAMS));
  bind(child, IdentityStore, 'KitIdentityStore', identities);
  bind(child, IdentityLinkStore, 'KitIdentityLinkStore', links);
  bind(child, SessionIssuer, 'KitSessionIssuer', sessions);
  bind(child, PrincipalFactory, 'KitPrincipalFactory', new RecordingPrincipalFactory());
  bind(child, MfaStep, 'KitMfaStep', step);
  bind(child, AuthnEventSink, 'KitEvents', new RecordingEventSink());
  bind(child, OidcHttpClient, 'KitIdp', idp);
  bind(child, NonceStore, 'KitNonces', nonces);
  registerOidcStrategies(['corp'], child);
  child.register(DefaultAuthnService).as(AuthnService);
  const service = await child.resolve(AuthnService);
  const providers = await child.resolve(OidcProviders);
  const receiver = new OidcBackchannelLogout({ strategies: providers.strategies(), sessions, links, nonces });
  const controller = await child.resolve(Probe);

  const login = async (sub: string, sid?: string): Promise<SessionHandle> => {
    const { flow, location } = await providers.strategy('corp').provider.begin({ redirectUri: `${ORIGIN}/auth/oidc/corp/callback`, mode: 'login', now: new Date() });
    const query = idp.authorize(location, { claims: { sub, ...(sid !== undefined ? { sid } : {}) } });
    const r = await service.authenticate({ kind: 'external', provider: STRATEGY, payload: { flow: encodeFlow(flow), query } }, { now: new Date(), purpose: 'login', ip: '192.0.2.10' });
    if (r.status !== 'success' || !r.session) throw new Error(`login of ${sub} failed: ${JSON.stringify(r)}`);
    return r.session;
  };
  return { child, idp, identities, links, sessions, service, receiver, controller, login };
}

interface TokenOptions {
  /** Signing key; default the IdP's first. */
  readonly key?: FakeIdpKey;
  readonly header?: Record<string, unknown>;
}

/** A logout token of the fake IdP; a claim set to undefined is left out. */
async function logoutToken(idp: FakeIdp, claims: Record<string, unknown>, opts: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: idp.issuer, aud: FAKE_CLIENT_ID, iat: now, exp: now + 120, jti: randomBytes(12).toString('base64url'), events: { [BACKCHANNEL_LOGOUT_EVENT]: {} }, ...claims };
  return idp.sign(opts.key ?? idp.keys[0], JSON.stringify(body), { typ: 'logout+jwt', ...opts.header });
}

const alive = async (w: World, h: SessionHandle): Promise<boolean> => (await w.sessions.restore(h.id)) !== null;

describe('authn-oidc back-channel logout (FLOW-2)', function () {
  this.timeout(30000);
  const opened: IContainer[] = [];
  let w: World;
  let alice: IdentityRef;
  let bob: IdentityRef;

  beforeEach(async () => {
    w = await world();
    opened.push(w.child);
    alice = w.identities.add({ login: 'alice' });
    bob = w.identities.add({ login: 'bob' });
    await w.links.link(alice, { provider: STRATEGY, subject: 'kc-alice' });
    await w.links.link(bob, { provider: STRATEGY, subject: 'kc-bob' });
  });

  after(async () => {
    for (const c of opened) await c.dispose();
  });

  const receive = async (token: unknown, provider = 'corp'): Promise<OidcAnswer> => w.receiver.receive(provider, { logout_token: token }, new Date());

  it('maps the ID token sid onto the external subject', () => {
    const mapping = { subject: 'sub', email: null, emailVerified: null, name: null, groups: null } as const;
    expect(mapClaims(STRATEGY, mapping, { sub: 'kc-1', sid: 'idp-1' }).sid).to.eq('idp-1');
    expect(mapClaims(STRATEGY, mapping, { sub: 'kc-1' })).to.not.have.property('sid');
    expect(mapClaims(STRATEGY, mapping, { sub: 'kc-1', sid: 7 })).to.not.have.property('sid');
  });

  it('an OIDC login with sid stores facts.external of the provider and sid', async () => {
    const h = await w.login('kc-alice', 'idp-1');
    expect({ ...(await w.sessions.restore(h.id))?.facts.external }).to.deep.eq({ provider: STRATEGY, sid: 'idp-1' });
  });

  it('a valid logout_token with sid revokes exactly the sessions with that sid and answers 200 with Cache-Control: no-store', async () => {
    const a1 = await w.login('kc-alice', 'idp-1');
    const a2 = await w.login('kc-alice', 'idp-1');
    const a3 = await w.login('kc-alice', 'idp-2');
    const b1 = await w.login('kc-bob', 'idp-3');
    const answer = await receive(await logoutToken(w.idp, { sid: 'idp-1', sub: 'kc-alice' }));
    expect(answer.status).to.eq(200);
    expect(answer.headers?.['cache-control']).to.eq('no-store');
    expect(answer.body).to.eq(undefined);
    expect(await alive(w, a1)).to.eq(false);
    expect(await alive(w, a2)).to.eq(false);
    expect(await alive(w, a3), 'another sid of the same identity').to.eq(true);
    expect(await alive(w, b1), 'another identity').to.eq(true);
  });

  it('with sub only, revokes every session of the identity linked to that provider subject', async () => {
    const a1 = await w.login('kc-alice', 'idp-1');
    const a2 = await w.login('kc-alice');
    const a3 = await w.sessions.issue(alice, { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() });
    const b1 = await w.login('kc-bob', 'idp-3');
    const answer = await receive(await logoutToken(w.idp, { sub: 'kc-alice' }));
    expect(answer.status).to.eq(200);
    for (const h of [a1, a2, a3]) expect(await alive(w, h)).to.eq(false);
    expect(await alive(w, b1)).to.eq(true);
  });

  it('a sub that is linked to no identity answers 200 and revokes nothing', async () => {
    const a1 = await w.login('kc-alice', 'idp-1');
    const answer = await receive(await logoutToken(w.idp, { sub: 'kc-nobody' }));
    expect(answer.status).to.eq(200);
    expect(await alive(w, a1)).to.eq(true);
  });

  it('an unknown sid answers 200 and revokes nothing', async () => {
    const a1 = await w.login('kc-alice', 'idp-1');
    const b1 = await w.login('kc-bob', 'idp-3');
    const answer = await receive(await logoutToken(w.idp, { sid: 'idp-unknown' }));
    expect(answer.status).to.eq(200);
    expect(answer.headers?.['cache-control']).to.eq('no-store');
    expect(await alive(w, a1)).to.eq(true);
    expect(await alive(w, b1)).to.eq(true);
  });

  const refusals: [string, (idp: FakeIdp) => Promise<string>][] = [
    ['missing events', (idp) => logoutToken(idp, { sid: 'idp-1', events: undefined })],
    ['events without the back-channel logout member', (idp) => logoutToken(idp, { sid: 'idp-1', events: { 'http://schemas.openid.net/event/other': {} } })],
    ['contains nonce', (idp) => logoutToken(idp, { sid: 'idp-1', nonce: 'n-0123456789' })],
    ['wrong aud', (idp) => logoutToken(idp, { sid: 'idp-1', aud: 'another-client' })],
    ['wrong iss', (idp) => logoutToken(idp, { sid: 'idp-1', iss: 'https://evil.example.test/realms/corp' })],
    ['iat beyond the clock skew', (idp) => logoutToken(idp, { sid: 'idp-1', iat: Math.floor(Date.now() / 1000) + 3600, exp: Math.floor(Date.now() / 1000) + 7200 })],
    ['expired', (idp) => logoutToken(idp, { sid: 'idp-1', iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 })],
    ['no jti', (idp) => logoutToken(idp, { sid: 'idp-1', jti: undefined })],
    ['neither sub nor sid', (idp) => logoutToken(idp, {})],
    ['typed as another JWT', (idp) => logoutToken(idp, { sid: 'idp-1' }, { header: { typ: 'at+jwt' } })],
    [
      'bad signature',
      async (idp) => {
        const other = await FakeIdp.create(FAKE_ISSUER, ['RS256']);
        return logoutToken(idp, { sid: 'idp-1' }, { key: other.keys[0], header: { kid: idp.keys[0].kid } });
      },
    ],
  ];
  for (const [label, token] of refusals) {
    it(`refuses a logout token with ${label}: 400 invalid_request, nothing revoked`, async () => {
      const a1 = await w.login('kc-alice', 'idp-1');
      const answer = await receive(await token(w.idp));
      expect(answer.status).to.eq(400);
      expect(answer.body).to.deep.eq(INVALID);
      expect(await alive(w, a1)).to.eq(true);
    });
  }

  it('a replayed jti answers 400 the second time', async () => {
    const token = await logoutToken(w.idp, { sid: 'idp-1' });
    expect((await receive(token)).status).to.eq(200);
    const a1 = await w.login('kc-alice', 'idp-1');
    const again = await receive(token);
    expect(again.status).to.eq(400);
    expect(again.body).to.deep.eq(INVALID);
    expect(await alive(w, a1), 'the replay revokes nothing').to.eq(true);
  });

  it('refuses a missing or non-string logout_token, an unknown provider and a body that is no form', async () => {
    expect((await w.receiver.receive('corp', {}, new Date())).status).to.eq(400);
    expect((await w.receiver.receive('corp', undefined, new Date())).status).to.eq(400);
    expect((await receive(['a', 'b'])).status).to.eq(400);
    expect((await receive(await logoutToken(w.idp, { sid: 'idp-1' }), 'nope')).body).to.deep.eq(INVALID);
  });

  describe('POST /auth/oidc/:provider/backchannel-logout', () => {
    const request = (body: unknown, type: string | false = FORM) =>
      ({ body, is: (t: string) => (type !== false && t === type ? t : false), get: () => undefined, cookies: {}, query: {}, socket: {} }) as unknown as Request;
    const answerOf = (r: unknown): OidcAnswer => (r as { answer: OidcAnswer }).answer;

    it('reads logout_token from the form body and revokes the sid', async () => {
      const a1 = await w.login('kc-alice', 'idp-1');
      const res = await w.controller.backchannelLogout('corp', request({ logout_token: await logoutToken(w.idp, { sid: 'idp-1' }) }));
      expect(answerOf(res).status).to.eq(200);
      expect(await alive(w, a1)).to.eq(false);
    });

    it('refuses a body that is not application/x-www-form-urlencoded', async () => {
      const a1 = await w.login('kc-alice', 'idp-1');
      const res = await w.controller.backchannelLogout('corp', request({ logout_token: await logoutToken(w.idp, { sid: 'idp-1' }) }, 'application/json'));
      expect(answerOf(res).status).to.eq(400);
      expect(answerOf(res).body).to.deep.eq(INVALID);
      expect(await alive(w, a1)).to.eq(true);
    });
  });
});
