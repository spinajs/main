import 'mocha';
import { expect } from 'chai';
import chai from 'chai';
import chaiHttp from 'chai-http';
import express from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';

import { BaseController, BasePath, CsrfExempt, CsrfGuard, Ok, Post, Put, ServerMiddleware, isCsrfExempt } from '../src/index.js';
import { HTTP_CONFIGURATION_SCHEMA } from '../src/schemas/http.configuration.js';
import { boot, disposeBooted, readingFrom, violationsOf } from './support/config-boot.js';

chai.use(chaiHttp);

const HOST = 'app.example.test';
const OWN = `http://${HOST}`;
const PARTNER = 'https://partner.example.test';
const EVIL = 'https://evil.example.test';
const REFUSED = { error: { code: 'E_CSRF_ORIGIN', message: 'Cross-origin request refused' } };

const noopLog = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, security: () => {}, success: () => {} };

@BasePath({ config: 'test.csrf.hooksBase', default: 'hooks' })
class CsrfHooksController extends BaseController {
  @CsrfExempt()
  @Post('inbound/:id')
  public async inbound() {
    return new Ok({ ok: true });
  }

  @Post('other')
  public async other() {
    return new Ok({ ok: true });
  }
}

@CsrfExempt()
@BasePath('callbacks')
class CsrfCallbacksController extends BaseController {
  @Put(':id')
  public async receive() {
    return new Ok({ ok: true });
  }
}

class CsrfInheritingController extends CsrfCallbacksController {}

/** A controller as the route builder sees it, reading `values` as its configuration. */
function controller<T extends BaseController>(type: new () => T, values: Record<string, unknown> = {}): T {
  const c = new type();
  const cfg = { get: (path: string, fallback?: unknown) => (path in values ? values[path] : fallback) };
  for (const [name, value] of Object.entries({ _cfg: cfg, _log: noopLog, _container: DI, _actionLocalStorage: new AsyncLocalStorage() })) {
    Object.defineProperty(c, name, { value });
  }
  return c;
}

class TestGuard extends CsrfGuard {
  public mounted: BaseController[] = [];
  protected controllers() {
    return this.mounted;
  }
}

async function guardWith(csrf: Record<string, unknown> = {}, http: Record<string, unknown> = {}): Promise<TestGuard> {
  const { child } = await boot([HTTP_CONFIGURATION_SCHEMA], { http: { csrf, ...http } });
  const guard = readingFrom(new TestGuard(), child);
  Object.defineProperty(guard, 'Log', { value: noopLog });
  return guard;
}

function appOf(guard: CsrfGuard) {
  const app = express();
  const handler = guard.before();
  if (handler) app.use(handler as express.RequestHandler);
  app.use((_req, res) => {
    res.json({ ran: true });
  });
  return app;
}

interface Sent {
  readonly status: number;
  readonly body: unknown;
}

async function send(guard: CsrfGuard, method: 'get' | 'post' | 'put' | 'delete' | 'patch', path: string, headers: Record<string, string> = {}): Promise<Sent> {
  let r = chai.request(appOf(guard))[method](path).set('Host', HOST);
  for (const [name, value] of Object.entries(headers)) r = r.set(name, value);
  const res = await r;
  return { status: res.status, body: res.body };
}

const passes = (s: Sent): void => {
  expect(s.status, JSON.stringify(s.body)).to.eq(200);
  expect(s.body).to.deep.eq({ ran: true });
};

const refused = (s: Sent): void => {
  expect(s.status).to.eq(403);
  expect(s.body).to.deep.eq(REFUSED);
};

