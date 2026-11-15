import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';
import { HTTP_CONFIGURATION_SCHEMA, MemoryThrottleStore, RateLimitMiddleware, RealIp, ServerMiddleware, ThrottleMiddleware, isTrustedPeer, requestProxyTrust } from '@spinajs/http';
import type { IMiddlewareContext, IRoute, ProxyTrust } from '@spinajs/http';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import { createTestApp, disposeTestApps, readingFrom } from '@spinajs/testing';
import { DataValidator } from '@spinajs/validation';

import { AUTHN_HTTP_CONFIGURATION_SCHEMA, AuthnRealIp, ClientIp, realIpOverrideFinding } from '../../src/index.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, AUTHN_HTTP_CONFIGURATION_SCHEMA, HTTP_CONFIGURATION_SCHEMA];
const PROXY = '10.0.0.5';

type Storage = { realIp?: string; ClientIp?: string; proxyTrust?: ProxyTrust };
type FakeReq = { method: string; path: string; headers: Record<string, string>; socket: { remoteAddress: string }; storage: Storage };

const reqFrom = (peer: string, xff?: string): FakeReq => ({ method: 'POST', path: '/auth/login', headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: peer }, storage: {} });
const ctxOf = (req: FakeReq) => ({ req, res: { set: () => undefined }, storage: req.storage }) as unknown as IMiddlewareContext;

async function appWith(config: Record<string, unknown>): Promise<IContainer> {
  return (await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config })).container;
}

/** AuthnRealIp then ClientIp, as the server runs them. */
async function addressChain(container: IContainer): Promise<(req: FakeReq) => Storage> {
  const realIp = readingFrom(new AuthnRealIp(), container);
  await realIp.resolve();
  const clientIp = readingFrom(new ClientIp(), container);
  return (req) => {
    realIp.onBefore(ctxOf(req));
    clientIp.onBefore(ctxOf(req));
    return req.storage;
  };
}

/** The status a limiter answers; 200 when it lets the request through. */
async function statusOf(answer: unknown): Promise<number> {
  const a = await answer;
  return a ? (a as { statusCode: number }).statusCode : 200;
}

