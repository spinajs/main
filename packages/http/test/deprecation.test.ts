import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import { InvalidArgument } from '@spinajs/exceptions';
import type { TestApp } from '@spinajs/testing';

import { httpApp, req } from './common.js';
import { NewInstance } from '@spinajs/di';
import type { ClassInfo } from '@spinajs/di';
import { BaseController, BasePath, CacheControllerMetadata, Controllers, Deprecated, DeprecationMiddleware, Get, HttpServer, Middleware, Ok, withDeprecatedRoutes } from '../src/index.js';

const SINCE = new Date('2026-01-01T00:00:00Z');
const SUNSET = new Date('2026-12-31T23:59:59Z');
const EARLIER = new Date('2025-06-01T00:00:00Z');
const SHARED = { since: SINCE, link: 'https://example.com/docs/shared' };

class OwnDeprecation extends DeprecationMiddleware {}

@NewInstance()
class SwappedDeprecation extends DeprecationMiddleware {}

class DeprecationFailure extends Error {}

@BasePath('deprecated')
class DeprecatedController extends BaseController {
  @Get()
  @Deprecated({ since: SINCE })
  public bare() {
    return new Ok({ ok: true });
  }

  @Get()
  @Deprecated({ since: SINCE, sunset: SUNSET, link: 'https://example.com/docs/v2' })
  public full() {
    return new Ok({ ok: true });
  }

  @Get()
  @Deprecated({ since: SINCE, link: 'https://example.com/docs/v2' })
  public linked() {
    return new Ok({ ok: true }, { Headers: [{ Name: 'Link', Value: '<https://example.com/items?page=2>; rel="next"' }] });
  }

  @Get()
  @Deprecated({ since: SINCE })
  public failing() {
    throw new DeprecationFailure('failed');
  }

  @Get()
  public current() {
    return new Ok({ ok: true });
  }
}

@BasePath('deprecated-controller')
@Deprecated({ since: EARLIER, sunset: SUNSET })
class DeprecatedWholeController extends BaseController {
  @Get()
  public any() {
    return new Ok({ ok: true });
  }

  @Get()
  @Deprecated({ since: SINCE, link: 'https://example.com/docs/v3' })
  public own() {
    return new Ok({ ok: true });
  }
}

@BasePath('deprecated-shared')
@Deprecated(SHARED)
class DeprecatedSharedController extends BaseController {
  @Get()
  @Deprecated(SHARED)
  public shared() {
    return new Ok({ ok: true });
  }
}

@BasePath('deprecated-subclass')
@Middleware(OwnDeprecation, { since: EARLIER })
class DeprecatedSubclassController extends BaseController {
  @Get()
  @Middleware(OwnDeprecation, { since: SINCE })
  public own() {
    return new Ok({ ok: true });
  }
}

@BasePath('deprecated-swapped')
@Deprecated({ since: EARLIER })
class DeprecatedSwappedController extends BaseController {
  @Get()
  @Deprecated({ since: SINCE })
  public own() {
    return new Ok({ ok: true });
  }
}

class DeprecatedChildController extends DeprecatedWholeController {
  @Get()
  public added() {
    return new Ok({ ok: true });
  }
}

class PartlyDeprecatedController extends BaseController {
  @Get()
  @Middleware(DeprecationMiddleware, { since: SINCE })
  public direct() {
    return new Ok({ ok: true });
  }

  @Get()
  public current() {
    return new Ok({ ok: true });
  }
}

const infoOf = (type: { name: string }) => ({ name: type.name, type, file: '<di>' }) as unknown as ClassInfo<BaseController>;

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

