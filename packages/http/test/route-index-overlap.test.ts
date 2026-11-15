import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import type { TestApp } from '@spinajs/testing';

import { httpApp, req, TestConfiguration } from './common.js';
import { BaseController, BasePath, Controllers, Cors, CsrfExempt, Get, HttpServer, Ok, Post, RouteIndex } from '../src/index.js';

const PARTNER = 'https://partner.example.test';
const EVIL = 'https://evil.example.test';
const SHOP = 'https://shop.example.test';

// Two controllers on one base path whose routes overlap: the DI resolves both at once, so their routes are built
// interleaved while each controller's router is mounted as a whole.
@BasePath('overlap')
class OverlapFirstController extends BaseController {
  @Get()
  public a1() {
    return new Ok({ by: 'first-a1' });
  }

  @Post(':id')
  public byId() {
    return new Ok({ by: 'first-byId' });
  }

  @Get(':id')
  public getById() {
    return new Ok({ by: 'first-getById' });
  }
}

@BasePath('overlap')
class OverlapSecondController extends BaseController {
  @CsrfExempt()
  @Post('special')
  public special() {
    return new Ok({ by: 'second-special' });
  }

  @Cors({ origins: [EVIL] })
  @Get('public')
  public pub() {
    return new Ok({ by: 'second-public' });
  }

  @Get()
  public b3() {
    return new Ok({});
  }

  @Get()
  public b4() {
    return new Ok({});
  }
}

@Cors({ origins: [SHOP], maxAge: 300 })
@BasePath('shop-api')
class ShopApiController extends BaseController {
  @Post('orders')
  public order() {
    return new Ok({ ordered: true });
  }

  @Get('orders')
  public orders() {
    return new Ok([]);
  }
}

class OverlapConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    (this.Config as { http: Record<string, unknown> }).http.cors = { origins: [PARTNER] };
  }
}

const byOf = (res: { body: unknown }) => (res.body as { by?: string }).by;

describe('RouteIndex through the real server: overlapping controllers', function () {
  this.timeout(20000);

  let app: TestApp;
  let routes: RouteIndex;

  before(async () => {
    app = await httpApp({
      configuration: OverlapConfiguration,
      register: (c) => {
        c.register(OverlapFirstController).as(BaseController);
        c.register(OverlapSecondController).as(BaseController);
        c.register(ShopApiController).as(BaseController);
      },
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
    routes = await app.resolve(RouteIndex);
  });

  after(async () => {
    await app?.dispose();
  });

  it('matches the route the router serves the request with', async () => {
    for (const [method, path] of [
      ['post', 'overlap/special'],
      ['get', 'overlap/public'],
      ['get', 'overlap/42'],
    ] as const) {
      const res = await req()[method](path).set('Accept', 'application/json').send(method === 'post' ? {} : undefined);
      const match = routes.match(method.toUpperCase(), `/${path}`);
      const served = byOf(res);
      expect(served, path).to.be.a('string');
      expect(`${match?.controller.constructor.name === 'OverlapFirstController' ? 'first' : 'second'}-${String(match?.route.Method)}`, path).to.eq(served);
    }
  });

  it('does not exempt from CSRF a request a non-exempt route could serve, whichever controller mounted first', async () => {
    const res = await req().post('overlap/special').set('Origin', EVIL).set('Sec-Fetch-Site', 'cross-site').set('Accept', 'application/json').send({});
    expect(res.status).to.eq(403);
  });

  it("gives no route's @Cors policy to a request another route serves", async () => {
    const res = await req().get('overlap/public').set('Origin', EVIL).set('Accept', 'application/json');
    expect(res.status).to.eq(200);
    if (byOf(res) === 'first-getById') {
      expect(res.header['access-control-allow-origin']).to.eq(undefined);
    } else {
      expect(res.header['access-control-allow-origin']).to.eq(EVIL);
    }
    const preflight = await req().options('overlap/public').set('Origin', EVIL).set('Access-Control-Request-Method', 'GET');
    expect(preflight.header['access-control-allow-origin']).to.eq(undefined);
  });

  it('answers a @Cors route by its policy: preflight, reply and Vary', async () => {
    const preflight = await req().options('shop-api/orders').set('Origin', SHOP).set('Access-Control-Request-Method', 'POST');
    expect(preflight.status).to.eq(204);
    expect(preflight.header['access-control-allow-origin']).to.eq(SHOP);
    expect(preflight.header['access-control-max-age']).to.eq('300');

    const shop = await req().get('shop-api/orders').set('Origin', SHOP).set('Accept', 'application/json');
    expect(shop.status).to.eq(200);
    expect(shop.header['access-control-allow-origin']).to.eq(SHOP);
    expect(shop.header['vary']).to.match(/origin/i);

    const partner = await req().get('shop-api/orders').set('Origin', PARTNER).set('Accept', 'application/json');
    expect(partner.header['access-control-allow-origin']).to.eq(undefined);
  });
});
