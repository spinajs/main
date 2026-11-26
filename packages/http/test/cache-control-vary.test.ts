import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import type { TestApp } from '@spinajs/testing';

import { httpApp, req, TestConfiguration } from './common.js';
import { BaseController, BasePath, CacheControl, Controllers, Get, HttpServer, Middleware, NotFound, Ok, RouteMiddleware } from '../src/index.js';
import type { IReplyContext } from '../src/index.js';

const PARTNER = 'http://partner.example';

class VaryFailure extends Error {}

/** Appends to Vary in onAfter, as another package's hook would. */
class LateVary extends RouteMiddleware {
  public onAfter({ res }: IReplyContext): void {
    res.vary('X-Late');
  }
}

@BasePath('cache-vary')
class CacheVaryController extends BaseController {
  @Get()
  @Middleware(CacheControl, 60, { vary: ['Accept-Language'] })
  public plain() {
    return new Ok({ ok: true });
  }

  @Get()
  @Middleware(CacheControl, 60, { vary: ['Accept-Language', 'origin'] })
  public repeated() {
    return new Ok({ ok: true });
  }

  @Get()
  @Middleware(CacheControl, 60, { vary: ['Accept-Language'] })
  @Middleware(LateVary)
  public ownThenLate() {
    return new Ok({ ok: true }, { Headers: [{ Name: 'Vary', Value: 'Accept' }] });
  }

  @Get()
  @Middleware(CacheControl, 60, { vary: ['*'] })
  public anything() {
    return new Ok({ ok: true });
  }

  @Get()
  @Middleware(CacheControl, 60, { vary: ['Accept-Language'] })
  public failing() {
    throw new VaryFailure('failed');
  }

  @Get()
  @Middleware(CacheControl, 60, { vary: ['Accept-Language'] })
  public missing() {
    return new NotFound({ error: 'missing' }, { Headers: [{ Name: 'Cache-Control', Value: 'max-age=30' }] });
  }

  @Get()
  @Middleware(CacheControl, 60, { public: true, vary: ['Cookie'] })
  public shared() {
    return new Ok({ ok: true });
  }
}

class CorsConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    const http = (this.Config as { http: Record<string, unknown> }).http;
    http.cors = { origins: [PARTNER] };
    // compression adds Accept-Encoding to the Vary of every JSON reply; off, Vary holds what CORS and the route put there
    http.compression = { enabled: false };
  }
}

function headerOf(res: unknown, name: string): string | undefined {
  return (res as { header: Record<string, string | undefined> }).header[name];
}

const fieldsOf = (res: unknown): string[] =>
  (headerOf(res, 'vary') ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '')
    .sort();

describe('CacheControl vary', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      configuration: CorsConfiguration,
      register: (c) => c.register(CacheVaryController).as(BaseController),
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  it('appends the declared fields to the Vary CORS set', async () => {
    const res = await req().get('cache-vary/plain').set('Origin', PARTNER);
    expect(res.status).to.eq(200);
    expect(headerOf(res, 'vary')).to.eq('Origin, Accept-Language');
    expect(headerOf(res, 'cache-control')).to.eq('max-age=60');
  });

  it('names each field once, whatever its case', async () => {
    const res = await req().get('cache-vary/repeated').set('Origin', PARTNER);
    expect(headerOf(res, 'vary')).to.eq('Origin, Accept-Language');
  });

  it("keeps the answer's own Vary and a later hook's", async () => {
    const res = await req().get('cache-vary/ownThenLate').set('Origin', PARTNER);
    expect(fieldsOf(res)).to.deep.eq(['Accept', 'Accept-Language', 'Origin', 'X-Late']);
  });

  it('sends Vary: * alone', async () => {
    const res = await req().get('cache-vary/anything').set('Origin', PARTNER);
    expect(headerOf(res, 'vary')).to.eq('*');
  });

  it('adds nothing to an error reply', async () => {
    const res = await req().get('cache-vary/failing').set('Origin', PARTNER);
    expect(res.status).to.eq(500);
    expect(headerOf(res, 'cache-control')).to.eq('no-store');
    expect(fieldsOf(res)).to.not.include('Accept-Language');
  });

  it('adds the fields to an error reply that brought its own Cache-Control', async () => {
    const res = await req().get('cache-vary/missing').set('Origin', PARTNER);
    expect(res.status).to.eq(404);
    expect(headerOf(res, 'cache-control')).to.eq('max-age=30');
    expect(headerOf(res, 'vary')).to.eq('Origin, Accept-Language');
  });

  it('keeps public, with its vary, when nothing makes the reply personal', async () => {
    const res = await req().get('cache-vary/shared').set('Origin', PARTNER);
    expect(headerOf(res, 'cache-control')).to.eq('public, max-age=60');
    expect(headerOf(res, 'vary')).to.eq('Origin, Cookie');
  });
});
