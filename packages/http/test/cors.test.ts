import 'mocha';
import { expect } from 'chai';
import chai from 'chai';
import chaiHttp from 'chai-http';
import sinon from 'sinon';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';

import { BaseController, BasePath, Get, Post, RouteIndex, buildRoutePath } from '../src/index.js';
import { Cors, CorsMiddleware, parseOrigin } from '../src/middlewares/Cors.js';
import { HTTP_CONFIGURATION_SCHEMA } from '../src/schemas/http.configuration.js';
import { configurationViolations, createTestApp, disposeTestApps, readingFrom } from '@spinajs/testing';
import { serverApp } from './support/server-app.js';

chai.use(chaiHttp);

const PARTNER = 'https://partner.example.test';
const EVIL = 'https://evil.example.test';

/** A CorsMiddleware reading `http.cors` (absent when undefined) from a Configuration the http schema checked. */
async function middleware(cors: unknown, type: new () => CorsMiddleware = CorsMiddleware) {
  const { container: child } = await createTestApp({ scope: 'child', bootstrap: false, schemas: [HTTP_CONFIGURATION_SCHEMA], config: cors === undefined ? {} : { http: { cors } } });
  const mw = readingFrom(new type(), child);
  const warn = sinon.stub();
  Object.defineProperty(mw, 'Log', { value: { warn } });
  return { mw, warn };
}

async function app(cors: unknown, type?: new () => CorsMiddleware) {
  return serverApp((await middleware(cors, type)).mw, (req, res, next) => {
    if (req.path !== '/probe') return next();
    res.json({ ok: true });
  });
}

const simple = async (cors: unknown, origin: string) => chai.request(await app(cors)).get('/probe').set('Origin', origin);
const preflight = async (cors: unknown, origin: string) =>
  chai.request(await app(cors)).options('/probe').set('Origin', origin).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type');

const acHeaders = (res: { header: Record<string, string> }) => Object.keys(res.header).filter((n) => n.startsWith('access-control-'));

