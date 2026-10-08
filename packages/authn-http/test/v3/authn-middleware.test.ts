import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import * as cs from 'cookie-signature';
import { DateTime } from 'luxon';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { CONFIGURATION_CONTAINER_KEY, Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { Orm } from '@spinajs/orm';
import { BaseController, Controllers, HttpServer, ServerMiddleware } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider } from '@spinajs/users';
import { AuthenticationStrategy, AuthnService, AuthnThrottle, CredentialExtractor, IMPERSONATION_BLOCK, IdentityStore, ImpersonationGuard, PrincipalFactory, SessionIssuer } from '@spinajs/authn';
import type { AuthnContext, AuthnFacts, Credentials, IdentityRef, Principal, SessionHandle, SignedRequest, StrategyOutcome } from '@spinajs/authn';
import { DefaultSessionIssuer, MemorySessionStore, PUBLIC_DEFAULT_COOKIE_SECRET, appEnvOf, sessionCookieName } from '@spinajs/authn-session';
import type { ISession, ISessionCookieConfig } from '@spinajs/authn-session';
import { FakeIdentityStore, FakeImpersonationGuard, FakeStrategy, RecordingPrincipalFactory, RecordingThrottle } from '@spinajs/authn-testing';

import * as barrel from '../../src/index.js';
import * as api from '../../src/api.js';
import { AuthnPrincipalResolver } from '../../src/api.js';
import { fakeContainer } from '../support/config-boot.js';
import { AuthnMiddleware } from '../../src/middleware/authn.js';
import { KeyPrincipalResolver, TokenPrincipalResolver } from '../../src/resolvers/credential.js';
import { SessionPrincipalResolver } from '../../src/resolvers/session.js';
import { ApiKeyHeaderExtractor, AuthorizationBearerExtractor, HttpSignatureExtractor } from '../../src/extractors/index.js';
import { registerAuthnHttpV3 } from '../../src/v3/register.js';
import { AUTHN_PROBE_PATH, authnProbeHits } from './probe.js';
import { buildAuthnMiddlewareIn } from './authn-in-child.js';
import { COOKIE_SECRET, TestConfiguration, req, restoreHttpErrorMap } from '../token-common.js';

const PUBLIC_ORIGIN = 'https://api.example.test';
const APP_ORIGIN = 'http://localhost:8889';

class AuthnMiddlewareConfiguration extends TestConfiguration {
  protected onLoad(): unknown {
    const base = super.onLoad() as { http: Record<string, unknown>; authn: Record<string, unknown> };
    return {
      ...base,
      http: {
        ...base.http,
        middlewares: [
          express.json({
            limit: '5mb',
            verify: (r, _res, buf) => {
              (r as { rawBody?: Buffer }).rawBody = buf;
            },
          }),
          express.urlencoded({ extended: true }),
          cookieParser(COOKIE_SECRET),
        ],
      },
      authn: {
        ...base.authn,
        strategies: [
          { name: 'token', service: 'SuiteTokenStrategy' },
          { name: 'keys', service: 'SuiteKeyStrategy' },
        ],
        http: { publicOrigin: PUBLIC_ORIGIN },
      },
    };
  }
}

// Same as releaseHttpServer() of packages/http/test/common.ts, which imports http's sources and so cannot be shared.
async function releaseHttpServer(): Promise<void> {
  await DI.get(HttpServer)?.stop();
  DI.uncache(HttpServer);
  DI.uncache(Controllers);
  for (const type of DI.getRegisteredTypes(BaseController) ?? []) DI.uncache(type as Class<BaseController>);
  DI.uncache(BaseController);
}

