import 'mocha';
import { expect } from 'chai';
import express from 'express';
import compression from 'compression';
import helmet from 'helmet';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Intl } from '@spinajs/intl';

import { appOrigin, httpApp, TestConfiguration } from './common.js';
import { BaseController, BasePath, Controllers, FileResponse, Get, HttpServer, Param, ZipResponse } from '../src/index.js';
import type { TestApp } from '@spinajs/testing';

const PROVIDER = 'inline-files';
const CSP = "default-src 'none'; style-src 'unsafe-inline'";
// Above compression's 1 KiB threshold, so a compressed answer would show.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg">${'<rect width="1" height="1"/>'.repeat(64)}</svg>`;
const TILE = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
const FILE_HEADERS = { 'Cache-Control': 'private, no-transform', 'Content-Security-Policy': CSP };

let root: string;

/** Removes the file once send has found it: send reads every header value only after its stat. */
class VanishingFileResponse extends FileResponse {
  protected fileHeaders(): Record<string, unknown> {
    return Object.defineProperty({ ...super.fileHeaders() }, 'X-Vanish', {
      enumerable: true,
      get: () => {
        rmSync(join(root, 'vanishing.svg'), { force: true });
        return '1';
      },
    });
  }
}

const artifact = (path: string) =>
  new FileResponse({
    provider: PROVIDER,
    path,
    filename: path,
    disposition: 'inline',
    headers: FILE_HEADERS,
  });

@BasePath('inline')
class InlineFilesController extends BaseController {
  @Get('a/:name')
  public artifact(@Param() name: string) {
    return artifact(name);
  }

  @Get()
  public unnamed() {
    return new FileResponse({ provider: PROVIDER, path: 'tile.bin', disposition: 'inline' });
  }

  @Get()
  public typed() {
    return new FileResponse({ provider: PROVIDER, path: 'tile.bin', disposition: 'inline', mimeType: 'application/vnd.termik.tile' });
  }

  @Get()
  public download() {
    return new FileResponse({ provider: PROVIDER, path: 'report.txt', filename: 'raport miesięczny.txt' });
  }

  @Get()
  public unnamedDownload() {
    return new FileResponse({ provider: PROVIDER, path: 'report.txt' });
  }

  @Get()
  public zipped() {
    return new ZipResponse({ provider: PROVIDER, path: 'report.txt' });
  }

  @Get()
  public vanishing() {
    writeFileSync(join(root, 'vanishing.svg'), SVG);
    return new VanishingFileResponse({ provider: PROVIDER, path: 'vanishing.svg', disposition: 'inline', headers: FILE_HEADERS });
  }
}

class InlineFilesConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    const config = this.Config as { fs: { providers: unknown[] }; http: Record<string, unknown> };
    config.fs.providers.push({ service: 'fsNative', name: PROVIDER, basePath: root });
    config.http.middlewares = this.middlewares();
  }

  protected middlewares(): unknown[] {
    // helmet would set nosniff and a CSP of its own on every answer.
    return [express.json(), compression()];
  }
}

const MIDDLEWARE_CACHE_CONTROL = 'no-store';

class PresetHeadersConfiguration extends InlineFilesConfiguration {
  protected middlewares(): unknown[] {
    const presetCacheControl: express.RequestHandler = (_req, res, next) => {
      res.setHeader('Cache-Control', MIDDLEWARE_CACHE_CONTROL);
      next();
    };
    // ts-node types the default import as the module, the build as the function; both take this cast.
    const securityHeaders = (helmet as unknown as () => express.RequestHandler)();
    return [securityHeaders, presetCacheControl, express.json()];
  }
}

let app: TestApp | undefined;

async function startWith(configuration: typeof InlineFilesConfiguration) {
  app = await httpApp({
    configuration,
    register: (c) => c.register(InlineFilesController).as(BaseController),
    resolve: [Intl, Controllers],
  });
  await (await app.resolve(HttpServer)).start();
}

async function stop() {
  await app?.dispose();
  app = undefined;
}

function get(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return fetch(`${appOrigin()}/inline/${path}`, { method, headers: { 'Accept-Encoding': 'gzip', ...headers } });
}

