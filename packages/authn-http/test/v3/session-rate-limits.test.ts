import 'mocha';
import { createHash, createHmac } from 'node:crypto';
import { expect } from 'chai';
import sinon from 'sinon';
import { Configuration } from '@spinajs/configuration';
import { CONTROLLED_DESCRIPTOR_SYMBOL, HTTP_CONFIGURATION_SCHEMA, MemoryThrottleStore, RateLimitMiddleware } from '@spinajs/http';
import type { IController, IControllerDescriptor, IMiddlewareContext, IRateLimitOptions, IRateLimitSettings, IRoute, Response } from '@spinajs/http';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import { AUTHN_FAILURE_BODY } from '@spinajs/authn/contracts';
import { createTestApp, disposeTestApps, readingFrom } from '@spinajs/testing';
import { DataValidator } from '@spinajs/validation';

import { AUTHN_HTTP_CONFIGURATION_SCHEMA, AUTHN_HTTP_SESSION_RATE_LIMITS, pendingSessionKey, pendingSessionKeyOf } from '../../src/index.js';
import { AuthnActiveRoleController } from '../../src/v3/controllers/AuthnActiveRoleController.js';
import { AuthnCredentialAdminController } from '../../src/v3/controllers/AuthnCredentialAdminController.js';
import { AuthnImpersonationController } from '../../src/v3/controllers/AuthnImpersonationController.js';
import { AuthnKeysController } from '../../src/v3/controllers/AuthnKeysController.js';
import { AuthnMfaController } from '../../src/v3/controllers/AuthnMfaController.js';
import { AuthnMfaEnrolmentController } from '../../src/v3/controllers/AuthnMfaEnrolmentController.js';
import { AuthnPasskeyController } from '../../src/v3/controllers/AuthnPasskeyController.js';
import { AuthnPasswordController } from '../../src/v3/controllers/AuthnPasswordController.js';
import { AuthnReauthController } from '../../src/v3/controllers/AuthnReauthController.js';
import { AuthnSessionsController } from '../../src/v3/controllers/AuthnSessionsController.js';
import { AuthnTokensController } from '../../src/v3/controllers/AuthnTokensController.js';
import { AuthnVerificationController } from '../../src/v3/controllers/AuthnVerificationController.js';

type Name = keyof typeof AUTHN_HTTP_SESSION_RATE_LIMITS;
type Ctor = abstract new (...args: never[]) => unknown;

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, AUTHN_HTTP_CONFIGURATION_SCHEMA, HTTP_CONFIGURATION_SCHEMA];

const ROUTES: [Ctor, string, Name, IRateLimitSettings][] = [
  [AuthnMfaController, 'verify', 'mfaVerify', { limit: 10, windowSeconds: 300, by: 'ip' }],
  [AuthnMfaController, 'recovery', 'mfaVerify', { limit: 10, windowSeconds: 300, by: 'ip' }],
  [AuthnMfaController, 'challenge', 'mfaChallenge', { limit: 5, windowSeconds: 600, by: 'ip' }],
  [AuthnMfaController, 'stepUp', 'mfaStepUp', { limit: 10, windowSeconds: 300, by: 'principal' }],
  [AuthnReauthController, 'reauth', 'reauth', { limit: 10, windowSeconds: 300, by: 'principal' }],
  [AuthnActiveRoleController, 'switch', 'activeRole', { limit: 20, windowSeconds: 60, by: 'principal' }],
  [AuthnImpersonationController, 'start', 'impersonate', { limit: 10, windowSeconds: 600, by: 'principal' }],
  [AuthnPasswordController, 'change', 'passwordChange', { limit: 10, windowSeconds: 600, by: 'principal' }],
  [AuthnVerificationController, 'request', 'verifyRequest', { limit: 5, windowSeconds: 3600, by: 'principal' }],
  [AuthnTokensController, 'create', 'tokens', { limit: 20, windowSeconds: 600, by: 'principal' }],
  [AuthnTokensController, 'rotate', 'tokens', { limit: 20, windowSeconds: 600, by: 'principal' }],
  [AuthnKeysController, 'register', 'keys', { limit: 20, windowSeconds: 600, by: 'principal' }],
  [AuthnPasskeyController, 'options', 'passkeys', { limit: 20, windowSeconds: 600, by: 'principal' }],
  [AuthnPasskeyController, 'register', 'passkeys', { limit: 20, windowSeconds: 600, by: 'principal' }],
  [AuthnMfaEnrolmentController, 'begin', 'mfaEnrolment', { limit: 10, windowSeconds: 600, by: 'principal' }],
  [AuthnMfaEnrolmentController, 'confirm', 'mfaEnrolment', { limit: 10, windowSeconds: 600, by: 'principal' }],
  [AuthnMfaEnrolmentController, 'disable', 'mfaEnrolment', { limit: 10, windowSeconds: 600, by: 'principal' }],
  [AuthnMfaEnrolmentController, 'recoveryCodes', 'mfaEnrolment', { limit: 10, windowSeconds: 600, by: 'principal' }],
  [AuthnCredentialAdminController, 'passwordReset', 'adminPasswordReset', { limit: 30, windowSeconds: 600, by: 'principal' }],
  [AuthnCredentialAdminController, 'mfaReset', 'adminCredentials', { limit: 60, windowSeconds: 600, by: 'principal' }],
  [AuthnCredentialAdminController, 'sessions', 'adminCredentials', { limit: 60, windowSeconds: 600, by: 'principal' }],
  [AuthnCredentialAdminController, 'tokens', 'adminCredentials', { limit: 60, windowSeconds: 600, by: 'principal' }],
];

