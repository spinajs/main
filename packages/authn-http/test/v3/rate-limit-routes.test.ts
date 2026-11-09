import 'mocha';
import { createHash, createHmac } from 'node:crypto';
import { expect } from 'chai';
import { BotCheckMiddleware, CONTROLLED_DESCRIPTOR_SYMBOL, MemoryThrottleStore, RateLimitMiddleware } from '@spinajs/http';
import type { IController, IControllerDescriptor, IMiddlewareContext, IRateLimitOptions, IRoute, Response } from '@spinajs/http';
import { InvalidOption } from '@spinajs/exceptions';
import { HTTP_CONFIGURATION_SCHEMA } from '@spinajs/http';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import { AUTHN_SESSION_CONFIGURATION_SCHEMA } from '@spinajs/authn-session';
import { configurationViolations, createTestApp, disposeTestApps } from '@spinajs/testing';

import { AUTHN_FAILURE_BODY, AUTHN_HTTP_CONFIGURATION_SCHEMA, AUTHN_HTTP_RATE_LIMITS, AUTHN_HTTP_SESSION_RATE_LIMITS, pendingSessionKey, pendingSessionKeyOf } from '../../src/index.js';

const SECRET = 'unit-' + 'Zx8q'.repeat(10);
import type { AuthnHttpRateLimitName } from '../../src/index.js';
import { AuthnIpThrottleMiddleware } from '../../src/middleware/ip-throttle.js';
import { passkeyChallengeThrottled } from '../../src/password/fields.js';
import { AuthnCodeLoginController } from '../../src/v3/controllers/AuthnCodeLoginController.js';
import { AuthnJwksController } from '../../src/v3/controllers/AuthnJwksController.js';
import { AuthnKeysController } from '../../src/v3/controllers/AuthnKeysController.js';
import { AuthnLoginController } from '../../src/v3/controllers/AuthnLoginController.js';
import { AuthnPasskeyController } from '../../src/v3/controllers/AuthnPasskeyController.js';
import { AuthnPasswordController } from '../../src/v3/controllers/AuthnPasswordController.js';
import { AuthnRegistrationController } from '../../src/v3/controllers/AuthnRegistrationController.js';
import { AuthnTokenRevocationController } from '../../src/v3/controllers/AuthnTokenRevocationController.js';
import { AuthnVerificationController } from '../../src/v3/controllers/AuthnVerificationController.js';

type ControllerClass = abstract new (...args: never[]) => object;
type ThrottledAnswer = (retryAfterSeconds: number) => Response;

const ROUTES: [ControllerClass, string, string, AuthnHttpRateLimitName][] = [
  [AuthnLoginController, 'login', '/auth/login', 'login'],
  [AuthnCodeLoginController, 'login', '/auth/code/login', 'codeLogin'],
  [AuthnKeysController, 'login', '/auth/keys/login', 'keysLogin'],
  [AuthnPasskeyController, 'login', '/auth/passkeys/login', 'passkeysLogin'],
  [AuthnKeysController, 'challenge', '/auth/keys/challenge', 'keysChallenge'],
  [AuthnPasskeyController, 'challenge', '/auth/passkeys/challenge', 'passkeysChallenge'],
  [AuthnCodeLoginController, 'request', '/auth/code/request', 'codeRequest'],
  [AuthnPasswordController, 'requestReset', '/auth/password/reset-request', 'passwordResetRequest'],
  [AuthnPasswordController, 'reset', '/auth/password/reset', 'passwordReset'],
  [AuthnVerificationController, 'verify', '/auth/verify', 'verify'],
  [AuthnRegistrationController, 'register', '/auth/register', 'register'],
];

const UNLIMITED: [ControllerClass, string][] = [
  [AuthnTokenRevocationController, 'revoke'],
  [AuthnLoginController, 'logout'],
  [AuthnLoginController, 'whoami'],
  [AuthnPasswordController, 'policy'],
  [AuthnJwksController, 'jwks'],
];

