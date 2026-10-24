import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import express from 'express';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { Intl } from '@spinajs/intl';
import { Log } from '@spinajs/log';

import { appOrigin, appPort, releaseHttpServer, TestConfiguration, uncacheControllers } from './common.js';
import { BaseController, BasePath, Controllers, FileResponse, Get, HttpServer } from '../src/index.js';

const PROVIDER = 'sent-files';
const REPORT = 'monthly report';
// Big enough that the client hangs up while send still streams it.
const LARGE = Buffer.alloc(16 * 1024 * 1024, 7);

let root: string;

/** Removes the file once send has found it: send reads every header value only after its stat. */
class VanishingFileResponse extends FileResponse {
  protected fileHeaders(): Record<string, unknown> {
    const headers = super.fileHeaders();
    return Object.defineProperty({ ...headers }, 'X-Vanish', {
      enumerable: true,
      get: () => {
        rmSync(join(root, 'vanishing.txt'), { force: true });
        return '1';
      },
    });
  }
}

@BasePath('sent')
class SentFilesController extends BaseController {
  @Get()
  public report() {
    return new FileResponse({ provider: PROVIDER, path: 'report.txt', filename: 'report.txt' });
  }

  @Get()
  public large() {
    return new FileResponse({ provider: PROVIDER, path: 'large.bin', filename: 'large.bin' });
  }

  @Get()
  public vanishing() {
    writeFileSync(join(root, 'vanishing.txt'), REPORT);
    return new VanishingFileResponse({ provider: PROVIDER, path: 'vanishing.txt', filename: 'vanishing.txt' });
  }

  @Get()
  public directory() {
    return new FileResponse({ provider: PROVIDER, path: 'nested', filename: 'nested' });
  }
}

class SentFilesConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    const config = this.Config as { fs: { providers: unknown[] }; http: Record<string, unknown> };
    config.fs.providers.push({ service: 'fsNative', name: PROVIDER, basePath: root });
    config.http.middlewares = [express.json()];
  }
}

function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`${appOrigin()}/sent/${path}`, { headers });
}