/** A named factory: registries look services up by the registration's name. */
function bind(child: IContainer, base: Class<unknown>, name: string, value: unknown): void {
  const factory = { [name]: () => value }[name];
  child.register(factory).as(base);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwsOf = (typ: string, kid = 'k1') => `${b64url({ alg: 'EdDSA', kid, typ })}.${b64url({ iss: 'x', aud: 'y', iat: 1, exp: 2 })}.${randomBytes(16).toString('base64url')}`;

const INVALID: StrategyOutcome = { ok: false, reason: 'invalid_credentials' };
const UNSUPPORTED: StrategyOutcome = { ok: false, reason: 'unsupported_credentials' };

interface Suite {
  child: IContainer;
  identities: FakeIdentityStore;
  principals: RecordingPrincipalFactory;
  guard: FakeImpersonationGuard;
  issuer: DefaultSessionIssuer;
  store: MemorySessionStore;
  throttle: RecordingThrottle;
  tokens: Map<string, StrategyOutcome>;
  jws: Map<string, StrategyOutcome>;
  signatures: Map<string, StrategyOutcome>;
  tokenStrategy: FakeStrategy;
  keyStrategy: FakeStrategy;
  ctxs: AuthnContext[];
}

function sessionStore(): MemorySessionStore {
  const store = new MemorySessionStore();
  const sixty = () => DateTime.now().plus({ minutes: 60 });
  Object.defineProperty(store, 'Expiration', { value: { initial: sixty, renew: sixty } });
  return store;
}

async function buildSuite(): Promise<Suite> {
  const child = DI.RootContainer.child();
  const identities = new FakeIdentityStore();
  const principals = new RecordingPrincipalFactory();
  const guard = new FakeImpersonationGuard();
  const store = sessionStore();
  const issuer = new DefaultSessionIssuer();
  // Built by hand around this suite's own store (fixed 60-minute expiry), not the configured one.
  Object.defineProperty(issuer, 'Store', { value: store });
  Object.defineProperty(issuer, 'PendingTtlSeconds', { value: 300 });
  const throttle = new RecordingThrottle();
  const tokens = new Map<string, StrategyOutcome>();
  const jws = new Map<string, StrategyOutcome>();
  const signatures = new Map<string, StrategyOutcome>();
  const ctxs: AuthnContext[] = [];
  const keyOf = (v: string) => [{ kind: 'account', value: sha(v).slice(0, 16) }];

  const tokenStrategy = new FakeStrategy({
    name: 'token',
    kinds: ['bearer'],
    interactive: false,
    keys: (c) => keyOf(String((c as { token?: unknown }).token)),
    verify: (c, ctx) => {
      ctxs.push(ctx);
      return c.kind === 'bearer' ? (tokens.get(String(c.token)) ?? INVALID) : UNSUPPORTED;
    },
  });
  const keyStrategy = new FakeStrategy({
    name: 'keys',
    kinds: ['jws-assertion', 'http-signature'],
    interactive: false,
    keys: (c) => keyOf(c.kind),
    verify: (c, ctx) => {
      ctxs.push(ctx);
      if (c.kind === 'jws-assertion') return jws.get(String(c.jws)) ?? INVALID;
      if (c.kind === 'http-signature') return signatures.get((c.request as SignedRequest).headers.signature) ?? INVALID;
      return UNSUPPORTED;
    },
  });

  bind(child, IdentityStore, 'SuiteIdentityStore', identities);
  bind(child, PrincipalFactory, 'SuitePrincipalFactory', principals);
  bind(child, ImpersonationGuard, 'SuiteImpersonationGuard', guard);
  bind(child, SessionIssuer, 'SuiteSessionIssuer', issuer);
  bind(child, AuthnThrottle, 'MemoryAuthnThrottle', throttle);
  bind(child, AuthenticationStrategy, 'SuiteTokenStrategy', tokenStrategy);
  bind(child, AuthenticationStrategy, 'SuiteKeyStrategy', keyStrategy);
  await registerAuthnHttpV3(child);
  return { child, identities, principals, guard, issuer, store, throttle, tokens, jws, signatures, tokenStrategy, keyStrategy, ctxs };
}

const FACTS = (over: Partial<AuthnFacts> = {}): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal2', mfa: ['totp'], authenticatedAt: new Date(), ...over });

describe('AuthnMiddleware, extractors and principal resolvers (A09, A15, A23)', function () {
  this.timeout(60000);

  let s: Suite;
  let authnInChild: sinon.SinonStub | undefined;
  let cookieName: string;
  let alice: IdentityRef;
  let bob: IdentityRef;

  const cookieOf = (rawId: string) => `${cookieName}=${encodeURIComponent(cs.sign(rawId, COOKIE_SECRET))}`;

  async function probe(headers: Record<string, string | string[]> = {}, opts: { method?: 'GET' | 'POST'; body?: unknown; form?: Record<string, string>; query?: string } = {}) {
    const path = `${AUTHN_PROBE_PATH}${opts.query ?? ''}`;
    let call = opts.method === 'POST' ? req().post(path) : req().get(path);
    call = call.set('Accept', 'application/json');
    for (const [name, value] of Object.entries(headers)) call = call.set(name, value as string);
    if (opts.form) call = call.type('form').send(opts.form);
    else if (opts.body !== undefined) call = call.send(opts.body as object);
    const before = authnProbeHits();
    const res = await call;
    return { status: res.status, body: res.body, headers: res.headers, ran: authnProbeHits() > before };
  }

  async function principalWith(headers: Record<string, string | string[]> = {}) {
    const res = await probe(headers);
    expect(res.status, JSON.stringify(res.body)).to.eq(200);
    return res.body.principal;
  }

  async function startServer(): Promise<void> {
    DI.uncache(AuthnMiddleware);
    DI.uncache(barrel.CsrfOriginGuard);
    DI.uncache(barrel.ClientIp);
    DI.uncache(ServerMiddleware);
    await DI.resolve(Controllers);
    await (await DI.resolve(HttpServer)).start();
  }

  before(async () => {
    DI.setESMModuleSupport();
    restoreHttpErrorMap();

    DI.unregister(AuthnMiddlewareConfiguration);
    DI.register(AuthnMiddlewareConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) await b.bootstrap();

    const config = await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Orm);

    s = await buildSuite();
    authnInChild = buildAuthnMiddlewareIn(s.child);
    cookieName = sessionCookieName(config.get<ISessionCookieConfig>('authn.session.cookie', {}), appEnvOf(config));
    await startServer();
  });

  beforeEach(() => {
    alice = s.identities.add({ login: `alice-${randomUUID()}` });
    bob = s.identities.add({ login: `bob-${randomUUID()}` });
    s.ctxs.length = 0;
    s.tokenStrategy.verifyCalls.length = 0;
    s.keyStrategy.verifyCalls.length = 0;
  });

  after(async () => {
    await releaseHttpServer();
    authnInChild?.restore();
    DI.uncache(AuthnMiddleware);
    DI.uncache(barrel.CsrfOriginGuard);
    DI.uncache(barrel.ClientIp);
    DI.uncache(ServerMiddleware);
    await s?.child.dispose();
    DI.unregister(AuthnMiddlewareConfiguration);
    DI.uncache(AuthnMiddlewareConfiguration);
    DI.uncache(Configuration);
    DI.uncache(Orm);
  });

  describe('exports and registration', () => {
    it('the barrel exports the lane middleware and resolvers, not the api.ts stubs', () => {
      expect(barrel.AuthnMiddleware).to.eq(AuthnMiddleware).and.not.eq(api.AuthnMiddleware);
      expect(barrel.KeyPrincipalResolver).to.eq(KeyPrincipalResolver).and.not.eq(api.KeyPrincipalResolver);
      expect(barrel.TokenPrincipalResolver).to.eq(TokenPrincipalResolver).and.not.eq(api.TokenPrincipalResolver);
      expect(barrel.SessionPrincipalResolver).to.eq(SessionPrincipalResolver).and.not.eq(api.SessionPrincipalResolver);
      expect(barrel.AuthorizationBearerExtractor).to.eq(AuthorizationBearerExtractor);
      expect(barrel.ApiKeyHeaderExtractor).to.eq(ApiKeyHeaderExtractor);
      expect(barrel.HttpSignatureExtractor).to.eq(HttpSignatureExtractor);
    });

    it('orders: middleware 5, resolvers 45/50/100, extractors signature < Authorization < api key', () => {
      expect(new AuthnMiddleware().Order).to.eq(5);
      expect([new KeyPrincipalResolver().order, new TokenPrincipalResolver().order, new SessionPrincipalResolver().order]).to.deep.eq([45, 50, 100]);
      const sig = new HttpSignatureExtractor().order;
      const auth = new AuthorizationBearerExtractor().order;
      const key = new ApiKeyHeaderExtractor().order;
      expect(sig).to.be.lessThan(auth);
      expect(auth).to.be.lessThan(key);
    });

    it('loading the package registered the 3.0 layer in the root once; registerAuthnHttpV3 registers it in the container it is given', () => {
      expect(DI.getRegisteredTypes(AuthnPrincipalResolver)).to.have.members([KeyPrincipalResolver, TokenPrincipalResolver, SessionPrincipalResolver]);
      expect(DI.getRegisteredTypes(CredentialExtractor)).to.have.members([HttpSignatureExtractor, AuthorizationBearerExtractor, ApiKeyHeaderExtractor]);
      expect(DI.getRegisteredTypes(ServerMiddleware).filter((t) => t === AuthnMiddleware)).to.have.length(1);
      expect(s.child.getRegisteredTypes(AuthnPrincipalResolver, false)).to.have.members([KeyPrincipalResolver, TokenPrincipalResolver, SessionPrincipalResolver]);
      expect(s.child.getRegisteredTypes(CredentialExtractor, false)).to.have.members([HttpSignatureExtractor, AuthorizationBearerExtractor, ApiKeyHeaderExtractor]);
      expect(s.child.getRegisteredTypes(ServerMiddleware, false)).to.include(AuthnMiddleware);
    });
  });

  describe('session cookie', () => {
    it('an active session restores into a principal with authn facts and no-store', async () => {
      const h = await s.issuer.issue(alice, FACTS());
      const res = await probe({ Cookie: cookieOf(h.id) });
      expect(res.status).to.eq(200);
      expect(res.body.session).to.deep.eq({ state: 'active' });
      const p = res.body.principal;
      expect(p).to.include({ type: 'user', id: alice.id, source: 'session' });
      expect(p.authn).to.include({ method: 'password', strategy: 'local', assurance: 'aal2' });
      expect(p.authn.sessionHandle).to.be.a('string').and.not.eq(h.id);
      expect(p.ceiling).to.eq(undefined);
      expect(res.headers['cache-control']).to.eq('no-store');
    });

    it('sends no cookie for an authenticated request: the idle expiry slides in the issuer, the cookie stays a browser-session cookie (N8a-D7)', async () => {
      const h = await s.issuer.issue(alice, FACTS());
      const res = await probe({ Cookie: cookieOf(h.id) });
      expect(res.status).to.eq(200);
      expect(res.headers['set-cookie']).to.eq(undefined);
    });

    it('an express-signed cookie (s: prefix, req.signedCookies) restores too', async () => {
      const h = await s.issuer.issue(alice, FACTS());
      const p = await principalWith({ Cookie: `${cookieName}=${encodeURIComponent('s:' + cs.sign(h.id, COOKIE_SECRET))}` });
      expect(p?.id).to.eq(alice.id);
    });

    it('a bad signature restores no session', async () => {
      const h = await s.issuer.issue(alice, FACTS());
      const res = await probe({ Cookie: `${cookieName}=${encodeURIComponent(cs.sign(h.id, 'another-secret'))}` });
      expect(res.body.session).to.eq(null);
      expect(res.body.principal).to.eq(null);
      const signed = await probe({ Cookie: `${cookieName}=${encodeURIComponent('s:' + cs.sign(h.id, 'another-secret'))}` });
      expect(signed.body.session).to.eq(null);
      expect(signed.body.principal).to.eq(null);
    });

    it('an unknown session id restores no session', async () => {
      const res = await probe({ Cookie: cookieOf(randomBytes(16).toString('base64url')) });
      expect(res.body.session).to.eq(null);
      expect(res.body.principal).to.eq(null);
      expect(res.headers['cache-control']).to.not.eq('no-store');
    });

    it('A09 SR-07 a pending session sets AuthnSession and yields no principal', async () => {
      const h = await s.issuer.issue(alice, FACTS({ assurance: 'aal1', mfa: [] }), { pending: { steps: ['totp'] } });
      const res = await probe({ Cookie: cookieOf(h.id) });
      expect(res.body.session).to.deep.eq({ state: 'pending' });
      expect(res.body.principal).to.eq(null);
      expect(res.headers['cache-control']).to.eq('no-store');
    });

    it('D14 ActiveRole in the session becomes ceiling.roles, built by PrincipalFactory', async () => {
      const h = await s.issuer.issue(alice, FACTS());
      await s.issuer.set(h, 'ActiveRole', 'editor');
      const p = await principalWith({ Cookie: cookieOf(h.id) });
      expect(p.ceiling).to.deep.eq({ roles: ['editor'] });
      expect(s.principals.calls.at(-1)?.extra.ceiling).to.deep.eq({ roles: ['editor'] });
    });

    it('a malformed ActiveRole narrows to no role rather than none at all', async () => {
      const h = await s.issuer.issue(alice, FACTS());
      await s.issuer.set(h, 'ActiveRole', ['admin']);
      const p = await principalWith({ Cookie: cookieOf(h.id) });
      expect(p.ceiling).to.deep.eq({ roles: [] });
    });

    it('SR-06 a banned subject gets no principal and every session of it ends', async () => {
      const h1 = await s.issuer.issue(alice, FACTS());
      const h2 = await s.issuer.issue(alice, FACTS());
      const imp = await s.issuer.issue(bob, FACTS({ impersonator: alice }));
      s.identities.setStatus(alice, { banned: true });
      const res = await probe({ Cookie: cookieOf(h1.id) });
      expect(res.body.principal).to.eq(null);
      expect(res.body.session, 'the ended session is not left in AuthnSession').to.eq(null);
      expect(res.headers['cache-control']).to.eq('no-store');
      expect(await s.issuer.restore(h1.id)).to.eq(null);
      expect(await s.issuer.restore(h2.id), 'another session of the banned subject').to.eq(null);
      expect(await s.issuer.restore(imp.id), 'an impersonation by the banned subject').to.eq(null);
    });

    for (const [label, status] of [
      ['inactive', { active: false }],
      ['deleted', { deleted: true }],
    ] as const) {
      it(`SR-06 a subject found ${label} gets no principal and its other sessions end`, async () => {
        const h1 = await s.issuer.issue(alice, FACTS());
        const h2 = await s.issuer.issue(alice, FACTS());
        s.identities.setStatus(alice, status);
        expect(await principalWith({ Cookie: cookieOf(h1.id) })).to.eq(null);
        expect(await s.issuer.restore(h2.id)).to.eq(null);
      });
    }

    it('an impersonation session gives the target with authn.impersonator', async () => {
      const h = await s.issuer.issue(bob, FACTS({ impersonator: alice }));
      await s.issuer.set(h, IMPERSONATION_BLOCK, { startedAt: new Date().toISOString() });
      const p = await principalWith({ Cookie: cookieOf(h.id) });
      expect(p).to.include({ type: 'user', id: bob.id });
      expect(p.authn.impersonator).to.deep.eq({ type: 'user', id: alice.id });
    });

    it('SR-06 a banned impersonator ends the impersonation and every session of the impersonator', async () => {
      const own = await s.issuer.issue(alice, FACTS());
      const h = await s.issuer.issue(bob, FACTS({ impersonator: alice }));
      await s.issuer.set(h, IMPERSONATION_BLOCK, { startedAt: new Date().toISOString() });
      const bobOwn = await s.issuer.issue(bob, FACTS());
      s.identities.setStatus(alice, { banned: true });
      expect(await principalWith({ Cookie: cookieOf(h.id) })).to.eq(null);
      expect(await s.issuer.restore(h.id)).to.eq(null);
      expect(await s.issuer.restore(own.id), "the impersonator's own session").to.eq(null);
      expect(await s.issuer.restore(bobOwn.id), "the target's own session is not touched").to.not.eq(null);
    });

    it('an expired impersonation yields no principal and revokes nothing else', async () => {
      const own = await s.issuer.issue(alice, FACTS());
      const h = await s.issuer.issue(bob, FACTS({ impersonator: alice }));
      await s.issuer.set(h, IMPERSONATION_BLOCK, { startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() });
      expect(await principalWith({ Cookie: cookieOf(h.id) })).to.eq(null);
      expect(await s.issuer.restore(own.id)).to.not.eq(null);
    });

    const plant2x = (extra: [string, unknown][]) => {
      const rawId = randomUUID();
      const rows = (s.store as unknown as { Sessions: Map<string, ISession> }).Sessions;
      rows.set(rawId, {
        SessionId: rawId,
        Creation: DateTime.now(),
        Expiration: DateTime.now().plus({ minutes: 30 }),
        Data: new Map<string, unknown>([['User', alice.id], ['Authorized', true], ['Logged', true], ...extra]),
      } as unknown as ISession);
      return { rawId, rows };
    };

    it('A07 a 2.x session row restores through DefaultSessionIssuer (lazy migration)', async () => {
      const { rawId, rows } = plant2x([['ActiveRole', undefined]]);
      const p = await principalWith({ Cookie: cookieOf(rawId) });
      expect(p).to.include({ type: 'user', id: alice.id });
      expect(p.ceiling).to.eq(undefined);
      expect(rows.has(rawId), 'the raw row is migrated away').to.eq(false);
    });

    it('N8c a 2.x session row carrying an ActiveRole yields no principal and is revoked', async () => {
      const { rawId, rows } = plant2x([['ActiveRole', 'user']]);
      expect(await principalWith({ Cookie: cookieOf(rawId) })).to.eq(null);
      expect(rows.has(rawId), 'the raw row is deleted').to.eq(false);
      expect(rows.has(createHash('sha256').update(rawId).digest('hex')), 'no migrated copy').to.eq(false);
    });

    it('a store error fails the request (500), never a silent anonymous', async () => {
      const h = await s.issuer.issue(alice, FACTS());
      const stub = sinon.stub(s.issuer, 'restore').rejects(new Error('store down'));
      try {
        const res = await probe({ Cookie: cookieOf(h.id) });
        expect(res.status).to.eq(500);
        expect(res.ran).to.eq(false);
      } finally {
        stub.restore();
      }
    });

    it('an IdentityStore error in the session resolver fails the request (500)', async () => {
      const h = await s.issuer.issue(alice, FACTS());
      const stub = sinon.stub(s.identities, 'status').rejects(new Error('users db down'));
      try {
        const res = await probe({ Cookie: cookieOf(h.id) });
        expect(res.status).to.eq(500);
        expect(res.ran).to.eq(false);
      } finally {
        stub.restore();
      }
    });
  });

  describe('credentials', () => {
    const tokenFor = (id: IdentityRef, extra: Partial<Extract<StrategyOutcome, { ok: true }>> = {}): string => {
      const token = `spt_${randomBytes(12).toString('base64url')}`;
      s.tokens.set(token, { ok: true, identity: id, method: 'token', ...extra });
      return token;
    };

    it('an active session ignores a bearer header', async () => {
      const h = await s.issuer.issue(alice, FACTS());
      const token = tokenFor(bob);
      const p = await principalWith({ Cookie: cookieOf(h.id), Authorization: `Bearer ${token}` });
      expect(p.id).to.eq(alice.id);
      expect(s.tokenStrategy.verifyCalls).to.have.length(0);
    });

    it('a pending session plus a valid bearer gives the token principal', async () => {
      const h = await s.issuer.issue(alice, FACTS({ assurance: 'aal1', mfa: [] }), { pending: { steps: ['totp'] } });
      const token = tokenFor(bob);
      const res = await probe({ Cookie: cookieOf(h.id), Authorization: `Bearer ${token}` });
      expect(res.body.session).to.deep.eq({ state: 'pending' });
      expect(res.body.principal).to.include({ id: bob.id, source: 'token' });
    });

    it('a bearer token gives its principal with ceiling.roles and the profile attribute, no-store, ctx from ClientIp', async () => {
      const token = tokenFor(alice, { ceiling: { roles: ['reader'] }, attributes: { profile: 'p1' } });
      const res = await probe({ Authorization: `Bearer ${token}`, 'User-Agent': 'probe-agent' });
      const p = res.body.principal;
      expect(p).to.include({ type: 'user', id: alice.id, source: 'token' });
      expect(p.ceiling).to.deep.eq({ roles: ['reader'] });
      expect(p.attributes.profile).to.eq('p1');
      expect(p.authn).to.include({ method: 'token', strategy: 'token' });
      expect(res.headers['cache-control']).to.eq('no-store');
      const ctx = s.ctxs.at(-1)!;
      expect(ctx.purpose).to.eq('request');
      expect(ctx.ip).to.eq(res.body.clientIp);
      expect(ctx.userAgent).to.eq('probe-agent');
      expect(ctx.now).to.be.instanceOf(Date);
      expect(s.throttle.attempts.at(-1)?.ctx.ip).to.eq(res.body.clientIp);
    });

    it('A15 an agent token gives an agent principal acting for its owner', async () => {
      const agentId = randomUUID();
      const token = `spt_${randomBytes(12).toString('base64url')}`;
      s.tokens.set(token, { ok: true, identity: { type: 'agent', id: agentId }, method: 'token', ceiling: { permissions: ['file:read'], reason: 'out_of_scope' }, delegation: { onBehalfOf: alice, mode: 'inherit' } });
      const p = await principalWith({ Authorization: `Bearer ${token}` });
      expect(p).to.include({ type: 'agent', id: agentId, delegation: 'inherit' });
      expect(p.onBehalfOf).to.deep.eq({ type: 'user', id: alice.id });
      expect(p.ceiling).to.deep.eq({ permissions: ['file:read'], reason: 'out_of_scope' });
    });

    it('a lowercase bearer scheme is accepted', async () => {
      const token = tokenFor(alice);
      expect((await principalWith({ Authorization: `bearer ${token}` }))?.id).to.eq(alice.id);
    });

    it('x-api-key gives a bearer credential', async () => {
      const token = tokenFor(alice);
      expect((await principalWith({ 'X-Api-Key': token }))?.id).to.eq(alice.id);
      expect(s.tokenStrategy.verifyCalls.at(-1)).to.deep.eq({ kind: 'bearer', token });
    });

    it('a duplicated Authorization or api-key header gives no principal', async () => {
      const token = tokenFor(alice);
      expect(await principalWith({ Authorization: [`Bearer ${token}`, `Bearer ${token}`] })).to.eq(null);
      expect(await principalWith({ 'X-Api-Key': [token, token] })).to.eq(null);
      expect(s.tokenStrategy.verifyCalls, 'the repeated Authorization is a failing credential; the api key none').to.have.length(1);
    });

    it('M2 a malformed or repeated Authorization bearer with the token prefix stops resolution: our x-api-key does not answer', async () => {
      const good = tokenFor(alice);
      for (const authorization of [`Bearer ${good} extra`, `Bearer spt_bad!value`, [`Bearer ${good}`, `Bearer ${good}`]]) {
        expect(await principalWith({ Authorization: authorization, 'X-Api-Key': good }), String(authorization)).to.eq(null);
      }
      expect(s.tokenStrategy.verifyCalls.map((c) => (c as { token: string }).token)).to.deep.eq([`${good} extra`, 'spt_bad!value', `${good}, Bearer ${good}`]);
      expect((await principalWith({ Authorization: 'Bearer ', 'X-Api-Key': good }))?.id, 'an empty bearer is no credential, as in 2.x').to.eq(alice.id);
    });

    it('a malformed Authorization header reads as no credentials', async () => {
      for (const value of ['Bearer', 'Bearer ', 'Basic dXNlcjpwYXNz', 'Bearer a b', 'Bearerx abc']) {
        expect(await principalWith({ Authorization: value }), value).to.eq(null);
      }
      expect(s.tokenStrategy.verifyCalls).to.have.length(0);
    });

    it('a three-part bearer with typ spinajs-client+jwt is a jws-assertion for the key resolver', async () => {
      const assertion = jwsOf('spinajs-client+jwt');
      s.jws.set(assertion, { ok: true, identity: alice, method: 'jws', ceiling: { permissions: ['file:read'] } });
      const p = await principalWith({ Authorization: `Bearer ${assertion}` });
      expect(p).to.include({ id: alice.id });
      expect(p.ceiling).to.deep.eq({ permissions: ['file:read'] });
      expect(s.keyStrategy.verifyCalls.at(-1)).to.deep.eq({ kind: 'jws-assertion', jws: assertion });
      expect(s.tokenStrategy.verifyCalls).to.have.length(0);
    });

    it('other three-part bearer values are bearer (JWT) for the token resolver', async () => {
      const jwt = jwsOf('JWT');
      s.tokens.set(jwt, { ok: true, identity: alice, method: 'jwt' });
      expect((await principalWith({ Authorization: `Bearer ${jwt}` }))?.id).to.eq(alice.id);
      expect(s.tokenStrategy.verifyCalls.at(-1)).to.deep.eq({ kind: 'bearer', token: jwt });
      expect(s.keyStrategy.verifyCalls).to.have.length(0);
    });

    it('a rejected bearer stops resolution: no other credential and no session answers', async () => {
      const good = tokenFor(alice);
      expect(await principalWith({ Authorization: 'Bearer spt_unknown', 'X-Api-Key': good })).to.eq(null);
      const h = await s.issuer.issue(alice, FACTS({ assurance: 'aal1', mfa: [] }), { pending: { steps: ['totp'] } });
      expect(await principalWith({ Cookie: cookieOf(h.id), Authorization: 'Bearer spt_unknown' })).to.eq(null);
      expect(s.tokenStrategy.verifyCalls.map((c) => (c as { token: string }).token)).to.deep.eq(['spt_unknown', 'spt_unknown']);
    });

    it('C7 an opaque bearer of another service gives no credentials: no strategy runs and no failure counts', async () => {
      const attempts = s.throttle.attempts.length;
      expect(await principalWith({ Authorization: 'Bearer telemetry-0123456789abcdef' })).to.eq(null);
      expect(await principalWith({ Authorization: 'Bearer a.b' })).to.eq(null);
      expect(s.tokenStrategy.verifyCalls).to.have.length(0);
      expect(s.keyStrategy.verifyCalls).to.have.length(0);
      expect(s.throttle.attempts.length, 'nothing counted').to.eq(attempts);
    });

    it('R1 an x-api-key value without authn.token.prefix gives no credentials; with an opaque bearer, our x-api-key authenticates (as 2.x)', async () => {
      const attempts = s.throttle.attempts.length;
      expect(await principalWith({ 'X-Api-Key': 'telemetry-0123456789abcdef' })).to.eq(null);
      expect(await principalWith({ 'X-Api-Key': jwsOf('JWT') })).to.eq(null);
      expect(s.tokenStrategy.verifyCalls).to.have.length(0);
      expect(s.throttle.attempts.length, 'nothing counted').to.eq(attempts);
      const token = tokenFor(alice);
      expect((await principalWith({ Authorization: 'Bearer telemetry-0123456789abcdef', 'X-Api-Key': token }))?.id).to.eq(alice.id);
      expect(s.tokenStrategy.verifyCalls).to.deep.eq([{ kind: 'bearer', token }]);
    });

    it('an anonymous request stays cacheable', async () => {
      const res = await probe();
      expect(res.body.principal).to.eq(null);
      expect(res.body.session).to.eq(null);
      expect(res.headers['cache-control']).to.not.eq('no-store');
    });
  });

  describe('signature headers (A18 transport)', () => {
    const sigHeaders = (signature: string, extra: Record<string, string> = {}) => ({ Signature: signature, 'Signature-Input': 'sig=("@method" "@target-uri");keyid="k1";created=1;expires=2;nonce="n"', 'X-Extra': 'Mixed-Case', ...extra });

    it('signature headers give an http-signature credential with the public origin target, lower-case headers and no body', async () => {
      const sig = `sig=:${randomBytes(8).toString('base64')}:`;
      s.signatures.set(sig, { ok: true, identity: alice, method: 'http-signature', ceiling: { permissions: ['x:read'] } });
      const res = await probe(sigHeaders(sig), { query: '?a=1&b=two' });
      expect(res.body.principal).to.include({ id: alice.id });
      const c = s.keyStrategy.verifyCalls.at(-1) as { kind: string; request: SignedRequest };
      expect(c.kind).to.eq('http-signature');
      expect(c.request.method).to.eq('GET');
      expect(c.request.targetUri).to.eq(`${PUBLIC_ORIGIN}/${AUTHN_PROBE_PATH}?a=1&b=two`);
      expect(c.request.headers.signature).to.eq(sig);
      expect(c.request.headers['x-extra']).to.eq('Mixed-Case');
      expect(Object.keys(c.request.headers).every((k) => k === k.toLowerCase())).to.eq(true);
      expect(c.request.body).to.eq(undefined);
    });

    it('a JSON body reaches the strategy as the exact raw bytes', async () => {
      const sig = `sig=:${randomBytes(8).toString('base64')}:`;
      s.signatures.set(sig, { ok: true, identity: alice, method: 'http-signature' });
      const raw = '{"b":2,  "a":"\\u00e9"}';
      const res = await probe({ ...sigHeaders(sig), 'Content-Type': 'application/json' }, { method: 'POST', body: raw });
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      const c = s.keyStrategy.verifyCalls.at(-1) as { request: SignedRequest };
      expect(c.request.method).to.eq('POST');
      expect(Buffer.from(c.request.body!).toString('utf8')).to.eq(raw);
    });

    it('a body without raw bytes never verifies as body-less: the strategy gets bytes no client signed', async () => {
      const sig = `sig=:${randomBytes(8).toString('base64')}:`;
      s.signatures.set(sig, { ok: true, identity: alice, method: 'http-signature' });
      await probe(sigHeaders(sig), { method: 'POST', form: { a: '1' } });
      const c = s.keyStrategy.verifyCalls.at(-1) as { request: SignedRequest };
      expect(c.request.body, 'a body is passed').to.be.instanceOf(Uint8Array);
      expect(c.request.body!.length).to.be.greaterThan(0);
      expect(Buffer.from(c.request.body!).toString('utf8')).to.not.eq('a=1');
      await probe(sigHeaders(sig), { method: 'POST', form: { a: '1' } });
      const again = s.keyStrategy.verifyCalls.at(-1) as { request: SignedRequest };
      expect(Buffer.from(again.request.body!).equals(Buffer.from(c.request.body!)), 'not a fixed value').to.eq(false);
    });

    it('without authn.http.publicOrigin signature headers give no credentials', async () => {
      const config = DI.get(Configuration)!;
      const sig = `sig=:${randomBytes(8).toString('base64')}:`;
      s.signatures.set(sig, { ok: true, identity: alice, method: 'http-signature' });
      config.set('authn.http.publicOrigin', null);
      try {
        expect(await principalWith(sigHeaders(sig))).to.eq(null);
        expect(s.keyStrategy.verifyCalls).to.have.length(0);
      } finally {
        config.set('authn.http.publicOrigin', PUBLIC_ORIGIN);
      }
    });

    it('signature headers win over a bearer header', async () => {
      const sig = `sig=:${randomBytes(8).toString('base64')}:`;
      s.signatures.set(sig, { ok: true, identity: alice, method: 'http-signature' });
      const token = tokenOf(bob);
      expect((await principalWith({ ...sigHeaders(sig), Authorization: `Bearer ${token}` }))?.id).to.eq(alice.id);
      expect(s.tokenStrategy.verifyCalls).to.have.length(0);

      function tokenOf(id: IdentityRef): string {
        const t = `spt_${randomBytes(12).toString('base64url')}`;
        s.tokens.set(t, { ok: true, identity: id, method: 'token' });
        return t;
      }
    });

    it('an absolute-form request target gives no credentials', async () => {
      const sig = `sig=:${randomBytes(8).toString('base64')}:`;
      s.signatures.set(sig, { ok: true, identity: alice, method: 'http-signature' });
      const token = `spt_${randomBytes(12).toString('base64url')}`;
      s.tokens.set(token, { ok: true, identity: alice, method: 'token' });
      const body = await new Promise<{ status: number; body: { principal: unknown } }>((done, fail) => {
        const r = http.request({ host: 'localhost', port: 8889, method: 'GET', path: `http://localhost:8889/${AUTHN_PROBE_PATH}`, headers: { ...sigHeaders(sig), Authorization: `Bearer ${token}`, Accept: 'application/json' } }, (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => done({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
        });
        r.on('error', fail);
        r.end();
      });
      expect(body.status).to.eq(200);
      expect(body.body.principal).to.eq(null);
      expect(s.keyStrategy.verifyCalls).to.have.length(0);
      expect(s.tokenStrategy.verifyCalls).to.have.length(0);
    });

    it('a malformed publicOrigin set at runtime fails only signed requests, not anonymous ones', async () => {
      const config = DI.get(Configuration)!;
      config.set('authn.http.publicOrigin', 'not an origin');
      try {
        expect((await probe()).status).to.eq(200);
        const sig = `sig=:${randomBytes(8).toString('base64')}:`;
        expect((await probe(sigHeaders(sig))).status).to.eq(500);
      } finally {
        config.set('authn.http.publicOrigin', PUBLIC_ORIGIN);
      }
    });
  });

  describe('CSRF guard and the session cookie name (A22)', () => {
    it('the guard refuses a cross-origin POST carrying the cookie name AuthnMiddleware reads', async () => {
      const h = await s.issuer.issue(alice, FACTS());
      const refused = await probe({ Cookie: cookieOf(h.id), Origin: 'https://evil.example.net' }, { method: 'POST', body: {} });
      expect(refused.status).to.eq(403);
      expect(refused.ran).to.eq(false);
      const own = await probe({ Cookie: cookieOf(h.id), Origin: APP_ORIGIN }, { method: 'POST', body: {} });
      expect(own.body.principal?.id).to.eq(alice.id);
    });
  });
});

describe('AuthnMiddleware units', () => {
  const config = (values: Record<string, unknown>) => ({ get: (path: string, def?: unknown) => (path in values ? values[path] : def) });
  const log = () => ({ warn: sinon.spy(), info: sinon.spy(), debug: sinon.spy(), error: sinon.spy(), trace: sinon.spy() });

  function unit(values: Record<string, unknown>, parts: { sessions?: unknown; extractors?: unknown[]; resolvers?: unknown[] } = {}) {
    const mw = new AuthnMiddleware();
    const l = log();
    Object.defineProperty(mw, 'Configuration', { value: config(values) });
    Object.defineProperty(mw, CONFIGURATION_CONTAINER_KEY, { value: fakeContainer({ 'authn.session.cookie': { name: 'ssid' }, ...values }) });
    Object.defineProperty(mw, 'Log', { value: l });
    Object.defineProperty(mw, 'Container', {
      value: {
        resolve: async (t: unknown) => {
          if (t === SessionIssuer) return parts.sessions ?? { restore: async () => null };
          const type = (t as { Type?: unknown }).Type;
          if (type === CredentialExtractor) return parts.extractors ?? [];
          if (type === AuthnPrincipalResolver) return parts.resolvers ?? [];
          throw new Error('unexpected resolve');
        },
      },
    });
    return { mw, log: l };
  }

  const STRONG = 'unit-' + 'Zx8q'.repeat(10);

  describe('boot', () => {
    it('SR-16 refuses the public cookie secret without an app env', async () => {
      const { mw } = unit({ 'http.cookie.secret': PUBLIC_DEFAULT_COOKIE_SECRET });
      await expect(mw.resolve()).to.be.rejectedWith(InvalidOption, 'http.cookie.secret');
    });

    it('refuses a missing cookie secret', async () => {
      const { mw } = unit({ 'process.env.APP_ENV': 'test' });
      await expect(mw.resolve()).to.be.rejectedWith(InvalidOption, 'http.cookie.secret');
    });

    it('boots with the public secret in the test env, with a warning', async () => {
      const { mw, log: l } = unit({ 'process.env.APP_ENV': 'test', 'http.cookie.secret': PUBLIC_DEFAULT_COOKIE_SECRET, 'authn.http.publicOrigin': PUBLIC_ORIGIN });
      await mw.resolve();
      expect(l.warn.calledWithMatch(sinon.match(/http\.cookie\.secret/))).to.eq(true);
    });

    it('warns once when authn.http.publicOrigin is unset and refuses a malformed one', async () => {
      const unset = unit({ 'http.cookie.secret': STRONG });
      await unset.mw.resolve();
      expect(unset.log.warn.calledWithMatch(sinon.match(/authn\.http\.publicOrigin/))).to.eq(true);
      const bad = unit({ 'http.cookie.secret': STRONG, 'authn.http.publicOrigin': 'api.example.test/path' });
      await expect(bad.mw.resolve()).to.be.rejectedWith(InvalidOption, 'authn.http.publicOrigin');
    });
  });

  describe('request handling', () => {
    const fakeReq = (over: Record<string, unknown> = {}) => ({ method: 'GET', originalUrl: '/x', headers: {}, rawHeaders: [], cookies: {}, signedCookies: {}, storage: { ClientIp: '10.0.0.1' }, ...over }) as unknown as Request;
    const fakeRes = () => {
      const headers: Record<string, string> = {};
      return { headers, setHeader: (n: string, v: string) => ((headers[n.toLowerCase()] = v), undefined) };
    };
    const resolver = (order: number, answer: Principal | null | undefined | Error) => ({
      order,
      calls: 0,
      async resolve() {
        this.calls++;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
    const P = (id: string): Principal => ({ type: 'user', id, authenticated: true, source: 'token', attributes: {} });

    async function run(mw: AuthnMiddleware, r: Request) {
      const res = fakeRes();
      const handler = mw.before()!;
      const err = await new Promise<unknown>((done) => handler(r, res as never, (e?: unknown) => done(e)));
      return { err, res };
    }

    it('asks resolvers in ascending order; the first answer that is not undefined wins, null included', async () => {
      const a = resolver(100, P('late'));
      const b = resolver(10, undefined);
      const c = resolver(50, null);
      const { mw } = unit({ 'http.cookie.secret': STRONG, 'authn.http.publicOrigin': PUBLIC_ORIGIN }, { resolvers: [a, b, c] });
      await mw.resolve();
      const r = fakeReq();
      const { err } = await run(mw, r);
      expect(err).to.eq(undefined);
      expect(r.storage.AuthnPrincipal).to.eq(null);
      expect([b.calls, c.calls, a.calls]).to.deep.eq([1, 1, 0]);
    });

    it('all undefined gives null; a principal is written as given', async () => {
      const none = unit({ 'http.cookie.secret': STRONG, 'authn.http.publicOrigin': PUBLIC_ORIGIN }, { resolvers: [resolver(1, undefined)] });
      await none.mw.resolve();
      const r1 = fakeReq();
      await run(none.mw, r1);
      expect(r1.storage.AuthnPrincipal).to.eq(null);

      const p = P('a');
      const one = unit({ 'http.cookie.secret': STRONG, 'authn.http.publicOrigin': PUBLIC_ORIGIN }, { resolvers: [resolver(1, p)] });
      await one.mw.resolve();
      const r2 = fakeReq();
      const { res } = await run(one.mw, r2);
      expect(r2.storage.AuthnPrincipal).to.eq(p);
      expect(res.headers['cache-control']).to.eq('no-store');
    });

    it('passes the credentials of the first extractor that answers and never stores them on the request', async () => {
      const seen: (Credentials | null)[] = [];
      const rec = { order: 1, calls: 0, async resolve(_r: Request, c: Credentials | null) { seen.push(c); return undefined; } };
      const ex = (order: number, c: Credentials | null) => ({ order, extract: sinon.spy(() => c) });
      const first = ex(20, { kind: 'bearer', token: 'one' });
      const later = ex(30, { kind: 'bearer', token: 'two' });
      const empty = ex(10, null);
      const { mw } = unit({ 'http.cookie.secret': STRONG, 'authn.http.publicOrigin': PUBLIC_ORIGIN }, { extractors: [later, first, empty], resolvers: [rec] });
      await mw.resolve();
      const r = fakeReq();
      await run(mw, r);
      expect(seen).to.deep.eq([{ kind: 'bearer', token: 'one' }]);
      expect(later.extract.called).to.eq(false);
      expect(JSON.stringify(r.storage)).to.not.contain('one');
    });

    it('a resolver error goes to next(err) with no principal', async () => {
      const { mw } = unit({ 'http.cookie.secret': STRONG, 'authn.http.publicOrigin': PUBLIC_ORIGIN }, { resolvers: [resolver(1, new Error('db down'))] });
      await mw.resolve();
      const r = fakeReq();
      const { err } = await run(mw, r);
      expect((err as Error).message).to.eq('db down');
      expect(r.storage.AuthnPrincipal ?? null).to.eq(null);
    });

    it('a bad cookie signature logs a hashed value, never the raw one', async () => {
      const { mw, log: l } = unit({ 'http.cookie.secret': STRONG, 'authn.http.publicOrigin': PUBLIC_ORIGIN });
      await mw.resolve();
      const rawId = randomBytes(16).toString('base64url');
      const forged = cs.sign(rawId, 'other');
      const name = sessionCookieName({}, undefined);
      const r = fakeReq({ cookies: { [name]: forged } });
      await run(mw, r);
      expect(r.storage.AuthnSession).to.eq(null);
      expect(l.warn.called).to.eq(true);
      const logged = JSON.stringify(l.warn.args);
      expect(logged).to.not.contain(rawId);
      expect(logged).to.not.contain(forged);
      expect(logged).to.not.contain(sha(rawId));
    });

    it('an unknown session id logs a hashed value, never the raw id or its storage key', async () => {
      const { mw, log: l } = unit({ 'http.cookie.secret': STRONG, 'authn.http.publicOrigin': PUBLIC_ORIGIN });
      await mw.resolve();
      const rawId = randomBytes(16).toString('base64url');
      const r = fakeReq({ cookies: { [sessionCookieName({}, undefined)]: cs.sign(rawId, STRONG) } });
      await run(mw, r);
      expect(r.storage.AuthnSession).to.eq(null);
      expect(l.warn.calledOnce).to.eq(true);
      const logged = JSON.stringify(l.warn.args);
      expect(logged).to.not.contain(rawId);
      expect(logged).to.not.contain(sha(rawId));
    });
  });

  describe('extractors', () => {
    // The schema defaults, which a stand-in container does not apply; extractors-config.test.ts pins them to the schema.
    const EXTRACTOR_DEFAULTS = { 'authn.token.prefix': 'spt_', 'authn.token.headerName': 'x-api-key', 'authn.keys.assertion.typ': 'spinajs-client+jwt' };
    const extractor = <T extends object>(E: new () => T, values: Record<string, unknown> = {}) => {
      const e = new E();
      Object.defineProperty(e, CONFIGURATION_CONTAINER_KEY, { value: fakeContainer({ ...EXTRACTOR_DEFAULTS, ...values }) });
      return e as T & { extract(r: SignedRequest): Credentials | null };
    };
    const sreq = (headers: Record<string, string>, over: Partial<SignedRequest> = {}): SignedRequest => ({ method: 'GET', targetUri: `${PUBLIC_ORIGIN}/x`, headers, ...over });

    it('Authorization: spt_ values are bearer without decoding; a custom prefix is honoured', () => {
      const e = extractor(AuthorizationBearerExtractor);
      expect(e.extract(sreq({ authorization: 'Bearer spt_a.b.c' }))).to.deep.eq({ kind: 'bearer', token: 'spt_a.b.c' });
      const custom = extractor(AuthorizationBearerExtractor, { 'authn.token.prefix': 'tok_', 'authn.keys.assertion.typ': 'custom+jwt' });
      const assertion = jwsOf('custom+jwt');
      expect(custom.extract(sreq({ authorization: `Bearer ${assertion}` }))).to.deep.eq({ kind: 'jws-assertion', jws: assertion });
      expect(custom.extract(sreq({ authorization: `Bearer ${jwsOf('spinajs-client+jwt')}` }))?.kind).to.eq('bearer');
    });

    it('Authorization: an undecodable JWS header is still a three-part bearer; C7 other values give nothing', () => {
      const e = extractor(AuthorizationBearerExtractor);
      expect(e.extract(sreq({ authorization: 'Bearer not-json.payload.sig' }))).to.deep.eq({ kind: 'bearer', token: 'not-json.payload.sig' });
      expect(e.extract(sreq({ authorization: 'BEARER spt_upper' }))).to.deep.eq({ kind: 'bearer', token: 'spt_upper' });
      for (const value of ['Bearer opaque-token', 'Bearer a.b', 'Bearer a.b.c.d', 'Bearer a..c', 'Bearer SPT_wrong-case', 'Bearer opaque, Bearer spt_k']) {
        expect(e.extract(sreq({ authorization: value })), value).to.eq(null);
      }
      expect(e.extract(sreq({ authorization: 'Bearer spt_a b' })), 'a malformed prefix value is a failing credential').to.deep.eq({ kind: 'bearer', token: 'spt_a b' });
      expect(e.extract(sreq({}))).to.eq(null);
    });

    it('x-api-key honours authn.token.headerName and refuses a combined value', () => {
      const e = extractor(ApiKeyHeaderExtractor, { 'authn.token.headerName': 'X-Token' });
      expect(e.extract(sreq({ 'x-token': 'spt_k' }))).to.deep.eq({ kind: 'bearer', token: 'spt_k' });
      expect(e.extract(sreq({ 'x-api-key': 'spt_k' }))).to.eq(null);
      expect(e.extract(sreq({ 'x-token': 'spt_k, spt_k' }))).to.eq(null);
      expect(e.extract(sreq({ 'x-token': '' }))).to.eq(null);
    });

    it('R1 x-api-key takes only values with authn.token.prefix, as the Authorization extractor and the 2.x middleware do', () => {
      const e = extractor(ApiKeyHeaderExtractor);
      expect(e.extract(sreq({ 'x-api-key': 'opaque-key' }))).to.eq(null);
      expect(e.extract(sreq({ 'x-api-key': jwsOf('JWT') }))).to.eq(null);
      expect(e.extract(sreq({ 'x-api-key': 'SPT_wrong-case' }))).to.eq(null);
      const custom = extractor(ApiKeyHeaderExtractor, { 'authn.token.prefix': 'tok_' });
      expect(custom.extract(sreq({ 'x-api-key': 'tok_k' }))).to.deep.eq({ kind: 'bearer', token: 'tok_k' });
      expect(custom.extract(sreq({ 'x-api-key': 'spt_k' }))).to.eq(null);
    });

    it('signature: both headers, a public origin and an origin-form target are needed; the origin comes from config', () => {
      const e = extractor(HttpSignatureExtractor, { 'authn.http.publicOrigin': PUBLIC_ORIGIN });
      const headers = { signature: 'sig=:x:', 'signature-input': 'sig=()' };
      const body = new Uint8Array([1, 2]);
      expect(e.extract(sreq(headers, { targetUri: '/x?y=1', method: 'POST', body }))).to.deep.eq({ kind: 'http-signature', request: { method: 'POST', targetUri: `${PUBLIC_ORIGIN}/x?y=1`, headers, body } });
      expect(e.extract(sreq(headers, { targetUri: 'http://other.example/x' })), 'absolute-form').to.eq(null);
      expect(e.extract(sreq(headers, { targetUri: '*' })), 'asterisk-form').to.eq(null);
      expect(e.extract(sreq({ signature: 'sig=:x:' }, { targetUri: '/x' }))).to.eq(null);
      expect(extractor(HttpSignatureExtractor).extract(sreq(headers, { targetUri: '/x' })), 'no publicOrigin').to.eq(null);
    });
  });

  describe('resolvers', () => {
    const service = (result: unknown, principal?: Principal) => {
      const calls: { c: Credentials; ctx: AuthnContext }[] = [];
      return {
        calls,
        authenticate: async (c: Credentials, ctx: AuthnContext) => (calls.push({ c, ctx }), result),
        principalOf: async () => principal,
      };
    };
    const withService = <T extends AuthnPrincipalResolver>(r: T, svc: unknown) => {
      Object.defineProperty(r, 'Container', { value: { resolve: async (t: unknown) => (t === AuthnService ? svc : null) } });
      return r;
    };
    const ctx: AuthnContext = { now: new Date(), purpose: 'login', ip: '10.1.1.1' };
    const r = {} as Request;

    it('each credential resolver answers undefined for other kinds and for no credentials', async () => {
      const svc = service({ status: 'failure', reason: 'invalid_credentials' });
      const key = withService(new KeyPrincipalResolver(), svc);
      const token = withService(new TokenPrincipalResolver(), svc);
      expect(await key.resolve(r, null, ctx)).to.eq(undefined);
      expect(await key.resolve(r, { kind: 'bearer', token: 't' }, ctx)).to.eq(undefined);
      expect(await token.resolve(r, null, ctx)).to.eq(undefined);
      expect(await token.resolve(r, { kind: 'jws-assertion', jws: 'a.b.c' }, ctx)).to.eq(undefined);
      expect(svc.calls).to.have.length(0);
    });

    it('a failure is null and a success goes through principalOf unchanged, purpose request', async () => {
      const p: Principal = { type: 'user', id: 'u', authenticated: true, source: 'token', attributes: {} };
      const ok = service({ status: 'success', identity: { type: 'user', id: 'u' }, facts: { method: 'token', strategy: 'token', assurance: 'aal1', mfa: [] } }, p);
      expect(await withService(new TokenPrincipalResolver(), ok).resolve(r, { kind: 'bearer', token: 't' }, ctx)).to.eq(p);
      expect(ok.calls[0].ctx).to.deep.eq({ ...ctx, purpose: 'request' });
      const bad = service({ status: 'failure', reason: 'revoked' });
      expect(await withService(new KeyPrincipalResolver(), bad).resolve(r, { kind: 'http-signature', request: { method: 'GET', targetUri: 'x', headers: {} } }, ctx)).to.eq(null);
      const throttled = service({ status: 'failure', reason: 'throttled', retryAfterSeconds: 3 });
      expect(await withService(new TokenPrincipalResolver(), throttled).resolve(r, { kind: 'bearer', token: 't' }, ctx)).to.eq(null);
    });

    it('the session resolver answers undefined without a session and null for a pending one', async () => {
      const res = new SessionPrincipalResolver();
      expect(await res.resolve({ storage: {} } as Request, null, ctx)).to.eq(undefined);
      expect(await res.resolve({ storage: { AuthnSession: null } } as unknown as Request, null, ctx)).to.eq(undefined);
      const pending = { handle: { id: 'x', state: 'pending' } as SessionHandle, identity: { type: 'user', id: 'u' }, facts: FACTS(), data: new Map() };
      expect(await res.resolve({ storage: { AuthnSession: pending } } as unknown as Request, null, ctx)).to.eq(null);
    });

    it('M1 a session that yields nothing never asks the store about service or agent identities', async () => {
      const ended: IdentityRef[] = [];
      const asked: IdentityRef[] = [];
      const parts = new Map<unknown, unknown>([
        [IdentityStore, { status: async (id: IdentityRef) => (asked.push(id), id.type === 'user' ? { exists: true, active: true, banned: true, deleted: false } : Promise.reject(new Error('not a user'))) }],
      ]);
      const res = new SessionPrincipalResolver();
      Object.defineProperty(res, 'Container', {
        value: {
          resolve: async (t: unknown) => parts.get(t) ?? { principalOf: async () => null, endFor: async (id: IdentityRef) => (ended.push(id), 0) },
        },
      });
      const active = (identity: IdentityRef, impersonator?: IdentityRef) => ({ storage: { AuthnSession: { handle: { id: 'x', state: 'active' }, identity, facts: FACTS(impersonator ? { impersonator } : {}), data: new Map() } } }) as unknown as Request;
      expect(await res.resolve(active({ type: 'service', id: 's1' }, { type: 'agent', id: 'a1' }), null, ctx)).to.eq(null);
      expect(asked).to.deep.eq([]);
      expect(ended).to.deep.eq([]);
      expect(await res.resolve(active({ type: 'agent', id: 'a2' }, { type: 'user', id: 'u1' }), null, ctx)).to.eq(null);
      expect(asked).to.deep.eq([{ type: 'user', id: 'u1' }]);
      expect(ended).to.deep.eq([{ type: 'user', id: 'u1' }]);
    });
  });
});