function middlewaresOf(controller: ControllerClass, method: string) {
  const descriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, controller.prototype) as IControllerDescriptor;
  const route = descriptor.Routes.get(method);
  if (!route) throw new Error(`${controller.name}.${method} is no route`);
  return route.Middlewares;
}

function rateLimitOf(controller: ControllerClass, method: string): IRateLimitOptions {
  const entries = middlewaresOf(controller, method).filter((m) => m.Type === RateLimitMiddleware);
  expect(entries, `${controller.name}.${method}`).to.have.length(1);
  return entries[0].Options[0] as IRateLimitOptions;
}

/** The answer the route's own throttle gives: its IpThrottle's, or the passkey challenge's controller attempt. */
function existingAnswerOf(controller: ControllerClass, method: string): ThrottledAnswer {
  if (controller === AuthnPasskeyController && method === 'challenge') return passkeyChallengeThrottled;
  const ipt = middlewaresOf(controller, method).filter((m) => m.Type === AuthnIpThrottleMiddleware);
  expect(ipt, `${controller.name}.${method} IpThrottle`).to.have.length(1);
  return ipt[0].Options[1] as ThrottledAnswer;
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly headers: { Name: string; Value: unknown }[];
}

function answerOf(res: Response): Answer {
  const r = res as unknown as { _errorCode: number; responseData: unknown; options?: { Headers?: { Name: string; Value: unknown }[] } };
  return { status: r._errorCode, body: r.responseData, headers: r.options?.Headers ?? [] };
}

function inject(mw: RateLimitMiddleware, get: (key: string) => unknown): void {
  // Own properties shadow the @Autoinject and @Config getters of the prototype.
  Object.defineProperty(mw, 'Store', { value: new MemoryThrottleStore() });
  Object.defineProperty(mw, 'Ipv6Prefix', { value: 64 });
  Object.defineProperty(mw, 'Configuration', { value: { get } });
}

/** A mounted RateLimitMiddleware of `options` reading `configured` at `options.config`, and the headers it sets. */
function mounted(options: IRateLimitOptions, path: string, configured: unknown) {
  const mw = new RateLimitMiddleware(options);
  inject(mw, (key) => (key === options.config ? configured : undefined));
  const set: string[] = [];
  const enabled = mw.isEnabled({} as IRoute, {} as IController);
  if (enabled) mw.onRegister({ InternalType: 'post' } as unknown as IRoute, path);
  const call = (storage: object = {}) =>
    mw.onBefore({ req: { socket: { remoteAddress: '192.0.2.9' } }, res: { set: (name: string) => set.push(name) }, storage: { realIp: '192.0.2.9', ...storage } } as unknown as IMiddlewareContext);
  return { mw, enabled, set, call };
}