async function bytes(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

/** Settles with the promise of the FileResponse the request runs. */
function executed(): () => Promise<unknown> {
  const execute = sinon.spy(FileResponse.prototype, 'execute');
  return () => execute.firstCall.returnValue;
}

/** The warnings of the `http` logger about a file that failed while it was sent. */
function sendWarnings(): () => unknown[] {
  const warn = sinon.spy(DI.resolve(Log, ['http']), 'warn');
  return () => warn.getCalls().filter((call) => String(call.args[1]).includes('failed after its headers were sent'));
}

/** send's read stream of `name`, replaced by one that sends `head` and then fails with `error`. */
function failingRead(name: string, head: Buffer, error: NodeJS.ErrnoException) {
  const createReadStream = fs.createReadStream;
  sinon.stub(fs, 'createReadStream').callsFake(((path: string, options?: unknown) => {
    if (path !== join(root, name)) {
      return createReadStream(path, options as never);
    }
    return new Readable({
      read() {
        if (head.length > 0) {
          this.push(head);
          head = Buffer.alloc(0);
          return;
        }
        // Later than the first chunk, so it reaches the socket before the failure.
        setTimeout(() => this.destroy(error), 50);
      },
    });
  }) as typeof fs.createReadStream);
}

describe('FileResponse over send', function () {
  this.timeout(15000);

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'sent-files-'));
    writeFileSync(join(root, 'report.txt'), REPORT);
    writeFileSync(join(root, 'large.bin'), LARGE);
    mkdirSync(join(root, 'nested'));

    uncacheControllers();
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
    DI.register(SentFilesConfiguration).as(Configuration);
    DI.register(SentFilesController).as(BaseController);
    await DI.resolve(Configuration);
    // An earlier suite's fsService knows only its own providers.
    DI.uncache(fsService);
    await DI.resolve(fsService);
    await DI.resolve(Intl);
    await DI.resolve(Controllers);
    await (await DI.resolve<HttpServer>(HttpServer)).start();
  });

  after(async () => {
    await releaseHttpServer();
    DI.unregister(SentFilesController as Class<unknown>);
    DI.uncache(SentFilesController);
    DI.uncache(BaseController);
    DI.unregister(SentFilesConfiguration);
    DI.uncache(Configuration);
    DI.uncache(fsService);
    rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => sinon.restore());

  it('sends an attachment with the encoded filename', async () => {
    const res = await get('report');

    expect(res.status).to.eq(200);
    expect(res.headers.get('content-disposition')).to.eq("attachment; filename*=UTF-8''report.txt");
    expect(res.headers.get('content-type')).to.eq('text/plain; charset=utf-8');
    expect(await res.text()).to.eq(REPORT);
  });

  it('answers a range starting past the end with 416, the size, no body and no file headers', async () => {
    const res = await get('report', { Range: 'bytes=1000-' });

    expect(res.status).to.eq(416);
    expect(res.headers.get('content-range')).to.eq(`bytes */${REPORT.length}`);
    expect(res.headers.get('content-disposition')).to.eq(null);
    expect((await bytes(res)).length).to.eq(0);
  });

  it('answers a malformed bytes range with 416', async () => {
    const res = await get('report', { Range: 'bytes=abc' });

    expect(res.status).to.eq(416);
    expect(res.headers.get('content-range')).to.eq(`bytes */${REPORT.length}`);
  });

  it('answers a range in another unit with the whole file', async () => {
    const res = await get('report', { Range: 'items=0-5' });

    expect(res.status).to.eq(200);
    expect(await res.text()).to.eq(REPORT);
  });

  it('answers a suffix range longer than the file with all of it', async () => {
    const res = await get('report', { Range: 'bytes=-1000' });

    expect(res.status).to.eq(206);
    expect(res.headers.get('content-range')).to.eq(`bytes 0-${REPORT.length - 1}/${REPORT.length}`);
    expect(await res.text()).to.eq(REPORT);
  });

  it('answers a suffix range as long as the file with all of it', async () => {
    const res = await get('report', { Range: `bytes=-${REPORT.length}` });

    expect(res.status).to.eq(206);
    expect(await res.text()).to.eq(REPORT);
  });

  it('answers a suffix range with no length with the whole file', async () => {
    const res = await get('report', { Range: 'bytes=-' });

    expect(res.status).to.eq(200);
    expect(res.headers.get('content-range')).to.eq(null);
    expect(await res.text()).to.eq(REPORT);
  });

  it('answers 304 to If-Modified-Since at the file time', async () => {
    const first = await get('report');
    const modified = first.headers.get('last-modified')!;
    await first.arrayBuffer();

    // fetch adds Cache-Control: no-cache to a conditional request unless one is set; send then answers in full.
    const res = await get('report', { 'If-Modified-Since': modified, 'Cache-Control': 'max-age=0' });

    expect(res.status).to.eq(304);
    expect((await bytes(res)).length).to.eq(0);
  });

  it('honours a range whose If-Range date is not older than the file, and sends the whole file for an older one', async () => {
    const first = await get('report');
    const modified = first.headers.get('last-modified')!;
    await first.arrayBuffer();

    const fresh = await get('report', { Range: 'bytes=0-6', 'If-Range': modified });
    expect(fresh.status).to.eq(206);
    expect(await fresh.text()).to.eq(REPORT.slice(0, 7));

    const stale = await get('report', { Range: 'bytes=0-6', 'If-Range': new Date(Date.parse(modified) - 60_000).toUTCString() });
    expect(stale.status).to.eq(200);
    expect(await stale.text()).to.eq(REPORT);
  });

  it('answers 412 to If-Unmodified-Since before the file time, without the file headers', async () => {
    const res = await get('report', { 'If-Unmodified-Since': new Date(0).toUTCString() });

    expect(res.status).to.eq(412);
    expect(res.headers.get('content-disposition')).to.eq(null);
    expect((await bytes(res)).length).to.eq(0);
  });

  it('answers 412 to an If-Match that names another version', async () => {
    const res = await get('report', { 'If-Match': '"another-version"' });

    expect(res.status).to.eq(412);
    expect(res.headers.get('content-disposition')).to.eq(null);
  });

  it('answers 404 without the file headers when the file goes away after send found it', async () => {
    const res = await get('vanishing');

    expect(res.status).to.eq(404);
    // The JSON error body gets an ETag of its own from Express, so that one is not checked.
    for (const header of ['content-disposition', 'accept-ranges', 'last-modified', 'x-vanish']) {
      expect(res.headers.get(header), header).to.eq(null);
    }
    expect(res.headers.get('content-type')).to.match(/^application\/json/);
  });

  it('answers 404 for a directory', async () => {
    const res = await get('directory');

    expect(res.status).to.eq(404);
    expect(res.headers.get('content-disposition')).to.eq(null);
  });

  it('answers a read error before the body with a 500 that carries none of the fs error fields', async () => {
    const error: NodeJS.ErrnoException = Object.assign(new Error(`EACCES: permission denied, open '${join(root, 'report.txt')}'`), {
      code: 'EACCES',
      errno: -13,
      syscall: 'open',
      path: join(root, 'report.txt'),
    });
    failingRead('report.txt', Buffer.alloc(0), error);

    const res = await get('report', { Accept: 'application/json' });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).to.eq(500);
    for (const field of ['code', 'errno', 'syscall', 'path', 'status', 'expose']) {
      expect(body, field).to.not.have.property(field);
    }
    expect(JSON.stringify(body)).to.not.include(root.replace(/\\/g, '\\\\'));
    expect(res.headers.get('content-disposition')).to.eq(null);
  });

  it('closes the connection on a read error after the headers went out, and the action does not fail', async () => {
    const settled = executed();
    const warnings = sendWarnings();
    failingRead('large.bin', LARGE.subarray(0, 1024), Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }));

    const res = await get('large');
    expect(res.status).to.eq(200);
    const body = await bytes(res).then(
      () => 'complete',
      () => 'cut',
    );

    expect(body).to.eq('cut');
    await settled();
    expect(warnings()).to.have.length(1);
  });

  it('lets a client hang up during the body without failing the action or a warning', async () => {
    const settled = executed();
    const warnings = sendWarnings();

    await new Promise<void>((resolve, reject) => {
      const request = httpGet({ host: 'localhost', port: appPort(), path: '/sent/large' }, (res) => {
        res.once('data', () => {
          request.destroy();
          resolve();
        });
      });
      request.on('error', (err) => (request.destroyed ? resolve() : reject(err)));
    });

    await settled();
    expect(warnings()).to.have.length(0);
  });
});