describe('CorsMiddleware (A31)', () => {
  afterEach(disposeTestApps);

  it('A31 without http.cors sends no CORS headers outside @Cors routes, and warns', async () => {
    for (const cors of [undefined, null, false, true]) {
      const { mw, warn } = await middleware(cors);
      expect(mw.isEnabled(), String(cors)).to.eq(true);
      expect(warn.calledOnce).to.eq(true);
      expect(acHeaders(await simple(cors, PARTNER)), String(cors)).to.deep.eq([]);
    }
  });

  it('SR-12 an empty CORS list reflects no origin', async () => {
    for (const cors of [{ origins: [] }, { origins: null }, {}]) {
      const s = await simple(cors, EVIL);
      expect(s.status, JSON.stringify(cors)).to.eq(200);
      expect(acHeaders(s), JSON.stringify(cors)).to.deep.eq([]);
      const p = await preflight(cors, EVIL);
      expect(acHeaders(p), JSON.stringify(cors)).to.deep.eq([]);
    }
  });

  it('A31 a listed origin is echoed with credentials and Vary: Origin', async () => {
    const res = await simple({ origins: [PARTNER] }, PARTNER);
    expect(res.status).to.eq(200);
    expect(res.header['access-control-allow-origin']).to.eq(PARTNER);
    expect(res.header['access-control-allow-credentials']).to.eq('true');
    expect(res.header['vary']).to.match(/(^|,\s*)origin(\s*,|$)/i);
  });

  it("A31 a listed origin's preflight is answered", async () => {
    const res = await preflight({ origins: [PARTNER] }, PARTNER);
    expect(res.status).to.eq(204);
    expect(res.header['access-control-allow-origin']).to.eq(PARTNER);
    expect(res.header['access-control-allow-credentials']).to.eq('true');
    expect(res.header['access-control-allow-methods']).to.contain('POST');
    expect(res.header['access-control-allow-headers']).to.eq('content-type');
  });

  it('A31 a listed origin matches exactly: scheme, host and port', async () => {
    for (const origin of [`${PARTNER}:8443`, PARTNER.replace('https:', 'http:'), PARTNER.replace('//', '//sub.'), `${PARTNER}.evil.test`, 'https://partner.example', EVIL, 'null']) {
      const s = await simple({ origins: [PARTNER] }, origin);
      expect(s.status, origin).to.eq(200);
      expect(acHeaders(s), origin).to.deep.eq([]);
      expect(s.header['vary'], origin).to.match(/origin/i);
      expect(acHeaders(await preflight({ origins: [PARTNER] }, origin)), origin).to.deep.eq([]);
    }
  });

  it('A31 a listed origin compares as a URL origin: case of scheme and host, default port, trailing slash', async () => {
    expect((await simple({ origins: ['HTTPS://Partner.Example.Test:443/'] }, PARTNER)).header['access-control-allow-origin']).to.eq(PARTNER);
  });

  it('A31 a request without Origin gets no CORS headers', async () => {
    const res = await chai.request(await app({ origins: [PARTNER] })).get('/probe');
    expect(res.status).to.eq(200);
    expect(acHeaders(res)).to.deep.eq([]);
  });

  it("A31 '*' is never combined with credentials", async () => {
    const res = await simple({ origins: ['*'] }, EVIL);
    expect(res.header['access-control-allow-origin']).to.eq('*');
    expect(res.header['access-control-allow-credentials']).to.eq(undefined);
    const p = await preflight({ origins: ['*'] }, EVIL);
    expect(p.header['access-control-allow-origin']).to.eq('*');
    expect(p.header['access-control-allow-credentials']).to.eq(undefined);
  });

  it("A31 with '*' and explicit origins, only a listed origin gets credentials", async () => {
    const cors = { origins: ['*', PARTNER] };
    const listed = await simple(cors, PARTNER);
    expect(listed.header['access-control-allow-origin']).to.eq(PARTNER);
    expect(listed.header['access-control-allow-credentials']).to.eq('true');
    const other = await simple(cors, EVIL);
    expect(other.header['access-control-allow-origin']).to.eq('*');
    expect(other.header['access-control-allow-credentials']).to.eq(undefined);
    expect(other.header['vary']).to.match(/origin/i);
  });

  it('A31 exposedHeaders and allowedHeaders apply to allowed origins only', async () => {
    const cors = { origins: [PARTNER], exposedHeaders: ['x-request-id', 'x-total'], allowedHeaders: ['content-type', 'x-csrf'] };
    expect((await simple(cors, PARTNER)).header['access-control-expose-headers']).to.eq('x-request-id,x-total');
    expect((await preflight(cors, PARTNER)).header['access-control-allow-headers']).to.eq('content-type,x-csrf');
    expect(acHeaders(await simple(cors, EVIL))).to.deep.eq([]);
  });

  it('A31 a listed origin is never allowed to send Forwarded or X-Forwarded-* headers', async () => {
    const ask = async (cors: unknown, headers: string) =>
      chai.request(await app(cors)).options('/probe').set('Origin', PARTNER).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', headers);

    const echoed = await ask({ origins: [PARTNER] }, 'content-type, X-Forwarded-Host, x-forwarded-proto, forwarded, x-forwarded-for');
    expect(echoed.status).to.eq(204);
    expect(echoed.header['access-control-allow-headers']).to.eq('content-type');

    const onlyProxy = await ask({ origins: [PARTNER] }, 'x-forwarded-host');
    expect(onlyProxy.header['access-control-allow-headers']).to.eq(undefined);

    const configured = await ask({ origins: [PARTNER], allowedHeaders: ['content-type', 'X-Forwarded-Host', 'Forwarded'] }, 'content-type, x-forwarded-host');
    expect(configured.header['access-control-allow-headers']).to.eq('content-type');
  });

  it('A31 echoes only the requested entries that are header names', async () => {
    const res = await chai
      .request(await app({ origins: [PARTNER] }))
      .options('/probe')
      .set('Origin', PARTNER)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type, x a, x-tenant, <b>, x-é, , authorization');

    expect(res.status).to.eq(204);
    expect((res.header as Record<string, string>)['access-control-allow-headers']).to.eq('content-type,x-tenant,authorization');
  });

  it('A31 an origin entry that is not a URL origin fails the boot', async () => {
    for (const entry of ['partner.example.test', 'localhost:3000', 'null', '', 'https://partner.example.test/app', 'https://partner.example.test?x=1', 'https://*.example.test', 'https://user@partner.example.test']) {
      expect(await configurationViolations({ schemas: [HTTP_CONFIGURATION_SCHEMA], config: { http: { cors: { origins: [entry] } } } }), entry).to.include('http.cors.origins.0');
    }
    expect(await configurationViolations({ schemas: [HTTP_CONFIGURATION_SCHEMA], config: { http: { cors: { origins: 'https://a.example' } } } })).to.include('http.cors.origins');
  });

  it('a subclass allows origins by a rule through allowance(), with the default preflight answer', async () => {
    class SubdomainCors extends CorsMiddleware {
      protected allowance(origin: string) {
        return /^https:\/\/[a-z0-9-]+\.example\.test$/.test(origin) ? { allowOrigin: origin, credentials: true } : super.allowance(origin);
      }
    }
    const SHOP = 'https://shop.example.test';
    const simpleRes = await chai.request(await app({ origins: [PARTNER] }, SubdomainCors)).get('/probe').set('Origin', SHOP);
    const simpleHeaders = simpleRes.header as Record<string, string | undefined>;
    expect(simpleHeaders['access-control-allow-origin']).to.eq(SHOP);
    expect(simpleHeaders['access-control-allow-credentials']).to.eq('true');

    const preflightRes = await chai.request(await app({ origins: [PARTNER] }, SubdomainCors)).options('/probe').set('Origin', SHOP).set('Access-Control-Request-Method', 'POST');
    expect(preflightRes.status).to.eq(204);
    expect((preflightRes.header as Record<string, string | undefined>)['access-control-allow-origin']).to.eq(SHOP);
    expect(acHeaders(await simple({ origins: [PARTNER] }, 'https://shop.evil.test'))).to.deep.eq([]);
  });

  it('an overridden allowance() varies by Origin even with only the wildcard configured, and can enable CORS by a rule alone', async () => {
    class EchoCors extends CorsMiddleware {
      protected allowance(origin: string) {
        return origin.endsWith('.example.test') ? { allowOrigin: origin, credentials: true } : super.allowance(origin);
      }
    }
    const SHOP = 'https://shop.example.test';
    const starred = await chai.request(await app({ origins: ['*'] }, EchoCors)).get('/probe').set('Origin', SHOP);
    const starredHeaders = starred.header as Record<string, string | undefined>;
    expect(starredHeaders['access-control-allow-origin']).to.eq(SHOP);
    expect(starredHeaders['vary']).to.match(/origin/i);

    class RuleOnlyCors extends EchoCors {
      public isEnabled() {
        return true;
      }
    }
    const ruled = await chai.request(await app(undefined, RuleOnlyCors)).get('/probe').set('Origin', SHOP);
    expect((ruled.header as Record<string, string | undefined>)['access-control-allow-origin']).to.eq(SHOP);
  });

  it('A31 an origin entry the schema lets through but URL refuses fails when the middleware is built', async () => {
    for (const entry of ['http://app.example.test:99999', 'http://app:port', 'http://[::1']) {
      const { mw } = await middleware({ origins: [entry] });
      expect(() => mw.isEnabled(), entry).to.throw(InvalidOption, 'http.cors.origins');
    }
  });
});

