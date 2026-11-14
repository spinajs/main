import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import type { TestApp } from '@spinajs/testing';

import { dir, httpApp, req, TestConfiguration } from './common.js';
import { BaseController, BasePath, Controllers, Get, HttpServer, Ok, ServerMiddleware } from '../src/index.js';
import type { IFinishContext, IMiddlewareContext } from '../src/index.js';

const calls: string[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`condition not met in ${ms} ms; calls: ${calls.join(', ')}`);
    await sleep(5);
  }
}

class BeforeStatic extends ServerMiddleware {
  public Order = 4;

  public onBefore(_ctx: IMiddlewareContext): void {
    calls.push('4:before');
  }

  public onFinish(_ctx: IFinishContext): void {
    calls.push('4:finish');
  }
}

class AfterStatic extends ServerMiddleware {
  public Order = 5;

  public onBefore(_ctx: IMiddlewareContext): void {
    calls.push('5:before');
  }

  public onFinish(_ctx: IFinishContext): void {
    calls.push('5:finish');
  }
}

@BasePath('static-order')
class StaticOrderController extends BaseController {
  @Get()
  public ok() {
    return new Ok({ ok: true });
  }
}

/** Boots the test app with `http` keys replaced: `static`, `Static`. */
async function boot(http: Record<string, unknown> = {}): Promise<TestApp> {
  class StaticOrderConfiguration extends TestConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      Object.assign((this.Config as { http: Record<string, unknown> }).http, http);
    }
  }

  const app = await httpApp({
    configuration: StaticOrderConfiguration,
    register: (c) => {
      c.register(StaticOrderController).as(BaseController);
      c.register(BeforeStatic).as(ServerMiddleware);
      c.register(AfterStatic).as(ServerMiddleware);
    },
    resolve: [Intl, Controllers],
  });
  await (await app.resolve(HttpServer)).start();
  return app;
}

describe('Static files at http.static.order', function () {
  this.timeout(15000);

  describe('default 4.5', () => {
    let app: TestApp;

    before(async () => {
      app = await boot();
    });

    after(async () => {
      await app.dispose();
    });

    beforeEach(() => {
      calls.length = 0;
    });

    it('serves a static file before the Order 5 middlewares: they are not entered; the ones before get onFinish', async () => {
      const res = await req().get('public/index.html');
      await until(() => calls.includes('4:finish'));

      expect(res.status).to.eq(200);
      expect(calls).to.deep.eq(['4:before', '4:finish']);
    });

    it('still runs every server middleware for a route', async () => {
      const res = await req().get('static-order/ok').set('Accept', 'application/json');
      await until(() => calls.includes('4:finish'));

      expect(res.status).to.eq(200);
      expect(calls).to.deep.eq(['4:before', '5:before', '5:finish', '4:finish']);
    });

    it('passes a path under the static route that is no file on to the later middlewares and routing', async () => {
      const res = await req().get('public/missing-file.txt').set('Accept', 'application/json');
      await until(() => calls.includes('4:finish'));

      expect(res.status).to.eq(404);
      expect(calls).to.include('5:before');
    });
  });

  describe('Infinity', () => {
    let app: TestApp;

    before(async () => {
      app = await boot({ static: { order: Infinity } });
    });

    after(async () => {
      await app.dispose();
    });

    beforeEach(() => {
      calls.length = 0;
    });

    it('serves static files after every server middleware, as before', async () => {
      const res = await req().get('public/index.html');
      await until(() => calls.includes('4:finish'));

      expect(res.status).to.eq(200);
      expect(calls).to.deep.eq(['4:before', '5:before', '5:finish', '4:finish']);
    });
  });

  describe('the StaticFiles middleware', () => {
    let app: TestApp | undefined;

    afterEach(async () => {
      await app?.dispose();
      app = undefined;
    });

    beforeEach(() => {
      calls.length = 0;
    });

    it('serves every http.Static entry at its own route, each with its own express.static options', async () => {
      app = await boot({
        Static: [
          { Route: '/public', Path: dir('/public') },
          { Route: '/assets', Path: dir('/public'), Options: { maxAge: 3600000, immutable: true } },
        ],
      });

      const plain = await req().get('public/index.html');
      const cached = await req().get('assets/index.html');

      expect([plain.status, cached.status]).to.deep.eq([200, 200]);
      expect(plain.headers['cache-control']).to.eq('public, max-age=0');
      expect(cached.headers['cache-control']).to.eq('public, max-age=3600, immutable');
    });

    it('answers a missing file itself with Options.fallthrough: false, before the later middlewares', async () => {
      app = await boot({ Static: [{ Route: '/public', Path: dir('/public'), Options: { fallthrough: false, dotfiles: 'deny' } }] });

      const missing = await req().get('public/missing-file.txt');
      const dotfile = await req().get('public/.hidden');
      await until(() => calls.filter((c) => c === '4:finish').length === 2);

      expect([missing.status, dotfile.status]).to.deep.eq([404, 403]);
      expect(calls).to.not.include('5:before');
    });

    it('serves nothing with http.static.enabled: false', async () => {
      app = await boot({ static: { enabled: false } });

      const res = await req().get('public/index.html').set('Accept', 'application/json');
      await until(() => calls.includes('4:finish'));

      expect(res.status).to.eq(404);
      expect(calls).to.include('5:before');
    });
  });
});
