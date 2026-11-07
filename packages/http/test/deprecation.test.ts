import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import { InvalidArgument } from '@spinajs/exceptions';
import type { TestApp } from '@spinajs/testing';

import { httpApp, req } from './common.js';
import { BaseController, BasePath, Controllers, Deprecated, DeprecationMiddleware, Get, HttpServer, Ok } from '../src/index.js';

const SINCE = new Date('2026-01-01T00:00:00Z');
const SUNSET = new Date('2026-12-31T23:59:59Z');

class DeprecationFailure extends Error {}

@BasePath('deprecated')
class DeprecatedController extends BaseController {
  @Get()
  @Deprecated()
  public bare() {
    return new Ok({ ok: true });
  }

  @Get()
  @Deprecated({ since: SINCE, sunset: SUNSET, link: 'https://example.com/docs/v2' })
  public full() {
    return new Ok({ ok: true });
  }

  @Get()
  @Deprecated({ link: 'https://example.com/docs/v2' })
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
@Deprecated({ sunset: SUNSET })
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
      },
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  it('answers Deprecation: true when no date is given', async () => {
    const res = await req().get('deprecated/bare');
    expect(res.status).to.eq(200);
    expect(headerOf(res, 'deprecation')).to.eq('true');
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
    expect(headerOf(res, 'deprecation')).to.eq('true');
    expect(headerOf(res, 'sunset')).to.eq('Thu, 31 Dec 2026 23:59:59 GMT');
  });

  it("answers the route's own declaration over the controller's, once", async () => {
    const res = await req().get('deprecated-controller/own');
    expect(headerOf(res, 'deprecation')).to.eq(`@${SINCE.getTime() / 1000}`);
    expect(headerOf(res, 'sunset')).to.be.undefined;
    expect(headerOf(res, 'link')).to.eq('<https://example.com/docs/v3>; rel="deprecation"');
  });

  it('refuses an invalid date, a sunset before the deprecation and an empty link', () => {
    expect(thrownBy(() => new DeprecationMiddleware({ since: new Date('nope') }))).to.be.instanceOf(InvalidArgument);
    expect(thrownBy(() => new DeprecationMiddleware({ since: SUNSET, sunset: SINCE }))).to.be.instanceOf(InvalidArgument);
    expect(thrownBy(() => new DeprecationMiddleware({ link: '' }))).to.be.instanceOf(InvalidArgument);
    expect(thrownBy(() => Deprecated({ link: 'https://example.com/a>b' }))).to.be.instanceOf(InvalidArgument);
  });
});