describe('parseOrigin', () => {
  it('gives the serialized origin: lower case, default port and trailing slash dropped', () => {
    expect(parseOrigin('HTTPS://Partner.Example.Test:443/')).to.eq(PARTNER);
    expect(parseOrigin('http://localhost:8889')).to.eq('http://localhost:8889');
    expect(parseOrigin('http://app.example.test:80')).to.eq('http://app.example.test');
    expect(parseOrigin('http://[::1]:8889')).to.eq('http://[::1]:8889');
  });

  it('refuses anything that is not an origin rather than cutting it down to one', () => {
    const values = [
      'partner.example.test', 'localhost:3000', 'null', '', 'http://', 'https://partner.example.test/app', 'https://partner.example.test?x=1',
      'https://partner.example.test#x', 'https://*.example.test', 'https://user@partner.example.test', 'http://evil.example\\app.example.test',
      'http://a b', 'http://app:port', 'data:text/plain,x', undefined, null, 1, ['https://a.example'],
    ];
    for (const value of values) expect(parseOrigin(value), String(value)).to.eq(undefined);
  });
});

const SHOP = 'https://shop.example.test';

const noopLog = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, security: () => {}, success: () => {} };

@BasePath('api')
class CorsRoutesController extends BaseController {
  @Cors({ origins: [SHOP], maxAge: 600 })
  @Post('orders')
  public createOrder() {
    return null;
  }