// Own data, cheap: no limit (adoption report §2).
const UNLIMITED: [Ctor, string][] = [
  [AuthnActiveRoleController, 'state'],
  [AuthnImpersonationController, 'state'],
  [AuthnImpersonationController, 'stop'],
  [AuthnTokensController, 'list'],
  [AuthnTokensController, 'revoke'],
  [AuthnTokensController, 'update'],
  [AuthnKeysController, 'list'],
  [AuthnKeysController, 'revoke'],
  [AuthnPasskeyController, 'list'],
  [AuthnPasskeyController, 'remove'],
  [AuthnMfaEnrolmentController, 'status'],
  [AuthnSessionsController, 'list'],
];

const CONTROLLER = {} as IController;
const COOKIE_SECRET = 'rate-limit-' + 'Zq8Lw2Rt'.repeat(6);
const ALICE = { type: 'user', id: 'alice', authenticated: true, source: 'session', attributes: {} };
const BOB = { type: 'user', id: 'bob', authenticated: true, source: 'session', attributes: {} };

function routeOf(controller: Ctor, method: string): IRoute {
  const descriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, controller.prototype) as IControllerDescriptor;
  const route = descriptor.Routes.get(method);
  if (!route) throw new Error(`${controller.name}.${method} is not a route`);
  return route;
}

function limitsOf(controller: Ctor, method: string): IRateLimitOptions[] {
  return routeOf(controller, method)
    .Middlewares.filter((m) => m.Type === RateLimitMiddleware)
    .map((m) => m.Options[0] as IRateLimitOptions);
}

interface Hit {
  readonly passed: boolean;
  readonly status?: number;
  readonly body?: unknown;
  /** What the middleware set on express's response. */
  readonly set: Record<string, string>;
  /** What the answer carries itself. */
  readonly own: Record<string, string>;
}

interface Mounted {
  readonly mw: RateLimitMiddleware;
  readonly store: MemoryThrottleStore;
  hit(storage: Record<string, unknown>): Promise<Hit>;
}

/** The route's RateLimitMiddleware as the server mounts it, against `config` checked by the shipped schemas. */
async function mounted(controller: Ctor, method: string, config: Record<string, unknown> = {}): Promise<Mounted> {
  const [declared] = limitsOf(controller, method);
  // pendingSessionKey reads http.cookie.secret from the root container; a child test app has none there.
  const options = declared.key === pendingSessionKey ? { ...declared, key: (ctx: IMiddlewareContext) => pendingSessionKeyOf(ctx, COOKIE_SECRET) } : declared;
  const { container } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config });
  const store = new MemoryThrottleStore();
  const mw = readingFrom(new RateLimitMiddleware(options), container);
  Object.defineProperty(mw, 'Store', { value: store });
  Object.defineProperty(mw, 'Configuration', { value: await container.resolve(Configuration) });
  Object.defineProperty(mw, 'Validator', { value: await container.resolve(DataValidator) });
  const route = routeOf(controller, method);
  if (mw.isEnabled(route, CONTROLLER)) await mw.onRegister(route, `/${method}`);

  const hit = async (storage: Record<string, unknown>): Promise<Hit> => {
    const set: Record<string, string> = {};
    const res = {
      set(name: string, value: string) {
        set[name] = value;
        return this;
      },
    };
    const answer = (await mw.onBefore({ req: { socket: {}, params: {} } as never, res: res as never, storage: storage as never })) as Response | undefined;
    if (!answer) return { passed: true, set, own: {} };
    return { passed: false, status: answer.statusCode, body: answer.data, set, own: Object.fromEntries(answer.headers.map((h) => [h.Name, String(h.Value)])) };
  };
  return { mw, store, hit };
}

async function exhaust(m: Mounted, limit: number, storage: Record<string, unknown>): Promise<Hit> {
  for (let i = 0; i < limit; i++) expect((await m.hit(storage)).passed, `request ${i + 1}`).to.eq(true);
  return m.hit(storage);
}