async function bytes(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

// One root for both suites: a file provider keeps the base path it was first resolved with.
before(() => {
  root = mkdtempSync(join(tmpdir(), 'inline-files-'));
  writeFileSync(join(root, 'plan.svg'), SVG);
  writeFileSync(join(root, 'tile.bin'), TILE);
  writeFileSync(join(root, 'report.txt'), 'monthly report');
});

after(() => rmSync(root, { recursive: true, force: true }));

describe('FileResponse inline', function () {
  this.timeout(15000);

  before(() => startWith(InlineFilesConfiguration));

  after(() => stop());

  it('serves the file inline with its type from the extension and the file headers', async () => {
    const res = await get('a/plan.svg');

    expect(res.status).to.eq(200);
    expect(res.headers.get('content-disposition')).to.eq("inline; filename*=UTF-8''plan.svg");
    expect(res.headers.get('content-type')).to.eq('image/svg+xml');
    expect(res.headers.get('x-content-type-options')).to.eq('nosniff');
    expect(res.headers.get('cache-control')).to.eq('private, no-transform');
    expect(res.headers.get('content-security-policy')).to.eq(CSP);
    expect(res.headers.get('accept-ranges')).to.eq('bytes');
    expect(res.headers.get('etag')).to.match(/^W\/".+"$/);
    expect(res.headers.get('content-encoding')).to.eq(null);
    expect(res.headers.get('content-length')).to.eq(String(SVG.length));
    expect(await res.text()).to.eq(SVG);
  });

  it('sends a bare inline disposition without a filename, and octet-stream for an unknown extension', async () => {
    const res = await get('unnamed');

    expect(res.status).to.eq(200);
    expect(res.headers.get('content-disposition')).to.eq('inline');
    expect(res.headers.get('content-type')).to.eq('application/octet-stream');
    expect(Buffer.compare(await bytes(res), TILE)).to.eq(0);
  });

  it('takes an explicit content type over the extension', async () => {
    const res = await get('typed');

    expect(res.headers.get('content-type')).to.eq('application/vnd.termik.tile');
  });

  it('answers one byte range with 206', async () => {
    const res = await get('a/tile.bin', { Range: 'bytes=4-11' });

    expect(res.status).to.eq(206);
    expect(res.headers.get('content-range')).to.eq(`bytes 4-11/${TILE.length}`);
    expect(res.headers.get('content-length')).to.eq('8');
    expect(Buffer.compare(await bytes(res), TILE.subarray(4, 12))).to.eq(0);
  });

  it('answers a suffix range with the last bytes', async () => {
    const res = await get('a/tile.bin', { Range: 'bytes=-4' });

    expect(res.status).to.eq(206);
    expect(res.headers.get('content-range')).to.eq(`bytes 60-63/${TILE.length}`);
    expect(Buffer.compare(await bytes(res), TILE.subarray(60))).to.eq(0);
  });

  it('keeps a range of a compressible file exact when the file headers say no-transform', async () => {
    const res = await get('a/plan.svg', { Range: 'bytes=0-1499' });

    expect(res.status).to.eq(206);
    expect(res.headers.get('content-encoding')).to.eq(null);
    expect(await res.text()).to.eq(SVG.slice(0, 1500));
  });

  it('answers the whole file for several ranges', async () => {
    const res = await get('a/tile.bin', { Range: 'bytes=0-1,10-11' });

    expect(res.status).to.eq(200);
    expect(Buffer.compare(await bytes(res), TILE)).to.eq(0);
  });

  it('answers an unsatisfiable range with 416, the size, no body and no file headers', async () => {
    const res = await get('a/tile.bin', { Range: `bytes=${TILE.length}-` });

    expect(res.status).to.eq(416);
    expect(res.headers.get('content-range')).to.eq(`bytes */${TILE.length}`);
    expect(res.headers.get('content-disposition')).to.eq(null);
    expect(res.headers.get('content-security-policy')).to.eq(null);
    expect((await bytes(res)).length).to.eq(0);
  });

  it('answers 304 to If-None-Match with the current ETag', async () => {
    const first = await get('a/tile.bin');
    const etag = first.headers.get('etag')!;
    await first.arrayBuffer();

    // fetch adds Cache-Control: no-cache to a conditional request unless one is set; send then answers in full.
    const res = await get('a/tile.bin', { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' });

    expect(res.status).to.eq(304);
    expect(res.headers.get('etag')).to.eq(etag);
    expect((await bytes(res)).length).to.eq(0);
  });

  it('answers the whole file to a conditional request that says no-cache', async () => {
    const first = await get('a/tile.bin');
    const etag = first.headers.get('etag')!;
    await first.arrayBuffer();

    const res = await get('a/tile.bin', { 'If-None-Match': etag, 'Cache-Control': 'no-cache' });

    expect(res.status).to.eq(200);
    expect(Buffer.compare(await bytes(res), TILE)).to.eq(0);
  });

  it('honours a range whose If-Range names the current ETag, and sends the whole file for another', async () => {
    const first = await get('a/tile.bin');
    const etag = first.headers.get('etag')!;
    await first.arrayBuffer();

    const fresh = await get('a/tile.bin', { Range: 'bytes=0-3', 'If-Range': etag });
    expect(fresh.status).to.eq(206);
    expect(Buffer.compare(await bytes(fresh), TILE.subarray(0, 4))).to.eq(0);

    const stale = await get('a/tile.bin', { Range: 'bytes=0-3', 'If-Range': '"another-version"' });
    expect(stale.status).to.eq(200);
    expect(Buffer.compare(await bytes(stale), TILE)).to.eq(0);
  });

  it('answers 412 to an If-Match that names another version, without the file headers', async () => {
    const res = await get('a/tile.bin', { 'If-Match': '"another-version"' });

    expect(res.status).to.eq(412);
    expect(res.headers.get('content-disposition')).to.eq(null);
    expect(res.headers.get('content-security-policy')).to.eq(null);
  });

  it('answers HEAD with the headers and no body', async () => {
    const whole = await get('a/tile.bin', {}, 'HEAD');
    expect(whole.status).to.eq(200);
    expect(whole.headers.get('content-length')).to.eq(String(TILE.length));
    expect(whole.headers.get('content-disposition')).to.eq("inline; filename*=UTF-8''tile.bin");

    const ranged = await get('a/tile.bin', { Range: 'bytes=0-9' }, 'HEAD');
    expect(ranged.status).to.eq(206);
    expect(ranged.headers.get('content-length')).to.eq('10');
    expect((await bytes(ranged)).length).to.eq(0);
  });

  it('answers 404 without the file headers for a missing file', async () => {
    const res = await get('a/missing.svg');

    expect(res.status).to.eq(404);
    expect(res.headers.get('content-disposition')).to.eq(null);
    expect(res.headers.get('content-security-policy')).to.eq(null);
  });

  it('answers 404 without the file headers when the file goes away after send found it', async () => {
    const res = await get('vanishing');

    expect(res.status).to.eq(404);
    // The problem body gets an ETag of its own from Express, so that one is not checked.
    for (const header of ['content-disposition', 'content-security-policy', 'accept-ranges', 'last-modified', 'x-content-type-options', 'x-vanish']) {
      expect(res.headers.get(header), header).to.eq(null);
    }
    expect(res.headers.get('cache-control')).to.not.eq('private, no-transform');
    expect(res.headers.get('content-type')).to.match(/^application\/problem\+json/);
  });

  it('keeps an attachment the default, with the encoded filename and no inline-only headers', async () => {
    const res = await get('download');

    expect(res.status).to.eq(200);
    expect(res.headers.get('content-disposition')).to.eq(`attachment; filename*=UTF-8''${encodeURIComponent('raport miesięczny.txt')}`);
    expect(res.headers.get('content-type')).to.eq('text/plain; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).to.eq(null);
    expect(await res.text()).to.eq('monthly report');
  });

  it('names an attachment without a filename after the last segment of its path', async () => {
    const res = await get('unnamedDownload');

    expect(res.headers.get('content-disposition')).to.eq("attachment; filename*=UTF-8''report.txt");
  });

  it('names a zip without a filename after its path, with .zip added', async () => {
    const res = await get('zipped');

    expect(res.status).to.eq(200);
    expect(res.headers.get('content-disposition')).to.eq("attachment; filename*=UTF-8''report.txt.zip");
    expect(res.headers.get('content-type')).to.eq('application/zip');
  });
});

describe('FileResponse inline behind middlewares that set the same headers', function () {
  this.timeout(15000);

  before(() => startWith(PresetHeadersConfiguration));

  after(() => stop());

  /** helmet's CSP and the middleware's Cache-Control, from an answer that never reached the file. */
  async function middlewareHeaders() {
    const res = await get('a/missing.svg');
    await res.arrayBuffer();
    expect(res.status).to.eq(404);
    return { csp: res.headers.get('content-security-policy'), cacheControl: res.headers.get('cache-control') };
  }

  it('sends the file headers over the middleware values', async () => {
    const res = await get('a/tile.bin');

    expect(res.status).to.eq(200);
    expect(res.headers.get('cache-control')).to.eq('private, no-transform');
    expect(res.headers.get('content-security-policy')).to.eq(CSP);
  });

  it('gives a 412 the middleware values back', async () => {
    const before = await middlewareHeaders();
    expect(before.cacheControl).to.eq(MIDDLEWARE_CACHE_CONTROL);
    expect(before.csp).to.be.a('string').and.not.eq(CSP);

    const res = await get('a/tile.bin', { 'If-Match': '"another-version"' });

    expect(res.status).to.eq(412);
    expect(res.headers.get('cache-control')).to.eq(MIDDLEWARE_CACHE_CONTROL);
    expect(res.headers.get('content-security-policy')).to.eq(before.csp);
    expect(res.headers.get('content-disposition')).to.eq(null);
  });

  it('gives a 404 of a file gone after send found it the middleware values back', async () => {
    const before = await middlewareHeaders();

    const res = await get('vanishing');

    expect(res.status).to.eq(404);
    expect(res.headers.get('cache-control')).to.eq(MIDDLEWARE_CACHE_CONTROL);
    expect(res.headers.get('content-security-policy')).to.eq(before.csp);
  });
});