  @Get('orders')
  public listOrders() {
    return null;
  }

  @Cors({ origins: ['*'] })
  @Get('public')
  public open() {
    return null;
  }

  @Cors({ origins: [SHOP], credentials: false })
  @Get('anonymous')
  public anonymous() {
    return null;
  }

  @Cors({ origins: [] })
  @Get('closed')
  public closed() {
    return null;
  }
}

@Cors({ origins: [SHOP] })
@BasePath('shop')
class ShopController extends BaseController {
  @Get('cart')
  public cart() {
    return null;
  }

  @Cors({ origins: [PARTNER] })
  @Get('partner')
  public partner() {
    return null;
  }
}

function indexed(...types: (new () => BaseController)[]): RouteIndex {
  const index = new RouteIndex();
  for (const type of types) {
    const c = new type();
    for (const [name, value] of Object.entries({ _cfg: { get: (_p: string, fallback?: unknown) => fallback }, _log: noopLog, _container: DI, _actionLocalStorage: new AsyncLocalStorage() })) {
      Object.defineProperty(c, name, { value });
    }
    for (const [, route] of c.Descriptor.Routes) index.add(c, route, buildRoutePath(c.BasePath, route));
  }
  return index;
}

async function routedApp(cors: unknown) {
  const routes = indexed(CorsRoutesController, ShopController);
  const { mw } = await middleware(cors);
  Object.defineProperty(mw, 'Routes', { value: routes });
  return serverApp(
    mw,
    (_req, res) => {
      res.json({ reached: true });
    },
    routes,
  );
}

const ask = async (cors: unknown, method: 'get' | 'post', path: string, origin: string) => chai.request(await routedApp(cors))[method](path).set('Origin', origin);
const askPreflight = async (cors: unknown, path: string, origin: string, method = 'POST') =>
  chai.request(await routedApp(cors)).options(path).set('Origin', origin).set('Access-Control-Request-Method', method);