describe('@Deprecated ( DeprecationMiddleware )', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      register: (c) => {
        c.register(DeprecatedController).as(BaseController);
        c.register(DeprecatedWholeController).as(BaseController);
        c.register(DeprecatedSharedController).as(BaseController);
        c.register(DeprecatedSubclassController).as(BaseController);
      },
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  it('answers the deprecation date alone when nothing else is given', async () => {
    const res = await req().get('deprecated/bare');
    expect(res.status).to.eq(200);
    expect(headerOf(res, 'deprecation')).to.eq(`@${SINCE.getTime() / 1000}`);
    expect(headerOf(res, 'sunset')).to.be.undefined;
    expect(headerOf(res, 'link')).to.be.undefined;
  });

  it('answers the RFC 9745 date, the RFC 8594 Sunset and the deprecation link', async () => {
    const res = await req().get('deprecated/full');
    expect(headerOf(res, 'deprecation')).to.eq(`@${SINCE.getTime() / 1000}`);
    expect(headerOf(res, 'sunset')).to.eq('Thu, 31 Dec 2026 23:59:59 GMT');
    expect(headerOf(res, 'link')).to.eq('<https://example.com/docs/v2>; rel="deprecation"');
  });

  it("joins the deprecation link to the answer's own Link", async () => {
    const res = await req().get('deprecated/linked');
    expect(headerOf(res, 'link')).to.eq('<https://example.com/items?page=2>; rel="next", <https://example.com/docs/v2>; rel="deprecation"');
  });

  it('marks an error reply too', async () => {
    const res = await req().get('deprecated/failing');
    expect(res.status).to.eq(500);
    expect(headerOf(res, 'deprecation')).to.eq(`@${SINCE.getTime() / 1000}`);
  });

  it('leaves a route without the decorator alone', async () => {
    const res = await req().get('deprecated/current');
    expect(headerOf(res, 'deprecation')).to.be.undefined;
  });

  it('marks every route of a decorated controller', async () => {
    const res = await req().get('deprecated-controller/any');
    expect(headerOf(res, 'deprecation')).to.eq(`@${EARLIER.getTime() / 1000}`);
    expect(headerOf(res, 'sunset')).to.eq('Thu, 31 Dec 2026 23:59:59 GMT');
  });

  it("answers the route's own declaration over the controller's, once", async () => {
    const res = await req().get('deprecated-controller/own');
    expect(headerOf(res, 'deprecation')).to.eq(`@${SINCE.getTime() / 1000}`);
    expect(headerOf(res, 'sunset')).to.be.undefined;
    expect(headerOf(res, 'link')).to.eq('<https://example.com/docs/v3>; rel="deprecation"');
  });

  it('answers once when the class and the route share one options object', async () => {
    const res = await req().get('deprecated-shared/shared');
    expect(headerOf(res, 'link')).to.eq('<https://example.com/docs/shared>; rel="deprecation"');
  });

  it("answers a subclass's route declaration over its controller declaration", async () => {
    const res = await req().get('deprecated-subclass/own');
    expect(headerOf(res, 'deprecation')).to.eq(`@${SINCE.getTime() / 1000}`);
  });

  it('refuses a missing since, an invalid date, a sunset before the deprecation and an empty link', () => {
    expect(thrownBy(() => Deprecated({} as never))).to.be.instanceOf(InvalidArgument);
    expect(thrownBy(() => Deprecated(undefined as never))).to.be.instanceOf(InvalidArgument);
    expect(thrownBy(() => new DeprecationMiddleware(undefined as never))).to.be.instanceOf(InvalidArgument);
    expect(thrownBy(() => new DeprecationMiddleware({ since: new Date('nope') }))).to.be.instanceOf(InvalidArgument);
    expect(thrownBy(() => new DeprecationMiddleware({ since: SUNSET, sunset: SINCE }))).to.be.instanceOf(InvalidArgument);
    expect(thrownBy(() => new DeprecationMiddleware({ since: SINCE, link: '' }))).to.be.instanceOf(InvalidArgument);
    expect(thrownBy(() => Deprecated({ since: SINCE, link: 'https://example.com/a>b' }))).to.be.instanceOf(InvalidArgument);
  });

  describe('route documentation', () => {
    it('marks every route of a deprecated controller, inherited and added ones too', () => {
      const doc = withDeprecatedRoutes(infoOf(DeprecatedChildController), { className: 'DeprecatedChildController', methods: { any: { params: {}, summary: 'Any' } } });
      expect(doc.methods.any).to.deep.eq({ params: {}, summary: 'Any', deprecated: true });
      expect(doc.methods.own.deprecated).to.eq(true);
      expect(doc.methods.added.deprecated).to.eq(true);
    });

    it('marks a route with a DeprecationMiddleware mounted by @Middleware, and only that one', () => {
      const doc = withDeprecatedRoutes(infoOf(PartlyDeprecatedController), { className: 'PartlyDeprecatedController', methods: {} });
      expect(doc.methods.direct.deprecated).to.eq(true);
      expect(doc.methods).to.not.have.property('current');
    });

    it('the cache metadata provider marks them for a controller without a source file', async () => {
      const doc = await new CacheControllerMetadata().documentation(infoOf(PartlyDeprecatedController));
      expect(doc.methods.direct.deprecated).to.eq(true);
    });
  });
});

describe('@Deprecated with DeprecationMiddleware swapped in DI', function () {
  this.timeout(15000);

  let swapped: TestApp;

  before(async () => {
    swapped = await httpApp({
      register: (c) => {
        c.register(SwappedDeprecation).as(DeprecationMiddleware);
        c.register(DeprecatedSwappedController).as(BaseController);
      },
      resolve: [Intl, Controllers],
    });
    await (await swapped.resolve(HttpServer)).start();
  });

  after(async () => {
    await swapped.dispose();
  });

  it("answers the route's own declaration over the controller's", async () => {
    const res = await req().get('deprecated-swapped/own');
    expect(headerOf(res, 'deprecation')).to.eq(`@${SINCE.getTime() / 1000}`);
  });
});