describe('one client address: authn.http.trustProxy feeds RealIp', function () {
  this.timeout(20000);
  afterEach(disposeTestApps);

  it('is registered over RealIp, and runs before ClientIp', () => {
    const overrides = DI.getRegisteredTypes(RealIp) ?? [];
    expect(overrides[overrides.length - 1]).to.eq(AuthnRealIp);
    expect(DI.getRegisteredTypes(ServerMiddleware)).to.include(RealIp);
    expect(new AuthnRealIp().Order).to.be.lessThan(new ClientIp().Order);
  });

  it('with authn.http.trustProxy alone, realIp, ClientIp and the stored trust name the client behind the proxy', async () => {
    const run = await addressChain(await appWith({ authn: { http: { trustProxy: ['10.0.0.0/8'] } } }));
    const req = reqFrom(PROXY, '203.0.113.7');
    const storage = run(req);
    expect(storage.realIp).to.eq('203.0.113.7');
    expect(storage.ClientIp).to.eq(storage.realIp);
    expect(isTrustedPeer(requestProxyTrust(req), PROXY)).to.eq(true);
  });

  it('falls back to http.trustProxy; authn.http.trustProxy 0 trusts no proxy over it', async () => {
    expect((await addressChain(await appWith({ http: { trustProxy: 1 } })))(reqFrom(PROXY, '203.0.113.7')).ClientIp).to.eq('203.0.113.7');
    const none = (await addressChain(await appWith({ authn: { http: { trustProxy: 0 } }, http: { trustProxy: 1 } })))(reqFrom(PROXY, '203.0.113.7'));
    expect([none.realIp, none.ClientIp]).to.deep.eq([PROXY, PROXY]);
  });

  it('a bad authn.http.trustProxy or http.trustProxy fails when it is resolved, naming the key', async () => {
    const failure = async (config: Record<string, unknown>) =>
      readingFrom(new AuthnRealIp(), await appWith(config))
        .resolve()
        .then(
          () => undefined,
          (e: unknown) => e,
        );
    expect(await failure({ authn: { http: { trustProxy: ['10.0.0.0/33'] } } }))
      .to.be.instanceOf(InvalidOption)
      .with.property('message')
      .that.contains('authn.http.trustProxy');
    expect(await failure({ http: { trustProxy: 'nope' } }))
      .to.be.instanceOf(InvalidOption)
      .with.property('message')
      .that.contains('http.trustProxy');
  });

  it('ClientIp reads no trust of its own: without RealIp it is the socket address', async () => {
    const clientIp = readingFrom(new ClientIp(), await appWith({ authn: { http: { trustProxy: 1 } } }));
    const req = reqFrom('::ffff:10.0.0.5', '203.0.113.7');
    clientIp.onBefore(ctxOf(req));
    expect(req.storage.ClientIp).to.eq(PROXY);
  });

  it('ClientIp copies realIp a RealIp subclass wrote without the stored trust', async () => {
    const clientIp = readingFrom(new ClientIp(), await appWith({}));
    const req = reqFrom(PROXY, '203.0.113.7');
    req.storage.realIp = '203.0.113.9';
    clientIp.onBefore(ctxOf(req));
    expect(req.storage.ClientIp).to.eq('203.0.113.9');
  });

  describe('realIpOverrideFinding', () => {
    class AppRealIp extends RealIp {}
    class AppAuthnRealIp extends AuthnRealIp {}
    const over = (...types: unknown[]) => ({ getRegisteredTypes: () => types }) as unknown as IContainer;

    it('says nothing for AuthnRealIp or a subclass of it, nor when AuthnRealIp was never registered', () => {
      expect(realIpOverrideFinding(over(RealIp, AuthnRealIp), 1)).to.eq(undefined);
      expect(realIpOverrideFinding(over(RealIp, AuthnRealIp, AppAuthnRealIp), 1)).to.eq(undefined);
      expect(realIpOverrideFinding(over(RealIp, AppRealIp), 1)).to.eq(undefined);
    });

    it('warns for another RealIp, and is an error when authn.http.trustProxy is set', () => {
      const warning = realIpOverrideFinding(over(RealIp, AuthnRealIp, AppRealIp), null);
      expect(warning).to.include({ topic: 'proxy', level: 'warning' });
      expect(warning!.message).to.contain('AppRealIp').and.contain('AuthnRealIp');
      expect(realIpOverrideFinding(over(RealIp, AuthnRealIp, AppRealIp), 0)).to.include({ level: 'error' });
    });
  });

  describe('report §3.2: an app behind a proxy that sets only authn.http.trustProxy', () => {
    const config = { authn: { http: { trustProxy: 1 } }, http: { throttle: { enabled: true, rules: [{ path: '/auth', methods: ['POST'], limit: 1, windowSeconds: 60 }] } } };

    it('http.throttle counts each client behind the proxy, not the proxy', async () => {
      const container = await appWith(config);
      const run = await addressChain(container);
      const throttle = readingFrom(new ThrottleMiddleware(), container);
      Object.defineProperty(throttle, 'Store', { value: new MemoryThrottleStore() });
      Object.defineProperty(throttle, 'Log', { value: { warn: () => undefined } });
      const hit = async (client: string) => {
        const req = reqFrom(PROXY, client);
        run(req);
        return statusOf(throttle.onBefore(ctxOf(req)));
      };
      expect([await hit('203.0.113.1'), await hit('203.0.113.2'), await hit('203.0.113.1')]).to.deep.eq([200, 200, 429]);
    });

    it('@RateLimit counts each client behind the proxy, not the proxy', async () => {
      const container = await appWith(config);
      const run = await addressChain(container);
      const limit = readingFrom(new RateLimitMiddleware(1, 60), container);
      Object.defineProperty(limit, 'Store', { value: new MemoryThrottleStore() });
      Object.defineProperty(limit, 'Validator', { value: await container.resolve(DataValidator) });
      limit.onRegister({ InternalType: 'post' } as unknown as IRoute, '/auth/login');
      const hit = async (client: string) => {
        const req = reqFrom(PROXY, client);
        run(req);
        return statusOf(limit.onBefore(ctxOf(req)));
      };
      expect([await hit('203.0.113.1'), await hit('203.0.113.2'), await hit('203.0.113.1')]).to.deep.eq([200, 200, 429]);
    });
  });
});