describe('CsrfGuard (X1-X3)', function () {
  this.timeout(20000);
  afterEach(disposeBooted);

  it('is a ServerMiddleware at Order 4, registered by @spinajs/http', () => {
    expect(new CsrfGuard().Order).to.eq(4);
    expect(DI.getRegisteredTypes(ServerMiddleware)).to.include(CsrfGuard);
  });

  describe('default-deny (X1)', () => {
    it('a cross-site POST to any route, with no cookie and no configuration, is refused', async () => {
      const guard = await guardWith();
      refused(await send(guard, 'post', '/brand/new/route', { Origin: EVIL }));
      refused(await send(guard, 'post', '/brand/new/route', { 'Sec-Fetch-Site': 'cross-site' }));
    });

    it('the own origin and a listed origin pass', async () => {
      const guard = await guardWith({ allowedOrigins: ['HTTPS://Partner.Example.Test:443/'] });
      passes(await send(guard, 'post', '/x', { Origin: OWN }));
      passes(await send(guard, 'post', '/x', { Origin: PARTNER }));
      passes(await send(guard, 'post', '/x', { 'Sec-Fetch-Site': 'same-origin' }));
    });

    it('a non-browser request (no Origin, no Sec-Fetch-Site, no ambient cookie) passes', async () => {
      passes(await send(await guardWith(), 'post', '/x'));
      passes(await send(await guardWith({ ambientCookies: ['sid'] }), 'post', '/x', { Cookie: 'theme=dark' }));
    });

    it('an ambient cookie needs the own origin even without browser headers', async () => {
      const guard = await guardWith({ ambientCookies: ['sid'] });
      refused(await send(guard, 'post', '/x', { Cookie: 'a=1; sid=x' }));
      refused(await send(guard, 'post', '/x', { Cookie: 'sid=x', 'Sec-Fetch-Site': 'none' }));
      passes(await send(guard, 'post', '/x', { Cookie: 'sid=x', 'Sec-Fetch-Site': 'same-origin' }));
      passes(await send(guard, 'post', '/x', { Cookie: 'sid=x', Origin: OWN }));
    });

    it('refuses an Origin that is not the serialized origin a browser sends', async () => {
      const guard = await guardWith({ allowedOrigins: [PARTNER] });
      for (const origin of ['null', 'HTTPS://partner.example.test', `${PARTNER}/`, `${PARTNER}.evil.example.test`, `${OWN}:8080`, `https://${HOST}`]) {
        refused(await send(guard, 'post', '/x', { Origin: origin }));
      }
    });

    it('Origin wins over fetch metadata', async () => {
      refused(await send(await guardWith(), 'post', '/x', { Origin: EVIL, 'Sec-Fetch-Site': 'same-origin' }));
    });

    it('checks every unsafe method and no safe one', async () => {
      const guard = await guardWith();
      for (const method of ['post', 'put', 'patch', 'delete'] as const) refused(await send(guard, method, '/x', { Origin: EVIL }));
      passes(await send(guard, 'get', '/x', { Origin: EVIL }));
    });
  });

  describe('configuration', () => {
    it('is off only for enabled: false', async () => {
      expect((await guardWith({ enabled: false })).before()).to.eq(null);
      expect((await guardWith()).before()).to.be.a('function');
    });

    it('a bad allowed origin or exempt entry fails when the middleware is built, even while off', async () => {
      const badOrigin = await guardWith({ enabled: false, allowedOrigins: ['https://x.test:99999'] });
      expect(() => badOrigin.before()).to.throw(InvalidOption, 'http.csrf.allowedOrigins');
      const off = await guardWith({ enabled: false, exempt: ['/hooks/:'] });
      expect(() => off.before()).to.throw(InvalidOption, 'http.csrf.exempt');
    });

    it('the schema fills the defaults and names a bad value', async () => {
      const { configuration } = await boot([HTTP_CONFIGURATION_SCHEMA], {});
      expect(configuration.get('http.csrf')).to.deep.eq({ enabled: true, allowedOrigins: [], exempt: [], ambientCookies: [] });
      const bad = (csrf: unknown) => violationsOf([HTTP_CONFIGURATION_SCHEMA], { http: { csrf } });
      expect(await bad({ enabled: null })).to.include('http.csrf.enabled');
      expect(await bad({ allowedOrigins: ['partner.example.test'] })).to.include('http.csrf.allowedOrigins.0');
      expect(await bad({ exempt: ['hooks'] })).to.include('http.csrf.exempt.0');
      expect(await bad({ ambientCookies: [''] })).to.include('http.csrf.ambientCookies.0');
    });

    it('a registered subclass replaces the guard', async () => {
      class AppGuard extends CsrfGuard {}
      DI.register(AppGuard).as(ServerMiddleware);
      const { child } = await boot([HTTP_CONFIGURATION_SCHEMA], {});
      try {
        expect(readingFrom(new CsrfGuard(), child).before()).to.eq(null);
      } finally {
        DI.unregister(AppGuard);
      }
      expect(readingFrom(new CsrfGuard(), child).before()).to.be.a('function');
    });
  });

  describe('exemptions (X3)', () => {
    it('@CsrfExempt marks a route or a whole controller, inherited too', () => {
      expect(isCsrfExempt(new CsrfHooksController(), 'inbound')).to.eq(true);
      expect(isCsrfExempt(new CsrfHooksController(), 'other')).to.eq(false);
      expect(isCsrfExempt(new CsrfCallbacksController(), 'receive')).to.eq(true);
      expect(isCsrfExempt(new CsrfInheritingController(), 'receive')).to.eq(true);
    });

    it('an exempt route passes cross-site; its neighbours, and other methods on its path, do not', async () => {
      const guard = await guardWith();
      guard.mounted = [controller(CsrfHooksController), controller(CsrfCallbacksController)];
      passes(await send(guard, 'post', '/hooks/inbound/42', { Origin: EVIL }));
      passes(await send(guard, 'post', '/HOOKS/inbound/42/', { Origin: EVIL }));
      passes(await send(guard, 'put', '/callbacks/7', { Origin: EVIL, Cookie: 'sid=x' }));
      refused(await send(guard, 'post', '/hooks/other', { Origin: EVIL }));
      refused(await send(guard, 'put', '/hooks/inbound/42', { Origin: EVIL }));
      refused(await send(guard, 'post', '/hooks/inbound', { Origin: EVIL }));
    });

    it('follows a controller moved by @BasePath({ config }) and the global route prefix', async () => {
      const values = { 'test.csrf.hooksBase': 'moved/hooks', 'http.controllers.route.prefix': 'api' };
      const guard = await guardWith({}, { controllers: { route: { prefix: 'api' } } });
      guard.mounted = [controller(CsrfHooksController, values)];
      passes(await send(guard, 'post', '/api/moved/hooks/inbound/1', { Origin: EVIL }));
      refused(await send(guard, 'post', '/api/hooks/inbound/1', { Origin: EVIL }));
      refused(await send(guard, 'post', '/moved/hooks/inbound/1', { Origin: EVIL }));
    });

    it('picks up a controller added after the server started', async () => {
      const guard = await guardWith();
      const app = appOf(guard);
      const put = () => chai.request(app).put('/callbacks/1').set('Host', HOST).set('Origin', EVIL);
      expect((await put()).status).to.eq(403);
      guard.mounted = [controller(CsrfCallbacksController)];
      expect((await put()).status).to.eq(200);
    });

    it('http.csrf.exempt lists paths behind the route prefix, as the router matches them', async () => {
      const guard = await guardWith({ exempt: ['/webhooks/:provider', '/moved/hooks/inbound/:id'] }, { controllers: { route: { prefix: '/api/' } } });
      passes(await send(guard, 'post', '/api/webhooks/stripe', { Origin: EVIL }));
      passes(await send(guard, 'delete', '/api/Webhooks/stripe/', { Origin: EVIL }));
      passes(await send(guard, 'post', '/api/moved/hooks/inbound/1', { Origin: EVIL }));
      refused(await send(guard, 'post', '/webhooks/stripe', { Origin: EVIL }));
      refused(await send(guard, 'post', '/api/webhooks/stripe/extra', { Origin: EVIL }));
    });
  });
});
