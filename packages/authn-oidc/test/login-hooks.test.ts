/** authn-oidc's actions under the core's real service and the real hooks runner. */
import 'mocha';
import * as sinon from 'sinon';
import { expect } from 'chai';
import { randomBytes } from 'node:crypto';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { AUTHN_CONFIGURATION_SCHEMA, AuthnEventSink, AuthnService, AuthnThrottle, DefaultAuthnService, DEFAULT_THROTTLE_PARAMS, IdentityLinkStore, IdentityStore, MemoryAuthnThrottle, MemoryNonceStore, MfaStep, NonceStore, PrincipalFactory, SessionIssuer } from '@spinajs/authn';
import type { AuthnLoginIdentifiedInput, IdentityRef, SessionHandle } from '@spinajs/authn';
import { FakeIdentityStore, FakeMfaStep, MemoryLinkStore, MemorySessionIssuer, RecordingEventSink, RecordingPrincipalFactory } from '@spinajs/authn-testing';
import { ActionHook, DefaultHooks, Hooks } from '@spinajs/hooks';
import type { ActionName, ActionPattern, BeforeContext } from '@spinajs/hooks';
import { RecordingActionHook, refusingHook } from '@spinajs/hooks/testing';

import { encodeFlow } from '../src/flow/cookie.js';
import { AUTHN_OIDC_CONFIGURATION_SCHEMA } from '../src/options/schema.js';
import { OidcHttpClient } from '../src/http/client.js';
import { OidcProviders, registerOidcStrategies } from '../src/providers.js';
import { OidcController } from '../src/controllers/OidcController.js';
import { BackchannelForm } from '../src/dto.js';
import { OidcLogin } from '../src/login.js';
import type { OidcAnswer } from '../src/login.js';
import { BACKCHANNEL_LOGOUT_EVENT } from '../src/token/logout-token.js';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_ISSUER, FakeIdp } from './support/fake-idp.js';

const ORIGIN = 'https://app.example.test';
const STRATEGY = 'oidc:corp';
const FORM = 'application/x-www-form-urlencoded';

