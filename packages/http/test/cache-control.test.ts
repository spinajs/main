import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import { InvalidArgument } from '@spinajs/exceptions';
import type { TestApp } from '@spinajs/testing';

import { httpApp, req, TestConfiguration } from './common.js';
import { BaseController, BasePath, CacheControl, Controllers, Get, HttpServer, Middleware, NO_STORE, NoStore, NotFound, Ok, Post } from '../src/index.js';

class CacheControlFailure extends Error {}

@BasePath('cache-control')
@Middleware(CacheControl, 300)
class CacheControlController extends BaseController {
  @Get()
  public plain() {
    return new Ok({ ok: true });
  }

  @Get()
  @Middleware(CacheControl, 60, { private: true, staleWhileRevalidate: 30, immutable: true })
  public tuned() {
    return new Ok({ ok: true });
  }

  @Get()
  public failing() {
    throw new CacheControlFailure('failed');
  }

  @Get()
  public missing() {
    return new NotFound({ error: 'missing' });
  }

  @Get()
  public own() {
    return new Ok({ ok: true }, { Headers: [{ Name: 'Cache-Control', Value: 'no-cache' }] });
  }

  @Post()
  public write() {
    return new Ok({ ok: true });
  }
}

@BasePath('no-store')
@Middleware(NoStore)
class NoStoreController extends BaseController {
  @Get()
  public plain() {
    return new Ok({ token: 'secret' });
  }

  @Get()
  public failing() {
    throw new CacheControlFailure('failed');
  }

  @Get()
  public own() {
    return new Ok({ ok: true }, { Headers: [{ Name: 'Cache-Control', Value: 'public, max-age=60' }] });
  }
}

@BasePath('global-no-store')
class GlobalNoStoreController extends BaseController {
  @Get()
  public plain() {
    return new Ok({ ok: true });
  }
}

class GlobalNoStoreConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    (this.Config as { http: Record<string, unknown> }).http.routes = { middlewares: ['NoStore'] };
  }
}

function headerOf(res: unknown, name: string): string | undefined {
  return (res as { header: Record<string, string | undefined> }).header[name];
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('CacheControl and NoStore route middlewares', function () {
  this.timeout(15000);

  describe('on routes', () => {
    let app: TestApp;

    before(async () => {
      app = await httpApp({
        register: (c) => {
          c.register(CacheControlController).as(BaseController);
          c.register(NoStoreController).as(BaseController);
        },
        resolve: [Intl, Controllers],
      });
      await (await app.resolve(HttpServer)).start();
    });

    after(async () => {
      await app.dispose();
    });

    it('marks a success reply cacheable for maxAge seconds', async () => {
      const res = await req().get('cache-control/plain');
      expect(res.status).to.eq(200);
      expect(headerOf(res, 'cache-control')).to.eq('public, max-age=300');
    });

    it('writes the options, the route one winning over the controller one', async () => {
      const res = await req().get('cache-control/tuned');
      expect(headerOf(res, 'cache-control')).to.eq('private, max-age=60, stale-while-revalidate=30, immutable');
    });

    it('answers an error reply with no-store', async () => {
      const res = await req().get('cache-control/failing');
      expect(res.status).to.eq(500);
      expect(headerOf(res, 'cache-control')).to.eq('no-store');
    });

    it('answers a returned 4xx reply with no-store', async () => {
      const res = await req().get('cache-control/missing');
      expect(res.status).to.eq(404);
      expect(headerOf(res, 'cache-control')).to.eq('no-store');
    });

    it("keeps the answer's own Cache-Control", async () => {
      const res = await req().get('cache-control/own');
      expect(headerOf(res, 'cache-control')).to.eq('no-cache');
    });

    it('leaves a write route alone', async () => {
      const res = await req().post('cache-control/write');
      expect(res.status).to.eq(200);
      expect(headerOf(res, 'cache-control')).to.be.undefined;
    });

    it('NoStore marks a success reply no-store with Pragma: no-cache', async () => {
      const res = await req().get('no-store/plain');
      expect(res.status).to.eq(200);
      expect(headerOf(res, 'cache-control')).to.eq('no-store');
      expect(headerOf(res, 'pragma')).to.eq('no-cache');
    });

    it('NoStore marks an error reply too', async () => {
      const res = await req().get('no-store/failing');
      expect(res.status).to.eq(500);
      expect(headerOf(res, 'cache-control')).to.eq('no-store');
      expect(headerOf(res, 'pragma')).to.eq('no-cache');
    });

    it("NoStore wins over the answer's own Cache-Control", async () => {
      const res = await req().get('no-store/own');
      expect(headerOf(res, 'cache-control')).to.eq('no-store');
    });
  });

  describe('declared in http.routes.middlewares', () => {
    let app: TestApp;

    before(async () => {
      app = await httpApp({
        configuration: GlobalNoStoreConfiguration,
        register: (c) => c.register(GlobalNoStoreController).as(BaseController),
        resolve: [Intl, Controllers],
      });
      await (await app.resolve(HttpServer)).start();
    });

    after(async () => {
      await app.dispose();
    });

    it('NoStore resolves by name', async () => {
      const res = await req().get('global-no-store/plain');
      expect(headerOf(res, 'cache-control')).to.eq('no-store');
    });
  });

  it('refuses a negative or fractional maxAge', () => {
    expect(thrownBy(() => new CacheControl(-1))).to.be.instanceOf(InvalidArgument);
    expect(thrownBy(() => new CacheControl(1.5))).to.be.instanceOf(InvalidArgument);
    expect(thrownBy(() => new CacheControl(10, { staleWhileRevalidate: -1 }))).to.be.instanceOf(InvalidArgument);
  });

  it('exports one frozen NO_STORE header for per-answer use', () => {
    expect(NO_STORE).to.deep.eq({ Name: 'Cache-Control', Value: 'no-store' });
    expect(Object.isFrozen(NO_STORE)).to.eq(true);
  });
});