describe('@Cors per route', () => {
  afterEach(disposeTestApps);

  const GLOBAL = { origins: [PARTNER], exposedHeaders: ['x-request-id'] };

  it("the route's origins replace http.cors.origins for that route", async () => {
    const shop = await ask(GLOBAL, 'post', '/api/orders', SHOP);
    expect(shop.header['access-control-allow-origin']).to.eq(SHOP);
    expect(shop.header['access-control-allow-credentials']).to.eq('true');
    expect(shop.header['access-control-expose-headers']).to.eq('x-request-id');
    expect(shop.header['vary']).to.match(/origin/i);
    expect(acHeaders(await ask(GLOBAL, 'post', '/api/orders', PARTNER))).to.deep.eq([]);
  });

  it('a route without @Cors, and another method on the same path, keep the global policy', async () => {
    expect((await ask(GLOBAL, 'get', '/api/orders', PARTNER)).header['access-control-allow-origin']).to.eq(PARTNER);
    expect(acHeaders(await ask(GLOBAL, 'get', '/api/orders', SHOP))).to.deep.eq([]);
    expect((await ask(GLOBAL, 'get', '/nowhere', PARTNER)).header['access-control-allow-origin']).to.eq(PARTNER);
  });

  it("a preflight is answered by the policy of the route its Access-Control-Request-Method names, with the route's max age", async () => {
    const res = await askPreflight(GLOBAL, '/api/orders', SHOP);
    expect(res.status).to.eq(204);
    expect(res.header['access-control-allow-origin']).to.eq(SHOP);
    expect(res.header['access-control-max-age']).to.eq('600');
    const partner = await askPreflight(GLOBAL, '/api/orders', PARTNER);
    expect(partner.status).to.not.eq(204);
    expect(acHeaders(partner)).to.deep.eq([]);

    const get = await askPreflight(GLOBAL, '/API/orders/', PARTNER, 'GET');
    expect(get.status).to.eq(204);
    expect(get.header['access-control-allow-origin']).to.eq(PARTNER);
    expect(get.header['access-control-max-age']).to.eq(undefined);
    expect(acHeaders(await askPreflight(GLOBAL, '/api/orders', SHOP, 'GET'))).to.deep.eq([]);
  });

  it("'*' answers any origin without credentials; credentials: false echoes without them", async () => {
    const open = await ask(GLOBAL, 'get', '/api/public', EVIL);
    expect(open.header['access-control-allow-origin']).to.eq('*');
    expect(open.header['access-control-allow-credentials']).to.eq(undefined);
    const anonymous = await ask(GLOBAL, 'get', '/api/anonymous', SHOP);
    expect(anonymous.header['access-control-allow-origin']).to.eq(SHOP);
    expect(anonymous.header['access-control-allow-credentials']).to.eq(undefined);
  });

  it('an empty origins list takes the route out of CORS', async () => {
    expect(acHeaders(await ask(GLOBAL, 'get', '/api/closed', PARTNER))).to.deep.eq([]);
    expect(acHeaders(await askPreflight(GLOBAL, '/api/closed', PARTNER, 'GET'))).to.deep.eq([]);
  });

  it('on a controller it applies to every route; a route-level @Cors wins', async () => {
    expect((await ask(GLOBAL, 'get', '/shop/cart', SHOP)).header['access-control-allow-origin']).to.eq(SHOP);
    expect(acHeaders(await ask(GLOBAL, 'get', '/shop/cart', PARTNER))).to.deep.eq([]);
    expect((await ask(GLOBAL, 'get', '/shop/partner', PARTNER)).header['access-control-allow-origin']).to.eq(PARTNER);
    expect(acHeaders(await ask(GLOBAL, 'get', '/shop/partner', SHOP))).to.deep.eq([]);
  });

  it('works without http.cors: only @Cors routes answer cross-origin', async () => {
    const res = await askPreflight(undefined, '/api/orders', SHOP);
    expect(res.status).to.eq(204);
    expect(res.header['access-control-allow-origin']).to.eq(SHOP);
    expect(acHeaders(await ask(undefined, 'get', '/api/orders', SHOP))).to.deep.eq([]);
  });

  it('refuses options that are not a policy when the class is declared', () => {
    for (const options of [{ origins: ['shop.example.test'] }, { origins: 'https://a.example' }, { origins: [SHOP], maxAge: -1 }, { origins: [SHOP], maxAge: 1.5 }]) {
      expect(() => Cors(options as never), JSON.stringify(options)).to.throw(InvalidOption, '@Cors');
    }
  });
});
