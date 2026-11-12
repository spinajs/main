import 'mocha';
import { expect } from 'chai';
import { Configuration } from '@spinajs/configuration';
import { CONTROLLED_DESCRIPTOR_SYMBOL, HTTP_CONFIGURATION_SCHEMA, MemoryThrottleStore, RateLimitMiddleware } from '@spinajs/http';
import type { IController, IControllerDescriptor, IRateLimitOptions, IRoute, Response } from '@spinajs/http';
import { createTestApp, disposeTestApps, readingFrom } from '@spinajs/testing';

import { AUTHZ_HTTP_ADMIN_RATE_LIMITS, AUTHZ_HTTP_ADMIN_RATE_LIMIT_SCHEMA, AuthzAdminController } from '../src/index.js';

const SCHEMAS = [AUTHZ_HTTP_ADMIN_RATE_LIMIT_SCHEMA, HTTP_CONFIGURATION_SCHEMA];
const DEFAULTS = AUTHZ_HTTP_ADMIN_RATE_LIMITS;
type Name = keyof typeof DEFAULTS;

type Ctor = abstract new (...args: never[]) => unknown;

const CONTROLLER = {} as IController;
const ALICE = { type: 'user', id: 'alice', authenticated: true, source: 'session', attributes: {} };
const BOB = { type: 'user', id: 'bob', authenticated: true, source: 'session', attributes: {} };
const signedIn = (principal: object) => ({ realIp: '192.0.2.10', Principal: principal });
const TOO_MANY = { error: { code: 'E_TOO_MANY_REQUESTS', message: 'Too many requests, try again later' } };

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
  /** Headers the answer carries itself, apart from those set on `res`. */
  readonly answerHeaders?: Record<string, string>;
}

/** The route's RateLimitMiddleware as the server mounts it, against `config` checked by the shipped schema. */
async function mounted(controller: Ctor, method: string, config: Record<string, unknown> = {}) {
  const [options] = limitsOf(controller, method);
  const { container } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config });
  const mw = readingFrom(new RateLimitMiddleware(options), container);
  Object.defineProperty(mw, 'Store', { value: new MemoryThrottleStore() });
  Object.defineProperty(mw, 'Configuration', { value: await container.resolve(Configuration) });
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
    return answer
      ? { passed: false, status: answer.statusCode, body: answer.data, set, answerHeaders: Object.fromEntries(answer.headers.map((h) => [h.Name, String(h.Value)])) }
      : { passed: true, set };
  };
  return { mw, hit };
}

async function exhaust(m: Awaited<ReturnType<typeof mounted>>, limit: number, storage: Record<string, unknown>): Promise<Hit> {
  for (let i = 0; i < limit; i++) expect((await m.hit(storage)).passed, `request ${i + 1}`).to.eq(true);
  return m.hit(storage);
}

const ROUTES: [Ctor, string, Name][] = [
  [AuthzAdminController, 'commands', 'commands'],
  [AuthzAdminController, 'grant', 'writes'],
  [AuthzAdminController, 'patchAssignment', 'writes'],
  [AuthzAdminController, 'revoke', 'writes'],
  [AuthzAdminController, 'createLink', 'writes'],
  [AuthzAdminController, 'patchLink', 'writes'],
  [AuthzAdminController, 'revokeLink', 'writes'],
  [AuthzAdminController, 'putRule', 'writes'],
  [AuthzAdminController, 'deleteRule', 'writes'],
  [AuthzAdminController, 'putPolicy', 'writes'],
  [AuthzAdminController, 'deletePolicy', 'writes'],
  [AuthzAdminController, 'patchAttributes', 'writes'],
  [AuthzAdminController, 'replaceAttributes', 'writes'],
];

const UNLIMITED: [Ctor, string][] = [
  [AuthzAdminController, 'listAssignments'],
  [AuthzAdminController, 'listHolders'],
  [AuthzAdminController, 'listLinks'],
  [AuthzAdminController, 'listRules'],
  [AuthzAdminController, 'listPolicies'],
  [AuthzAdminController, 'attributes'],
];

// One route of each group.
const GROUPS: [Ctor, string, Name][] = [
  [AuthzAdminController, 'commands', 'commands'],
  [AuthzAdminController, 'grant', 'writes'],
];