const pending = (id: string) => ({ realIp: '192.0.2.10', AuthnSession: { handle: { id, state: 'pending' } } });
const signedIn = (principal: object) => ({ realIp: '192.0.2.10', Principal: principal, AuthnPrincipal: principal });

const FAILURE_BODY = { error: { ...AUTHN_FAILURE_BODY.error }, message: AUTHN_FAILURE_BODY.message };

describe('authn-http: the limits of the routes with a session', function () {
  this.timeout(20000);
  afterEach(disposeTestApps);

  it('every route with a session carries one config-backed @RateLimit with the shipped default', () => {
    for (const [controller, method, name, settings] of ROUTES) {
      const limits = limitsOf(controller, method);
      expect(limits, `${controller.name}.${method}`).to.have.length(1);
      expect(limits[0].config, `${controller.name}.${method}`).to.eq(`authn.http.rateLimit.${name}`);
      expect(limits[0].default, `${controller.name}.${method}`).to.deep.eq(settings);
      const pendingKeyed = name === 'mfaVerify' || name === 'mfaChallenge' || (controller === AuthnMfaEnrolmentController && (method === 'begin' || method === 'confirm'));
      expect(limits[0].key, `${controller.name}.${method} key`).to.eq(pendingKeyed ? pendingSessionKey : undefined);
      expect(limits[0].headers, `${controller.name}.${method} headers`).to.eq(false);
    }
  });

  it('reads of the caller own data carry no limit', () => {
    for (const [controller, method] of UNLIMITED) expect(limitsOf(controller, method), `${controller.name}.${method}`).to.deep.eq([]);
  });

  it('the schema fills authn.http.rateLimit with the shipped defaults', async () => {
    const { container } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {} });
    const configured = (await container.resolve(Configuration)).get<Record<string, unknown>>('authn.http.rateLimit');
    for (const [, , name, settings] of ROUTES) expect(configured[name], name).to.deep.eq(settings);
  });

  it('the schema refuses a value it cannot enforce, a route name it does not know and headers', async () => {
    for (const config of [{ activeRole: { limit: -1 } }, { activeRole: { by: 'session' } }, { activeRole: true }, { activRole: { limit: 1 } }, { activeRole: { headers: true } }]) {
      let error: unknown;
      try {
        await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: { authn: { http: { rateLimit: config } } } });
      } catch (e) {
        error = e;
      }
      expect(error, JSON.stringify(config)).to.be.instanceOf(Error);
      expect((error as Error).message, JSON.stringify(config)).to.contain('rateLimit');
    }
  });

  describe('MFA of a pending session', () => {
    it('verify: the 11th code from one pending session answers the uniform login failure with Retry-After and no X-RateLimit-*', async () => {
      const m = await mounted(AuthnMfaController, 'verify');
      const refused = await exhaust(m, 10, pending('session-a'));

      expect(refused.status).to.eq(401);
      expect(refused.body).to.deep.eq(FAILURE_BODY);
      expect(Number(refused.own['Retry-After'])).to.be.within(1, 300);
      expect(refused.own['Cache-Control']).to.eq('no-store');
      expect(refused.set).to.deep.eq({});
    });

    it('counts per pending session, on a hash of its handle, never the handle itself', async () => {
      const m = await mounted(AuthnMfaController, 'recovery');
      const increment = sinon.spy(m.store, 'increment');
      await exhaust(m, 10, pending('session-a'));

      expect((await m.hit(pending('session-b'))).passed).to.eq(true);
      const keys = increment.getCalls().map((c) => c.args[0]);
      expect(keys.every((k) => !k.includes('session-a') && !k.includes('session-b'))).to.eq(true);
      expect(new Set(keys.slice(0, 11)).size).to.eq(1);
      expect(keys[0]).to.match(/:key:pending:[0-9a-f]{64}$/);
      // keyed under the server secret: a bare hash of the handle would be recomputable by whoever saw it
      expect(keys[0]).to.not.contain(createHash('sha256').update('session-a').digest('hex'));
      expect(keys[0]).to.contain(createHmac('sha256', COOKIE_SECRET).update('spinajs.authn-http.rate-limit.pending-session\0session-a').digest('hex'));
      expect(keys[11]).to.not.eq(keys[0]);
    });

    it('without a restored pending session counts the client address', async () => {
      const m = await mounted(AuthnMfaController, 'verify');
      const increment = sinon.spy(m.store, 'increment');
      await m.hit({ realIp: '192.0.2.10' });
      await m.hit({ realIp: '192.0.2.10', AuthnSession: { handle: { id: 'active-one', state: 'active' } } });
      expect(increment.getCalls().map((c) => c.args[0].replace(/^.*:(ip|key):/, '$1:'))).to.deep.eq(['ip:192.0.2.10', 'ip:192.0.2.10']);
    });

    it('challenge: the 6th send from one pending session answers the 202 every challenge answers', async () => {
      const m = await mounted(AuthnMfaController, 'challenge');
      const refused = await exhaust(m, 5, pending('session-a'));

      expect(refused.status).to.eq(202);
      expect(refused.body).to.deep.eq({ Ok: true });
      expect(refused.set).to.deep.eq({});
    });
  });

  describe('code and password checks of an active session', () => {
    it('step-up: the 11th answers the uniform login failure with Retry-After, per principal', async () => {
      const m = await mounted(AuthnMfaController, 'stepUp');
      const refused = await exhaust(m, 10, signedIn(ALICE));

      expect(refused.status).to.eq(401);
      expect(refused.body).to.deep.eq(FAILURE_BODY);
      expect(Number(refused.own['Retry-After'])).to.be.within(1, 300);
      expect(refused.set).to.deep.eq({});
      expect((await m.hit(signedIn(BOB))).passed).to.eq(true);
    });

    for (const [controller, method, name] of [
      [AuthnReauthController, 'reauth', 'reauth'],
      [AuthnPasswordController, 'change', 'passwordChange'],
    ] as [Ctor, string, Name][]) {
      it(`${name}: the 11th answers the uniform login failure without Retry-After, as a throttled password does`, async () => {
        const m = await mounted(controller, method);
        const refused = await exhaust(m, 10, signedIn(ALICE));

        expect(refused.status).to.eq(401);
        expect(refused.body).to.deep.eq(FAILURE_BODY);
        expect(refused.own['Retry-After']).to.eq(undefined);
        expect(refused.set).to.deep.eq({});
      });
    }
  });

  describe('credential and account routes', () => {
    for (const [controller, method, name, limit] of [
      [AuthnActiveRoleController, 'switch', 'activeRole', 20],
      [AuthnVerificationController, 'request', 'verifyRequest', 5],
      [AuthnTokensController, 'create', 'tokens', 20],
      [AuthnMfaEnrolmentController, 'begin', 'mfaEnrolment', 10],
      [AuthnCredentialAdminController, 'mfaReset', 'adminCredentials', 60],
    ] as [Ctor, string, Name, number][]) {
      it(`${name}: request ${limit + 1} of one principal answers authn's 429 throttled body, without X-RateLimit-*`, async () => {
        const m = await mounted(controller, method);
        const refused = await exhaust(m, limit, signedIn(ALICE));

        expect(refused.status).to.eq(429);
        expect(refused.body).to.include({ error: 'throttled' });
        expect(Number(refused.own['Retry-After'])).to.be.within(1, AUTHN_HTTP_SESSION_RATE_LIMITS[name].windowSeconds);
        expect(refused.set).to.deep.eq({});
        expect((await m.hit(signedIn(BOB))).passed).to.eq(true);
      });
    }

    it('MFA enrolment counts a pending session (forced to enrol) on the session, an active one on its principal', async () => {
      for (const method of ['begin', 'confirm']) {
        const m = await mounted(AuthnMfaEnrolmentController, method);
        const increment = sinon.spy(m.store, 'increment');
        await m.hit(pending('session-a'));
        await m.hit(signedIn(ALICE));
        expect(increment.firstCall.args[0], method).to.match(/:key:pending:[0-9a-f]{64}$/);
        expect(increment.secondCall.args[0], method).to.match(/:principal:user:alice$/);
      }
    });

    it('an impersonator spends the budget of the impersonated user (the principal is the target)', async () => {
      const m = await mounted(AuthnImpersonationController, 'start');
      const increment = sinon.spy(m.store, 'increment');
      await m.hit(signedIn({ ...ALICE, authn: { impersonator: { type: 'user', id: 'admin' } } }));
      expect(increment.firstCall.args[0]).to.match(/:principal:user:alice$/);
    });
  });

  describe('configuration', () => {
    it('authn.http.rateLimit.<name> overrides the default; unset keys keep it', async () => {
      const m = await mounted(AuthnActiveRoleController, 'switch', { authn: { http: { rateLimit: { activeRole: { limit: 1 } } } } });
      expect([m.mw.limit, m.mw.windowSeconds, m.mw.by]).to.deep.eq([1, 60, 'principal']);
      expect((await exhaust(m, 1, signedIn(ALICE))).status).to.eq(429);
    });

    it('false takes the limit off the route', async () => {
      const m = await mounted(AuthnMfaController, 'verify', { authn: { http: { rateLimit: { mfaVerify: false } } } });
      expect(m.mw.isEnabled(routeOf(AuthnMfaController, 'verify'), CONTROLLER)).to.eq(false);
      for (let i = 0; i < 12; i++) expect((await m.hit(pending('session-a'))).passed).to.eq(true);
    });
  });
});
