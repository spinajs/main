import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import * as cs from 'cookie-signature';
import { DateTime } from 'luxon';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { BaseController, Controllers, HttpServer, ServerMiddleware } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthenticationStrategy, AuthnThrottle, IMPERSONATION_BLOCK, IdentityStore, ImpersonationGuard, PrincipalFactory, SessionIssuer } from '@spinajs/authn';
import type { AuthnFacts } from '@spinajs/authn';
import { DefaultSessionIssuer, MemorySessionStore, appEnvOf, sessionCookieName } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import { FakeIdentityStore, FakeImpersonationGuard, FakeStrategy, RecordingPrincipalFactory, RecordingThrottle } from '@spinajs/authn-testing';

import * as barrel from '../../src/index.js';
import { AuthnMiddleware } from '../../src/middleware/authn.js';
import { registerAuthnHttpV3 } from '../../src/v3/register.js';
import { AUTHN_PROBE_PATH } from './probe.js';
import { buildAuthnMiddlewareIn } from './authn-in-child.js';
import { COOKIE_SECRET, TestConfiguration, req, restoreHttpErrorMap, startHttpServer } from '../token-common.js';

class RestoreCountConfiguration extends TestConfiguration {
  protected onLoad(): unknown {
    const base = super.onLoad() as { http: Record<string, unknown>; authn: Record<string, unknown> };
    return {
      ...base,
      http: { ...base.http, middlewares: [express.json({ limit: '5mb' }), express.urlencoded({ extended: true }), cookieParser(COOKIE_SECRET)] },
      authn: { ...base.authn, strategies: [{ name: 'token', service: 'RestoreCountTokenStrategy' }] },
    };
  }
}

async function releaseHttpServer(): Promise<void> {
  await DI.get(HttpServer)?.stop();
  DI.uncache(HttpServer);
  DI.uncache(Controllers);
  for (const type of DI.getRegisteredTypes(BaseController) ?? []) DI.uncache(type);
  DI.uncache(BaseController);
}

function bind(child: IContainer, base: Class<unknown>, name: string, value: unknown): void {
  const factory = { [name]: () => value }[name];
  child.register(factory).as(base);
}

const FACTS = (over: Partial<AuthnFacts> = {}): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal2', mfa: ['totp'], authenticatedAt: new Date(), ...over });

describe('one SessionIssuer.restore per authenticated cookie request (PERF-1)', function () {
  this.timeout(60000);

  let child: IContainer;
  let identities: FakeIdentityStore;
  let issuer: DefaultSessionIssuer;
  let authnInChild: sinon.SinonStub | undefined;
  let cookieName: string;

  const cookieOf = (rawId: string) => `${cookieName}=${encodeURIComponent(cs.sign(rawId, COOKIE_SECRET))}`;

  async function probe(rawId: string) {
    const res = await req().get(AUTHN_PROBE_PATH).set('Accept', 'application/json').set('Cookie', cookieOf(rawId));
    expect(res.status, JSON.stringify(res.body)).to.eq(200);
    return res.body as { principal: { id: string; authn?: { impersonator?: unknown } } | null };
  }

  before(async () => {
    DI.setESMModuleSupport();
    restoreHttpErrorMap();

    DI.unregister(RestoreCountConfiguration);
    DI.register(RestoreCountConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) await b.bootstrap();

    const config = await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Orm);

    child = DI.RootContainer.child();
    identities = new FakeIdentityStore();
    const store = new MemorySessionStore();
    const sixty = () => DateTime.now().plus({ minutes: 60 });
    Object.defineProperty(store, 'Expiration', { value: { initial: sixty, renew: sixty } });
    issuer = new DefaultSessionIssuer();
    Object.defineProperty(issuer, 'Store', { value: store });
    Object.defineProperty(issuer, 'PendingTtlSeconds', { value: 300 });
    Object.defineProperty(issuer, 'Container', { value: child });
    bind(child, IdentityStore, 'RestoreCountIdentityStore', identities);
    bind(child, PrincipalFactory, 'RestoreCountPrincipalFactory', new RecordingPrincipalFactory());
    bind(child, ImpersonationGuard, 'RestoreCountImpersonationGuard', new FakeImpersonationGuard());
    bind(child, SessionIssuer, 'RestoreCountSessionIssuer', issuer);
    bind(child, AuthnThrottle, 'MemoryAuthnThrottle', new RecordingThrottle());
    bind(
      child,
      AuthenticationStrategy,
      'RestoreCountTokenStrategy',
      new FakeStrategy({ name: 'token', kinds: ['bearer'], interactive: false, keys: () => [{ kind: 'account', value: 'token' }], verify: () => ({ ok: false, reason: 'invalid_credentials' }) }),
    );
    await registerAuthnHttpV3(child);

    authnInChild = buildAuthnMiddlewareIn(child);
    cookieName = sessionCookieName(config.get<ISessionCookieConfig>('authn.session.cookie', {}), appEnvOf(config));
    DI.uncache(AuthnMiddleware);
    DI.uncache(barrel.CsrfOriginGuard);
    DI.uncache(barrel.ClientIp);
    DI.uncache(ServerMiddleware);
    await DI.resolve(Controllers);
    await startHttpServer();
  });

  afterEach(() => sinon.restore());

  after(async () => {
    await releaseHttpServer();
    authnInChild?.restore();
    DI.uncache(AuthnMiddleware);
    DI.uncache(barrel.CsrfOriginGuard);
    DI.uncache(barrel.ClientIp);
    DI.uncache(ServerMiddleware);
    await child?.dispose();
    DI.unregister(RestoreCountConfiguration);
    DI.uncache(RestoreCountConfiguration);
    DI.uncache(Configuration);
    DI.uncache(Orm);
  });

  it('an own session: AuthnMiddleware and SessionPrincipalResolver restore it once', async () => {
    const alice = identities.add({ login: `alice-${randomUUID()}` });
    const h = await issuer.issue(alice, FACTS());
    const restore = sinon.spy(issuer, 'restore');

    const body = await probe(h.id);
    expect(body.principal?.id).to.eq(alice.id);
    expect(restore.callCount).to.eq(1);
  });

  it('an impersonation session: restored once, the impersonation still checked', async () => {
    const alice = identities.add({ login: `alice-${randomUUID()}` });
    const bob = identities.add({ login: `bob-${randomUUID()}` });
    const h = await issuer.issue(bob, FACTS({ impersonator: alice }));
    await issuer.set(h, IMPERSONATION_BLOCK, { startedAt: new Date().toISOString() });
    const restore = sinon.spy(issuer, 'restore');

    const body = await probe(h.id);
    expect(body.principal?.id).to.eq(bob.id);
    expect(body.principal?.authn?.impersonator).to.deep.eq({ type: 'user', id: alice.id });
    expect(restore.callCount).to.eq(1);
  });
});
