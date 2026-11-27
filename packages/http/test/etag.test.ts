import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import { configurationViolations } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';

import { dir, httpApp, req, TestConfiguration } from './common.js';
import { BaseController, BasePath, CacheControl, Controllers, etagMatches, FileResponse, Get, HttpServer, Middleware, NotModified, Ok, RouteMiddleware } from '../src/index.js';
import type { HttpEtag, IMiddlewareContext } from '../src/index.js';
import { HTTP_CONFIGURATION_SCHEMA } from '../src/schemas/http.configuration.js';

const VERSION = '"v2"';
let actionRuns = 0;

/** Sets its own ETag; Express then computes none and answers a match with 304 itself. */
class PresetEtag extends RouteMiddleware {
  public onBefore({ res }: IMiddlewareContext): void {
    res.setHeader('ETag', '"v1"');
  }
}

/** Checks If-None-Match against its own version and answers 304 before the action runs. */
class OwnValidator extends RouteMiddleware {
  public onBefore({ req, res }: IMiddlewareContext): NotModified | undefined {
    if (etagMatches(req.headers['if-none-match'], VERSION)) {
      // headers of a body, as an earlier step may have put them on res
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Length', '42');
      res.setHeader('Transfer-Encoding', 'chunked');
      return new NotModified({ Headers: [{ Name: 'ETag', Value: VERSION }] });
    }
    res.setHeader('ETag', VERSION);
    return undefined;
  }
}

@BasePath('etag')
class EtagController extends BaseController {
  @Get()
  public json() {
    return new Ok({ ok: true });
  }

  @Get()
  public file() {
    return new FileResponse({ provider: 'test', path: 'test.txt', filename: 'test.txt' });
  }

  @Get()
  @Middleware(PresetEtag)
  public preset() {
    return new Ok({ ok: true });
  }
}

@BasePath('etag-validated')
@Middleware(CacheControl, 60, { vary: ['Accept-Language'] })
class ValidatedController extends BaseController {
  @Get()
  @Middleware(OwnValidator)
  public item() {
    actionRuns += 1;
    return new Ok({ ok: true });
  }
}

function configurationWith(etag: HttpEtag | undefined) {
  return class extends TestConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      const http = (this.Config as { http: Record<string, unknown> }).http;
      if (etag !== undefined) http.etag = etag;
      http.Static = [
        { Route: '/static', Path: dir('/../src/static') },
        { Route: '/public', Path: dir('/public'), Options: { etag: true } },
      ];
    }
  };
}

async function boot(etag: HttpEtag | undefined): Promise<TestApp> {
  const app = await httpApp({
    configuration: configurationWith(etag),
    register: (c) => {
      c.register(EtagController).as(BaseController);
      c.register(ValidatedController).as(BaseController);
    },
    resolve: [Intl, Controllers],
  });
  await (await app.resolve(HttpServer)).start();
  return app;
}

function headerOf(res: unknown, name: string): string | undefined {
  return (res as { header: Record<string, string | undefined> }).header[name];
}

const WEAK = /^W\/"/;

describe('http.etag', function () {
  this.timeout(30000);

  describe("default ('express')", () => {
    let app: TestApp;

    before(async () => {
      app = await boot(undefined);
    });

    after(async () => {
      await app.dispose();
    });

    it('puts a weak ETag on a JSON reply and answers a match with 304', async () => {
      const first = await req().get('etag/json');
      const etag = headerOf(first, 'etag') ?? '';
      expect(etag).to.match(WEAK);
      const again = await req().get('etag/json').set('If-None-Match', etag);
      expect(again.status).to.eq(304);
    });

    it('puts the weak ETag of send on a file and on a static file', async () => {
      expect(headerOf(await req().get('etag/file'), 'etag')).to.match(WEAK);
      expect(headerOf(await req().get('static/style.css'), 'etag')).to.match(WEAK);
    });

    it('lets a middleware answer 304 before the action runs, without the headers of a body', async () => {
      const runs = actionRuns;
      const fresh = await req().get('etag-validated/item');
      expect(fresh.status).to.eq(200);
      expect(headerOf(fresh, 'etag')).to.eq(VERSION);
      const res = await req().get('etag-validated/item').set('If-None-Match', VERSION);
      expect(res.status).to.eq(304);
      expect(res.text ?? '').to.eq('');
      expect(headerOf(res, 'content-type')).to.eq(undefined);
      expect(headerOf(res, 'content-length')).to.eq(undefined);
      expect(headerOf(res, 'transfer-encoding')).to.eq(undefined);
      expect(headerOf(res, 'etag')).to.eq(VERSION);
      expect(headerOf(res, 'vary')).to.include('Accept-Language');
      expect(headerOf(res, 'cache-control')).to.eq('max-age=60');
      expect(actionRuns).to.eq(runs + 1);
    });
  });

  describe("'weak'", () => {
    let app: TestApp;

    before(async () => {
      app = await boot('weak');
    });

    after(async () => {
      await app.dispose();
    });

    it('puts a weak ETag on a JSON reply', async () => {
      expect(headerOf(await req().get('etag/json'), 'etag')).to.match(WEAK);
    });
  });

  describe("'strong'", () => {
    let app: TestApp;

    before(async () => {
      app = await boot('strong');
    });

    after(async () => {
      await app.dispose();
    });

    it('puts a strong ETag on a JSON reply; a file keeps the weak one of send', async () => {
      expect(headerOf(await req().get('etag/json'), 'etag')).to.match(/^"[0-9a-f]+-/);
      expect(headerOf(await req().get('etag/file'), 'etag')).to.match(WEAK);
    });
  });

  describe('false', () => {
    let app: TestApp;

    before(async () => {
      app = await boot(false);
    });

    after(async () => {
      await app.dispose();
    });

    it('sends no ETag on a JSON reply, a file or a static file without Options.etag', async () => {
      expect(headerOf(await req().get('etag/json'), 'etag')).to.eq(undefined);
      const file = await req().get('etag/file');
      expect(headerOf(file, 'etag')).to.eq(undefined);
      expect(headerOf(file, 'last-modified')).to.be.a('string');
      expect(headerOf(await req().get('static/style.css'), 'etag')).to.eq(undefined);
    });

    it('keeps the ETag of a static entry that sets Options.etag', async () => {
      expect(headerOf(await req().get('public/index.html'), 'etag')).to.match(WEAK);
    });

    it("keeps a middleware's own ETag and answers a match with 304", async () => {
      const res = await req().get('etag/preset');
      expect(headerOf(res, 'etag')).to.eq('"v1"');
      const again = await req().get('etag/preset').set('If-None-Match', '"v1"');
      expect(again.status).to.eq(304);
    });
  });

  it('refuses an unknown http.etag at boot', async () => {
    expect(await configurationViolations({ schemas: [HTTP_CONFIGURATION_SCHEMA], config: { http: { etag: 'medium' } } })).to.include('http.etag');
    expect(await configurationViolations({ schemas: [HTTP_CONFIGURATION_SCHEMA], config: { http: { etag: false } } })).to.deep.eq([]);
  });
});