describe('the shipped rate limits of the anonymous authn routes', () => {
  afterEach(disposeTestApps);

  describe('every anonymous route', () => {
    for (const [controller, method, path, name] of ROUTES) {
      it(`${path}: authn.http.rateLimit.${name}, its default, the route's own answer and no X-RateLimit-*`, () => {
        const options = rateLimitOf(controller, method);
        expect(options).to.include({ config: `authn.http.rateLimit.${name}`, headers: false });
        expect(options.default).to.deep.eq(AUTHN_HTTP_RATE_LIMITS[name]);
        expect(options.answer, 'the answer of the route throttle').to.eq(existingAnswerOf(controller, method));
        expect(options.key).to.eq(name === 'passkeysChallenge' ? pendingSessionKey : undefined);
      });
    }

    it('ships the numbers of the adoption plan, all per client address', () => {
      const shipped = Object.fromEntries(Object.entries(AUTHN_HTTP_RATE_LIMITS).map(([n, s]) => [n, `${s.limit}/${s.windowSeconds} ${s.by}`]));
      expect(shipped).to.deep.eq({
        login: '30/60 ip',
        codeLogin: '30/60 ip',
        keysLogin: '30/60 ip',
        passkeysLogin: '30/60 ip',
        keysChallenge: '30/60 ip',
        passkeysChallenge: '30/60 ip',
        codeRequest: '10/600 ip',
        passwordResetRequest: '10/600 ip',
        passwordReset: '10/600 ip',
        verify: '20/600 ip',
        register: '10/3600 ip',
      });
    });

    it("runs in the 'outer' stage, so it refuses before the bot check and the IP throttle spend anything", () => {
      expect(new RateLimitMiddleware({ limit: 1, windowSeconds: 1 }).Stage).to.eq('outer');
      for (const [controller, method] of ROUTES) {
        for (const m of middlewaresOf(controller, method).filter((x) => x.Type === BotCheckMiddleware || x.Type === AuthnIpThrottleMiddleware)) {
          expect((m.Type as unknown as { prototype: { Stage?: string } }).prototype.Stage, `${controller.name}.${method} ${m.Type.name}`).to.not.eq('outer');
        }
      }
    });

    for (const [controller, method] of UNLIMITED) {
      it(`${controller.name}.${method} has no limit of its own`, () => {
        expect(middlewaresOf(controller, method).filter((m) => m.Type === RateLimitMiddleware)).to.deep.eq([]);
      });
    }
  });

  describe('the throttled answer', () => {
    for (const [controller, method, path, name] of ROUTES) {
      it(`${path}: the route's existing answer (status, body, Retry-After, no-store) and no header set by the limiter`, async () => {
        const options = rateLimitOf(controller, method);
        const { set, call } = mounted(options, path, { limit: 1 });
        expect(await call()).to.eq(undefined);
        const refused = await call();
        expect(refused, `${name} refuses the second request`).to.not.eq(undefined);
        const got = answerOf(refused as Response);
        const retryAfter = Number(got.headers.find((h) => h.Name === 'Retry-After')?.Value);
        expect(retryAfter).to.be.within(1, AUTHN_HTTP_RATE_LIMITS[name].windowSeconds);
        expect(got).to.deep.eq(answerOf(existingAnswerOf(controller, method)(retryAfter)));
        expect(got.headers.map((h) => h.Name)).to.include('Cache-Control');
        expect(set, 'no X-RateLimit-* nor Retry-After on res').to.deep.eq([]);
      });
    }

    it('login answers the uniform 401 failure body; the others their 429 throttled body', async () => {
      const login = answerOf(rateLimitOf(AuthnLoginController, 'login').answer!(60));
      expect([login.status, login.body]).to.deep.eq([401, AUTHN_FAILURE_BODY]);
      const register = answerOf(rateLimitOf(AuthnRegistrationController, 'register').answer!(60));
      expect([register.status, register.body]).to.deep.eq([429, { error: 'throttled', message: 'too many registrations, try again later' }]);
    });
  });

  describe('configuration', () => {
    const login = () => rateLimitOf(AuthnLoginController, 'login');

    it('an unset key keeps the shipped default', () => {
      const { mw, enabled } = mounted(login(), '/auth/login', undefined);
      expect(enabled).to.eq(true);
      expect([mw.limit, mw.windowSeconds, mw.by]).to.deep.eq([30, 60, 'ip']);
    });

    it('a configured value is merged over the default', () => {
      const { mw } = mounted(login(), '/auth/login', { limit: 100 });
      expect([mw.limit, mw.windowSeconds, mw.by]).to.deep.eq([100, 60, 'ip']);
    });

    it('false takes the limit off the route: not mounted, nothing counted', async () => {
      const { enabled } = mounted(login(), '/auth/login', false);
      expect(enabled).to.eq(false);
    });

    it('a wrong configured value fails the route registration naming the key', () => {
      const mw = new RateLimitMiddleware(login());
      inject(mw, () => ({ limit: 'many' }));
      expect(() => mw.onRegister({ InternalType: 'post' } as unknown as IRoute, '/auth/login')).to.throw(InvalidOption, 'authn.http.rateLimit.login.limit');
    });

    it('a configured headers fails the route registration: the route locks X-RateLimit-* off', () => {
      const mw = new RateLimitMiddleware(login());
      inject(mw, () => ({ headers: true }));
      expect(() => mw.onRegister({ InternalType: 'post' } as unknown as IRoute, '/auth/login')).to.throw(InvalidOption, 'unknown keys headers');
    });

    it('counts a pending session on an HMAC of its id, apart from the address', async () => {
      const options = { ...rateLimitOf(AuthnPasskeyController, 'challenge'), key: (ctx: IMiddlewareContext) => pendingSessionKeyOf(ctx, SECRET) };
      const { call } = mounted(options, '/auth/passkeys/challenge', { limit: 1 });
      const pending = (id: string) => ({ AuthnSession: { handle: { id, state: 'pending' } } });
      expect(await call(pending('raw-session-a'))).to.eq(undefined);
      expect(await call(pending('raw-session-b')), 'another pending session').to.eq(undefined);
      expect(await call(), 'the anonymous address').to.eq(undefined);
      expect(await call(pending('raw-session-a')), 'the same pending session').to.not.eq(undefined);
    });

    it('the pending-session key is a domain-separated HMAC under the secret, never the session store key; no secret counts by address', () => {
      const ctx = (state: string) => ({ storage: { AuthnSession: { handle: { id: 'raw-session-a', state } } } }) as unknown as IMiddlewareContext;
      const key = pendingSessionKeyOf(ctx('pending'), SECRET);
      expect(key).to.eq('pending:' + createHmac('sha256', SECRET).update('spinajs.authn-http.rate-limit.pending-session\0raw-session-a').digest('hex'));
      expect(key).to.not.include(createHash('sha256').update('raw-session-a').digest('hex'));
      expect(pendingSessionKeyOf(ctx('pending'), 'another-secret')).to.not.eq(key);
      expect(pendingSessionKeyOf(ctx('active'), SECRET)).to.eq(undefined);
      expect(pendingSessionKeyOf(ctx('pending'), undefined)).to.eq(undefined);
      expect(pendingSessionKeyOf(ctx('pending'), '')).to.eq(undefined);
    });
  });

  describe('schema', function () {
    this.timeout(20000);
    const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, AUTHN_HTTP_CONFIGURATION_SCHEMA, AUTHN_SESSION_CONFIGURATION_SCHEMA, HTTP_CONFIGURATION_SCHEMA];
    const bad = (rateLimit: unknown) => configurationViolations({ schemas: SCHEMAS, config: { authn: { http: { rateLimit } } } });

    it('fills every shipped default', async () => {
      const { config } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {} });
      expect(config.get('authn.http.rateLimit')).to.deep.eq({ ...AUTHN_HTTP_RATE_LIMITS, ...AUTHN_HTTP_SESSION_RATE_LIMITS });
    });

    it('takes false, a partial override and a full one', async () => {
      expect(await bad({ login: false, register: { limit: 50 }, verify: { limit: 5, windowSeconds: 30, by: 'ip' } })).to.deep.eq([]);
    });

    for (const [label, value] of [
      ['an unknown route name', { logn: false }],
      ['an unknown setting', { login: { limt: 5 } }],
      ['a negative limit', { login: { limit: -1 } }],
      ['a zero window', { login: { windowSeconds: 0 } }],
      ['an unknown key kind', { login: { by: 'session' } }],
      ['true', { login: true }],
      ['headers, locked off by the route', { login: { headers: true } }],
    ] as const) {
      it(`refuses ${label}`, async () => {
        expect(await bad(value)).to.not.deep.eq([]);
      });
    }
  });
});