describe('authz-http-admin: the limits of commands and writes', function () {
  this.timeout(20000);
  afterEach(disposeTestApps);

  it('each limited route carries one @RateLimit on authz.http.admin.rateLimit.<name> with the shipped default', () => {
    for (const [controller, method, name] of ROUTES) {
      const limits = limitsOf(controller, method);
      expect(limits, `${controller.name}.${method}`).to.have.length(1);
      expect(limits[0].config, `${controller.name}.${method}`).to.eq(`authz.http.admin.rateLimit.${name}`);
      expect(limits[0].default, `${controller.name}.${method}`).to.deep.eq(DEFAULTS[name]);
    }
  });

  it('the shipped defaults', () => {
    expect(DEFAULTS).to.deep.eq({ commands: { limit: 60, windowSeconds: 60, by: 'principal' }, writes: { limit: 120, windowSeconds: 60, by: 'principal' } });
  });

  it('routes the adoption report leaves unlimited carry no @RateLimit', () => {
    for (const [controller, method] of UNLIMITED) expect(limitsOf(controller, method), `${controller.name}.${method}`).to.deep.eq([]);
  });

  it('the schema fills authz.http.admin.rateLimit with the shipped defaults', async () => {
    const { container } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {} });
    expect((await container.resolve(Configuration)).get('authz.http.admin.rateLimit')).to.deep.eq(DEFAULTS);
  });

  it('the schema refuses a value it cannot enforce and a name it does not know', async () => {
    for (const value of [{ commands: { limit: -1 } }, { commands: { by: 'session' } }, { commands: true }, { nope: { limit: 1 } }]) {
      let error: unknown;
      try {
        await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: nest('authz.http.admin.rateLimit', value) });
      } catch (e) {
        error = e;
      }
      expect(error, JSON.stringify(value)).to.be.instanceOf(Error);
      expect((error as Error).message, JSON.stringify(value)).to.contain('rateLimit');
    }
  });

  for (const [controller, method, name] of GROUPS) {
    it(`${name}: request ${DEFAULTS[name].limit + 1} of one principal answers 429 with Retry-After and no X-RateLimit-*; another principal passes`, async () => {
      const m = await mounted(controller, method);
      const refused = await exhaust(m, DEFAULTS[name].limit, signedIn(ALICE));

      expect(refused.status).to.eq(429);
      expect(JSON.stringify(refused.body)).to.eq(JSON.stringify(TOO_MANY));
      expect(refused.set, 'nothing set on res').to.deep.eq({});
      expect(Object.keys(refused.answerHeaders ?? {})).to.deep.eq(['Retry-After']);
      expect(Number(refused.answerHeaders?.['Retry-After'])).to.be.within(1, DEFAULTS[name].windowSeconds);
      expect((await m.hit(signedIn(BOB))).passed).to.eq(true);
    });
  }

  it('authz.http.admin.rateLimit.<name>.headers: true turns the X-RateLimit-* headers on', async () => {
    const [controller, method, name] = GROUPS[0];
    const m = await mounted(controller, method, nest(`authz.http.admin.rateLimit.${name}`, { limit: 2, headers: true }));
    const counted = await m.hit(signedIn(ALICE));
    expect(counted.passed).to.eq(true);
    expect([counted.set['X-RateLimit-Limit'], counted.set['X-RateLimit-Remaining']]).to.deep.eq(['2', '1']);
    const refused = await exhaust(m, 1, signedIn(ALICE));
    expect(refused.status).to.eq(429);
    expect(refused.set['X-RateLimit-Limit']).to.eq('2');
    expect(Number(refused.set['Retry-After'])).to.be.within(1, DEFAULTS[name].windowSeconds);
  });

  it('authz.http.admin.rateLimit.<name> overrides the default; unset keys keep it', async () => {
    const [controller, method, name] = GROUPS[0];
    const m = await mounted(controller, method, nest(`authz.http.admin.rateLimit.${name}`, { limit: 1 }));
    expect([m.mw.limit, m.mw.windowSeconds, m.mw.by]).to.deep.eq([1, DEFAULTS[name].windowSeconds, 'principal']);
    expect((await exhaust(m, 1, signedIn(ALICE))).status).to.eq(429);
  });

  it('false takes the limit off the route', async () => {
    const [controller, method, name] = GROUPS[0];
    const m = await mounted(controller, method, nest(`authz.http.admin.rateLimit.${name}`, false));
    expect(m.mw.isEnabled(routeOf(controller, method), CONTROLLER)).to.eq(false);
    for (let i = 0; i < DEFAULTS[name].limit + 2; i++) expect((await m.hit(signedIn(ALICE))).passed).to.eq(true);
  });
});
