import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import express from 'express';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DI } from '@spinajs/di';
import { Intl } from '@spinajs/intl';
import { Log } from '@spinajs/log';

import { appOrigin, appPort, httpApp, TestConfiguration } from './common.js';
import { BaseController, BasePath, Controllers, FileResponse, Get, HttpServer } from '../src/index.js';
import type { TestApp } from '@spinajs/testing';

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

/** Drops a header a middleware set, once send has found the file and before it fails. */
class HeaderDroppingResponse extends FileResponse {
  private res?: express.Response;

  public execute(req: express.Request, res: express.Response): Promise<void> {
    this.res = res;
    return super.execute(req, res);
  }

  protected fileHeaders(): Record<string, unknown> {
    const headers = super.fileHeaders();
    return Object.defineProperty({ ...headers }, 'X-Vanish', {
      enumerable: true,
      get: () => {
        this.res!.removeHeader('X-Middleware');
        rmSync(join(root, 'dropping.txt'), { force: true });
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
  public dropping() {
    writeFileSync(join(root, 'dropping.txt'), REPORT);
    return new HeaderDroppingResponse({ provider: PROVIDER, path: 'dropping.txt', filename: 'dropping.txt' }, { Headers: [{ Name: 'X-Middleware', Value: 'kept' }] });
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

let plainServer: Server | undefined;

/** What express' own sendFile answers `range` with: range-parser as send runs it, with no rewrite in front. */
async function plainSend(range: string) {
  if (!plainServer) {
    const app = express();
    app.get('/report', (_req, res) => res.sendFile(join(root, 'report.txt')));
    await new Promise<void>((resolve) => {
      plainServer = app.listen(0, '127.0.0.1', () => resolve());
    });
  }
  const { port } = plainServer!.address() as AddressInfo;
  return answerOf(await fetch(`http://127.0.0.1:${port}/report`, { headers: { Range: range } }));
}

/** The body only for a success: plain express renders its own page for a 416. */
async function answerOf(res: Response) {
  const body = await res.text();
  return { status: res.status, contentRange: res.headers.get('content-range'), ...(res.ok ? { body } : {}) };
}

async function bytes(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

/** Settles with the promise of the FileResponse the request runs. */
function executed(): () => Promise<unknown> {
  const execute = sinon.spy(FileResponse.prototype, 'execute');
  return () => execute.firstCall.returnValue;
}

/** The errors send's callback gets, in order; `undefined` for a successful send. */
function sendFileErrors(): () => (NodeJS.ErrnoException | undefined)[] {
  const errors: (NodeJS.ErrnoException | undefined)[] = [];
  const sendFile = Reflect.get(express.response, 'sendFile') as (...args: unknown[]) => void;
  sinon.stub(express.response, 'sendFile').callsFake(function (this: unknown, ...args: unknown[]) {
    const done = args[args.length - 1] as (err?: NodeJS.ErrnoException) => void;
    args[args.length - 1] = (err?: NodeJS.ErrnoException) => {
      errors.push(err);
      done(err);
    };
    return sendFile.apply(this, args);
  });
  return () => errors;
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

  let app: TestApp;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'sent-files-'));
    writeFileSync(join(root, 'report.txt'), REPORT);
    writeFileSync(join(root, 'large.bin'), LARGE);
    mkdirSync(join(root, 'nested'));

    app = await httpApp({
      configuration: SentFilesConfiguration,
      register: (c) => c.register(SentFilesController).as(BaseController),
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await new Promise((resolve) => (plainServer ? plainServer.close(resolve) : resolve(undefined)));
    plainServer = undefined;
    await app.dispose();
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

  it('rewrites a suffix with leading zeros like the same number', async () => {
    const long = await get('report', { Range: 'bytes=-0001000' });
    expect(long.status).to.eq(206);
    expect(await long.text()).to.eq(REPORT);

    const short = await get('report', { Range: 'bytes=-005' });
    expect(short.status).to.eq(206);
    expect(await short.text()).to.eq(REPORT.slice(-5));
  });

  it('leaves every other spelling of a suffix range to range-parser, as send answers it', async () => {
    const ranges = [
      'bytes=	-1000',
      'bytes=-	1000',
      'bytes= -1000',
      'bytes= -1000',
      'bytes=- 1000',
      'bytes= -',
      'BYTES=-1000',
      'Bytes=-',
      'bytes=-5,-6',
      'bytes=-1000,-2000',
      `bytes=-${'9'.repeat(20)}`,
      // 71 characters, past the 64 the rewrite reads; range-parser takes it as a 1000-byte suffix.
      `bytes=-${'0'.repeat(60)}1000`,
      `bytes=${' '.repeat(8000)}-1000`,
    ];

    for (const range of ranges) {
      expect(await answerOf(await get('report', { Range: range })), JSON.stringify(range)).to.deep.eq(await plainSend(range));
    }
  });

  it('rejects a long range header without scanning it', async () => {
    const response = new FileResponse({ provider: PROVIDER, path: 'report.txt' }) as unknown as { wholeFileForLongSuffix(req: unknown, file: string): Promise<void> };
    const range = `bytes=${' '.repeat(16 * 1024)}-${'1'.repeat(16 * 1024)}x`;
    const req = { headers: { range }, rawHeaders: ['Range', range] };

    const started = process.hrtime.bigint();
    await response.wholeFileForLongSuffix(req, join(root, 'report.txt'));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    expect(req.headers.range).to.eq(range);
    expect(ms).to.be.below(1000);
  });

  it('leaves a repeated range header to range-parser', async () => {
    const request = sinon.spy(FileResponse.prototype, 'execute');
    const answer = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const url = new URL(`${appOrigin()}/sent/report`);
      httpGet({ host: url.hostname, port: url.port, path: url.pathname, headers: { Range: ['bytes=-1000', 'bytes=-2000'] } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
    await request.firstCall.returnValue;

    expect(answer.status).to.eq(416);
    expect(request.firstCall.args[0].headers.range).to.eq('bytes=-1000, bytes=-2000');
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
    expect(res.headers.get('content-type')).to.match(/^application\/problem\+json/);
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
    for (const field of ['code', 'errno', 'syscall', 'path', 'expose']) {
      expect(body, field).to.not.have.property(field);
    }
    expect(body.status).to.eq(500);
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
    const sendErrors = sendFileErrors();

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
    expect(sendErrors().map((err) => err?.code)).to.deep.eq(['ECONNABORTED']);
    expect(warnings()).to.have.length(0);
  });

  it('puts back the range header a long suffix or a bare dash made it rewrite', async () => {
    const request = sinon.spy(FileResponse.prototype, 'execute');

    for (const range of ['bytes=-99999', 'bytes=-']) {
      request.resetHistory();
      const res = await get('report', { Range: range });
      expect(res.ok, range).to.eq(true);
      await request.firstCall.returnValue;
      expect(request.firstCall.args[0].headers.range, range).to.eq(range);
    }
  });

  it('puts back the range header when the send fails', async () => {
    const request = sinon.spy(FileResponse.prototype, 'execute');
    failingRead('report.txt', Buffer.alloc(0), Object.assign(new Error('EIO'), { code: 'EIO' }));

    const res = await get('report', { Range: 'bytes=-99999' });
    await request.firstCall.returnValue.catch(() => undefined);

    expect(res.status).to.eq(500);
    expect(request.firstCall.args[0].headers.range).to.eq('bytes=-99999');
  });

  it('puts back a header a middleware set and the send removed before it failed', async () => {
    const res = await get('dropping');

    expect(res.status).to.eq(404);
    expect(res.headers.get('x-middleware')).to.eq('kept');
  });
});