function configurationOf(values: Record<string, unknown>): Class<Configuration> {
  const json = JSON.stringify(values);
  return class LoginHooksTestConfiguration extends FrameworkConfiguration {
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

/** Registries find services by registration name, so each value goes in as a factory named `name`. */
function bind(child: IContainer, base: Class<unknown>, name: string, value: unknown): void {
  const factory = () => value;
  Object.defineProperty(factory, 'name', { value: name });
  child.register(factory).as(base);
}

/** The `hooks` log of the runner, captured. */
const hooksLog: string[] = [];

class LoggedHooks extends DefaultHooks {}
Object.defineProperty(LoggedHooks.prototype, 'Log', {
  get: () => ({ warn: (fields: Record<string, unknown>) => hooksLog.push(`${String(fields.hook)} ${String(fields.action)} ${String(fields.error)}`) }),
});

/** An app's group sync: reads the mapped claims of every external login. */
class GroupSync extends ActionHook<'authn.login.identified'> {
  readonly actions: readonly ActionPattern[] = ['authn.login.identified'];
  readonly seen: { identity: IdentityRef; provider?: string; groups?: readonly string[]; sessions: number }[] = [];

  constructor(private readonly sessions: MemorySessionIssuer) {
    super();
  }

  async before(ctx: BeforeContext<'authn.login.identified'>): Promise<void> {
    const input: AuthnLoginIdentifiedInput = ctx.input;
    this.seen.push({ identity: input.identity, provider: input.external?.provider, groups: input.external?.claims?.groups as readonly string[] | undefined, sessions: (await this.sessions.storage.storedKeys()).length });
  }
}

class Probe extends OidcController {}

interface World {
  child: IContainer;
  idp: FakeIdp;
  identities: FakeIdentityStore;
  links: MemoryLinkStore;
  sessions: MemorySessionIssuer;
  service: AuthnService;
  controller: Probe;
  login(sub: string, sid?: string): Promise<SessionHandle>;
}

async function world(hooks: (sessions: MemorySessionIssuer) => readonly ActionHook<ActionName>[]): Promise<World> {
  const idp = await FakeIdp.create(FAKE_ISSUER, ['RS256']);
  const identities = new FakeIdentityStore();
  const links = new MemoryLinkStore();
  const sessions = new MemorySessionIssuer();
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
  bind(child, NonceStore, 'KitNonces', new MemoryNonceStore());
  registerOidcStrategies(['corp'], child);
  // Hooks are read when the runner resolves, so they go in before anything that injects it.
  child.register(LoggedHooks).as(Hooks);
  hooks(sessions).forEach((h, i) => bind(child, ActionHook, `TestActionHook${i}`, h));
  child.register(DefaultAuthnService).as(AuthnService);
  const service = await child.resolve(AuthnService);
  const providers = await child.resolve(OidcProviders);
  const controller = await child.resolve(Probe);

  const login = async (sub: string, sid?: string): Promise<SessionHandle> => {
    const { flow, location } = await providers.strategy('corp').provider.begin({ redirectUri: `${ORIGIN}/auth/oidc/corp/callback`, mode: 'login', now: new Date() });
    const query = idp.authorize(location, { claims: { sub, ...(sid !== undefined ? { sid } : {}) } });
    const r = await service.authenticate({ kind: 'external', provider: STRATEGY, payload: { flow: encodeFlow(flow), query } }, { now: new Date(), purpose: 'login', ip: '192.0.2.10' });
    if (r.status !== 'success' || !r.session) throw new Error(`login of ${sub} failed: ${JSON.stringify(r)}`);
    return r.session;
  };
  return { child, idp, identities, links, sessions, service, controller, login };
}

async function logoutToken(idp: FakeIdp, claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: idp.issuer, aud: FAKE_CLIENT_ID, iat: now, exp: now + 120, jti: randomBytes(12).toString('base64url'), events: { [BACKCHANNEL_LOGOUT_EVENT]: {} }, ...claims };
  return idp.sign(idp.keys[0], JSON.stringify(body), { typ: 'logout+jwt' });
}

const IDP_PEER = { encrypted: true, peer: '198.51.100.7', clientIp: '198.51.100.7' };
const answerOf = (r: unknown): OidcAnswer => (r as { answer: OidcAnswer }).answer;

describe('authn-oidc action hooks', function () {
  this.timeout(30000);
  const opened: IContainer[] = [];

  beforeEach(() => {
    hooksLog.length = 0;
  });

  after(async () => {
    for (const c of opened) await c.dispose();
  });

  async function open(hooks: (sessions: MemorySessionIssuer) => readonly ActionHook<ActionName>[]): Promise<World> {
    const w = await world(hooks);
    opened.push(w.child);
    return w;
  }

  it('a group-sync hook on authn.login.identified receives the mapped claims of an OIDC login, before the session', async () => {
    let sync!: GroupSync;
    const w = await open((sessions) => [(sync = new GroupSync(sessions))]);
    const alice = w.identities.add({ login: 'alice' });
    await w.links.link(alice, { provider: STRATEGY, subject: 'kc-1' });
    const providers = await w.child.resolve(OidcProviders);
    const login = new OidcLogin({
      strategies: providers.strategies(),
      service: w.service,
      sessions: w.sessions,
      redirects: { success: '/', failure: '/' },
      env: 'test',
      sessionCookie: (h) => ({ Name: 'ssid', Value: h.id, Options: {} }),
      callbackPath: (p) => `/auth/oidc/${p}/callback`,
    });
    const ctx = () => ({ now: new Date(), purpose: 'login' as const, ip: '192.0.2.10' });
    const begun = await login.begin('corp', { origin: ORIGIN, cookies: {}, query: {}, navigation: false, ctx: ctx() });
    const query = w.idp.authorize(begun.location!, { claims: { sub: 'kc-1', groups: ['eng', 'ops'] } });
    const done = await login.callback('corp', { origin: ORIGIN, cookies: { 'spinajs-oidc': begun.cookies[0].Value }, query, navigation: false, ctx: ctx() });
    expect(done.status).to.eq(303);
    expect(sync.seen).to.deep.eq([{ identity: alice, provider: STRATEGY, groups: ['eng', 'ops'], sessions: 0 }]);
  });

  it('a refusal on authn.login.identified fails the OIDC login with no session', async () => {
    const w = await open(() => [refusingHook('authn.login.identified', 'kit-no-group')]);
    const alice = w.identities.add({ login: 'alice' });
    await w.links.link(alice, { provider: STRATEGY, subject: 'kc-1' });
    let error: unknown;
    try {
      await w.login('kc-1');
    } catch (e) {
      error = e;
    }
    expect(String(error)).to.contain('invalid_credentials');
    expect(await w.sessions.storage.storedKeys()).to.deep.eq([]);
  });

  it('a refusing hook on authn.logout.backchannel is logged and the sessions are still revoked', async () => {
    const recorder = new RecordingActionHook(['authn.logout.backchannel']);
    const w = await open(() => [refusingHook('authn.logout.backchannel', 'kit-keep-sessions'), recorder]);
    const alice = w.identities.add({ login: 'alice' });
    await w.links.link(alice, { provider: STRATEGY, subject: 'kc-alice' });
    const a1 = await w.login('kc-alice', 'idp-1');
    const a2 = await w.login('kc-alice', 'idp-2');
    const res = await w.controller.backchannelLogout('corp', IDP_PEER, FORM, new BackchannelForm({ logout_token: await logoutToken(w.idp, { sid: 'idp-1' }) }));
    expect(answerOf(res).status).to.eq(200);
    expect(await w.sessions.restore(a1.id), 'the sid is logged out').to.eq(null);
    expect(await w.sessions.restore(a2.id), 'another sid stays').to.not.eq(null);
    expect(hooksLog.some((l) => l.includes('authn.logout.backchannel') && l.includes('ActionRefused')), hooksLog.join('\n')).to.eq(true);
    expect(recorder.calls.map((c) => c.phase)).to.deep.eq(['before', 'after']);
    const input = recorder.calls[0].input as Record<string, unknown>;
    expect(Object.keys(input).sort()).to.deep.eq(['ctx', 'provider', 'sid']);
    expect(input.provider).to.eq(STRATEGY);
    expect(input.sid).to.eq('idp-1');
  });

  it('with no hook registered, the back-channel logout never calls the runner', async () => {
    const w = await open(() => []);
    const alice = w.identities.add({ login: 'alice' });
    await w.links.link(alice, { provider: STRATEGY, subject: 'kc-alice' });
    const a1 = await w.login('kc-alice', 'idp-1');
    const run = sinon.spy(DefaultHooks.prototype, 'run');
    try {
      const res = await w.controller.backchannelLogout('corp', IDP_PEER, FORM, new BackchannelForm({ logout_token: await logoutToken(w.idp, { sid: 'idp-1' }) }));
      expect(answerOf(res).status).to.eq(200);
      expect(await w.sessions.restore(a1.id)).to.eq(null);
      expect(run.callCount).to.eq(0);
    } finally {
      run.restore();
    }
  });
});
