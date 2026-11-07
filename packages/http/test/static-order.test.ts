import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import type { TestApp } from '@spinajs/testing';

import { httpApp, req, TestConfiguration } from './common.js';
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

async function boot(order?: number): Promise<TestApp> {
  class StaticOrderConfiguration extends TestConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      if (order !== undefined) {
        (this.Config as { http: Record<string, unknown> }).http.static = { order };
      }
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
      app = await boot(Infinity);
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
});
