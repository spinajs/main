import 'mocha';
import { expect } from 'chai';
import { Configuration } from '@spinajs/configuration';
import { CONTROLLED_DESCRIPTOR_SYMBOL, HTTP_CONFIGURATION_SCHEMA, MemoryThrottleStore, RateLimitMiddleware } from '@spinajs/http';
import type { IController, IControllerDescriptor, IRateLimitOptions, IRoute, Response } from '@spinajs/http';
import { createTestApp, disposeTestApps, readingFrom } from '@spinajs/testing';
import { DataValidator } from '@spinajs/validation';

import { AUTHN_OIDC_CONFIGURATION_SCHEMA, AUTHN_OIDC_SESSION_RATE_LIMITS } from '../src/index.js';
import { OidcController } from '../src/controllers/OidcController.js';
import { OidcThrottledResponse } from '../src/rate-limits.js';
import { AUTHN_FAILURE_BODY } from '@spinajs/authn/contracts';

const SCHEMAS = [AUTHN_OIDC_CONFIGURATION_SCHEMA, HTTP_CONFIGURATION_SCHEMA];
const DEFAULTS = AUTHN_OIDC_SESSION_RATE_LIMITS;
type Name = keyof typeof DEFAULTS;

type Ctor = abstract new (...args: never[]) => unknown;

const CONTROLLER = {} as IController;
const ALICE = { type: 'user', id: 'alice', authenticated: true, source: 'session', attributes: {} };
const BOB = { type: 'user', id: 'bob', authenticated: true, source: 'session', attributes: {} };
const signedIn = (principal: object) => ({ realIp: '192.0.2.10', Principal: principal });
const request = (headers: Record<string, string>) => ({ get: (name: string) => headers[name.toLowerCase()] });

const nest = (path: string, value: unknown): Record<string, unknown> => path.split('.').reduceRight<unknown>((inner, key) => ({ [key]: inner }), value) as Record<string, unknown>;

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
  readonly set: Record<string, string>;
  readonly answer?: Response;
}

/** The route's RateLimitMiddleware as the server mounts it, against `config` checked by the shipped schema. */
async function mounted(controller: Ctor, method: string, config: Record<string, unknown> = {}) {
  const [options] = limitsOf(controller, method);
  const { container } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config });
  const mw = readingFrom(new RateLimitMiddleware(options), container);
  Object.defineProperty(mw, 'Store', { value: new MemoryThrottleStore() });
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
    return answer ? { passed: false, status: answer.statusCode, body: answer.data, set, answer } : { passed: true, set };
  };
  return { mw, hit };
}

async function exhaust(m: Awaited<ReturnType<typeof mounted>>, limit: number, storage: Record<string, unknown>): Promise<Hit> {
  for (let i = 0; i < limit; i++) expect((await m.hit(storage)).passed, `request ${i + 1}`).to.eq(true);
  return m.hit(storage);
}

const ROUTES: [Ctor, string, Name][] = [
  [OidcController, 'beginLink', 'link'],
  [OidcController, 'unlink', 'link'],
  [OidcController, 'reauth', 'reauth'],
];

const UNLIMITED: [Ctor, string][] = [
  [OidcController, 'backchannelLogout'],
];

// One route of each group.
const GROUPS: [Ctor, string, Name][] = [
  [OidcController, 'beginLink', 'link'],
  [OidcController, 'reauth', 'reauth'],
];

describe('authn-oidc: the limits of link and reauth', function () {
  this.timeout(20000);
  afterEach(disposeTestApps);

  it('each limited route carries one @RateLimit on authn.oidc.rateLimit.<name> with the shipped default', () => {
    for (const [controller, method, name] of ROUTES) {
      const limits = limitsOf(controller, method);
      expect(limits, `${controller.name}.${method}`).to.have.length(1);
      expect(limits[0].config, `${controller.name}.${method}`).to.eq(`authn.oidc.rateLimit.${name}`);
      expect(limits[0].default, `${controller.name}.${method}`).to.deep.eq(DEFAULTS[name]);
    }
  });

  it('the shipped defaults', () => {
    expect(DEFAULTS).to.deep.eq({ link: { limit: 10, windowSeconds: 600, by: 'principal' }, reauth: { limit: 10, windowSeconds: 300, by: 'principal' } });
  });

  it('routes the adoption report leaves unlimited carry no @RateLimit', () => {
    // back-channel logout declares @RateLimit({ config: false }): unlimited even under a global floor
    for (const [controller, method] of UNLIMITED) expect(limitsOf(controller, method).filter((o) => o.config !== false), `${controller.name}.${method}`).to.deep.eq([]);
  });

  it('the schema fills authn.oidc.rateLimit with the shipped defaults', async () => {
    const { container } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {} });
    expect((await container.resolve(Configuration)).get('authn.oidc.rateLimit')).to.deep.include(DEFAULTS);
  });

  it('the schema refuses a value it cannot enforce, a name it does not know and headers', async () => {
    for (const value of [{ link: { limit: -1 } }, { link: { by: 'session' } }, { link: true }, { nope: { limit: 1 } }, { link: { headers: true } }]) {
      let error: unknown;
      try {
        await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: nest('authn.oidc.rateLimit', value) });
      } catch (e) {
        error = e;
      }
      expect(error, JSON.stringify(value)).to.be.instanceOf(Error);
      expect((error as Error).message, JSON.stringify(value)).to.contain('rateLimit');
    }
  });

  for (const [controller, method, name] of GROUPS) {
    it(`${name}: request ${DEFAULTS[name].limit + 1} of one principal gets the OIDC failure answer (303 for a navigation, 401 otherwise) with Retry-After, no X-RateLimit-*; another principal passes`, async () => {
      const m = await mounted(controller, method);
      const refused = await exhaust(m, DEFAULTS[name].limit, signedIn(ALICE));

      expect(refused.answer).to.be.instanceOf(OidcThrottledResponse);
      const throttled = refused.answer as OidcThrottledResponse;
      expect(throttled.retryAfterSeconds).to.be.within(1, DEFAULTS[name].windowSeconds);
      const fetched = throttled.answerFor(request({ accept: 'application/json' }), undefined, undefined);
      expect([fetched.status, fetched.body, fetched.headers]).to.deep.eq([401, AUTHN_FAILURE_BODY, { 'retry-after': String(throttled.retryAfterSeconds) }]);
      expect(throttled.answerFor(request({ 'sec-fetch-mode': 'navigate' }), undefined, undefined).status).to.eq(303);
      expect(refused.set).to.deep.eq({});
      expect((await m.hit(signedIn(BOB))).passed).to.eq(true);
    });
  }

  it('authn.oidc.rateLimit.<name> overrides the default; unset keys keep it', async () => {
    const [controller, method, name] = GROUPS[0];
    const m = await mounted(controller, method, nest(`authn.oidc.rateLimit.${name}`, { limit: 1 }));
    expect([m.mw.limit, m.mw.windowSeconds, m.mw.by]).to.deep.eq([1, DEFAULTS[name].windowSeconds, 'principal']);
    expect((await exhaust(m, 1, signedIn(ALICE))).answer).to.be.instanceOf(OidcThrottledResponse);
  });

  it('false takes the limit off the route', async () => {
    const [controller, method, name] = GROUPS[0];
    const m = await mounted(controller, method, nest(`authn.oidc.rateLimit.${name}`, false));
    expect(m.mw.isEnabled(routeOf(controller, method), CONTROLLER)).to.eq(false);
    for (let i = 0; i < DEFAULTS[name].limit + 2; i++) expect((await m.hit(signedIn(ALICE))).passed).to.eq(true);
  });
});
