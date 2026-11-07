import 'mocha';
import { expect } from 'chai';
import { Configuration } from '@spinajs/configuration';
import { CONTROLLED_DESCRIPTOR_SYMBOL, MemoryThrottleStore, RateLimitMiddleware } from '@spinajs/http';
import type { IController, IControllerDescriptor, IMiddlewareContext, IRateLimitOptions, IRoute, Response } from '@spinajs/http';
import { AUTHN_FAILURE_BODY } from '@spinajs/authn/contracts';
import { appEnvOf } from '@spinajs/authn-session';
import { configurationViolations, createTestApp, disposeTestApps } from '@spinajs/testing';

import { OidcController } from '../src/controllers/OidcController.js';
import { OidcLogin } from '../src/login.js';
import type { OidcLoginDeps } from '../src/login.js';
import { AUTHN_OIDC_CONFIGURATION_SCHEMA, AUTHN_OIDC_RATE_LIMITS, AUTHN_OIDC_SESSION_RATE_LIMITS } from '../src/options/schema.js';
import { OidcThrottledResponse, oidcThrottled } from '../src/rate-limits.js';

const ROUTES = [
  ['begin', 'begin'],
  ['callback', 'callback'],
] as const;

function rateLimitsOf(method: string) {
  const descriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, OidcController.prototype) as IControllerDescriptor;
  const route = descriptor.Routes.get(method);
  if (!route) throw new Error(`OidcController.${method} is no route`);
  return route.Middlewares.filter((m) => m.Type === RateLimitMiddleware);
}

function mounted(options: IRateLimitOptions, configured: unknown) {
  const mw = new RateLimitMiddleware(options);
  // Own properties shadow the @Autoinject and @Config getters of the prototype.
  Object.defineProperty(mw, 'Store', { value: new MemoryThrottleStore() });
  Object.defineProperty(mw, 'Ipv6Prefix', { value: 64 });
  Object.defineProperty(mw, 'Configuration', { value: { get: (key: string) => (key === options.config ? configured : undefined) } });
  const set: string[] = [];
  const enabled = mw.isEnabled({} as IRoute, {} as IController);
  if (enabled) mw.onRegister({ InternalType: 'get' } as unknown as IRoute, '/auth/oidc/:provider');
  const call = () => mw.onBefore({ req: { socket: { remoteAddress: '192.0.2.9' } }, res: { set: (name: string) => set.push(name) }, storage: { realIp: '192.0.2.9' } } as unknown as IMiddlewareContext);
  return { mw, enabled, set, call };
}

const request = (headers: Record<string, string>) => ({ get: (name: string) => headers[name.toLowerCase()] });

describe('the shipped rate limits of the OIDC routes', () => {
  afterEach(disposeTestApps);

  for (const [method, name] of ROUTES) {
    it(`${method}: authn.oidc.rateLimit.${name}, 60 a minute per address, the failure answer, no X-RateLimit-*`, () => {
      const limits = rateLimitsOf(method);
      expect(limits).to.have.length(1);
      const options = limits[0].Options[0] as IRateLimitOptions;
      expect(options).to.include({ config: `authn.oidc.rateLimit.${name}`, headers: false, answer: oidcThrottled });
      expect(options.default).to.deep.eq({ limit: 60, windowSeconds: 60, by: 'ip' }).and.to.deep.eq(AUTHN_OIDC_RATE_LIMITS[name]);
    });
  }

  it('back-channel logout has no rate limit: the IdP sends one token per session, and a refused one leaves a session alive', () => {
    expect(rateLimitsOf('backchannelLogout')).to.deep.eq([]);
  });

  describe('the throttled answer', () => {
    const login = (failure: string, env?: string) => new OidcLogin({ redirects: { success: '/', failure }, env } as unknown as OidcLoginDeps);

    it('is what a throttled callback answers: 401 with the login failure body and Retry-After, the flow cookie cleared', async () => {
      const { set, call } = mounted(rateLimitsOf('callback')[0].Options[0] as IRateLimitOptions, { limit: 1 });
      expect(await call()).to.eq(undefined);
      const refused = (await call()) as Response;
      expect(refused).to.be.instanceOf(OidcThrottledResponse);
      const retryAfter = (refused as OidcThrottledResponse).retryAfterSeconds;
      expect(retryAfter).to.be.within(1, 60);
      const answer = (refused as OidcThrottledResponse).answerFor(request({ accept: 'application/json' }), undefined);
      expect(answer).to.deep.eq(login('/').failure({ navigation: false }, retryAfter));
      expect([answer.status, answer.body, answer.headers]).to.deep.eq([401, AUTHN_FAILURE_BODY, { 'retry-after': String(retryAfter) }]);
      expect(set, 'nothing set by the limiter').to.deep.eq([]);
    });

    it('sends a browser navigation to the configured failure page, as any OIDC failure', async () => {
      const { config } = await createTestApp({
        scope: 'child',
        bootstrap: false,
        schemas: [AUTHN_OIDC_CONFIGURATION_SCHEMA],
        config: { authn: { oidc: { redirects: { failure: '/signin-failed' } } } },
      });
      const answer = new OidcThrottledResponse(42).answerFor(request({ 'sec-fetch-mode': 'navigate' }), config as Configuration);
      expect(answer).to.deep.eq(login('/signin-failed', appEnvOf(config as Configuration)).failure({ navigation: true }, 42));
      expect([answer.status, answer.location, answer.headers]).to.deep.eq([303, '/signin-failed', { 'retry-after': '42' }]);
    });
  });

  describe('configuration', () => {
    const begin = () => rateLimitsOf('begin')[0].Options[0] as IRateLimitOptions;

    it('an override is merged over the default, false takes the limit off', () => {
      const { mw } = mounted(begin(), { limit: 600 });
      expect([mw.limit, mw.windowSeconds, mw.by]).to.deep.eq([600, 60, 'ip']);
      expect(mounted(begin(), false).enabled).to.eq(false);
      expect(mounted(begin(), undefined).mw.limit).to.eq(60);
    });

    it('the schema fills the defaults, takes false and refuses unknown names and settings', async function () {
      this.timeout(20000);
      const { config } = await createTestApp({ scope: 'child', bootstrap: false, schemas: [AUTHN_OIDC_CONFIGURATION_SCHEMA], config: {} });
      expect(config.get('authn.oidc.rateLimit')).to.deep.eq({ ...AUTHN_OIDC_RATE_LIMITS, ...AUTHN_OIDC_SESSION_RATE_LIMITS });
      const bad = (rateLimit: unknown) => configurationViolations({ schemas: [AUTHN_OIDC_CONFIGURATION_SCHEMA], config: { authn: { oidc: { rateLimit } } } });
      expect(await bad({ begin: false, callback: { limit: 300 } })).to.deep.eq([]);
      expect(await bad({ backchannelLogout: { limit: 10 } })).to.not.deep.eq([]);
      expect(await bad({ callback: { limt: 10 } })).to.not.deep.eq([]);
      expect(await bad({ callback: { by: 'principal', limit: -1 } })).to.not.deep.eq([]);
    });
  });
});
