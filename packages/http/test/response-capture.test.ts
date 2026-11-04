import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import type { TestApp } from '@spinajs/testing';
import type express from 'express';
import { httpApp, req, TestConfiguration } from './common.js';
import { BaseController, BasePath, BufferResponse, CodedHttpException, Controllers, Created, Get, HttpServer, Middleware, Ok, Post, RouteMiddleware, attachResponseCapture } from '../src/index.js';
import type { CapturedJsonReply } from '../src/index.js';

const captured: CapturedJsonReply[] = [];

const headersOf = (res: { headers: unknown }) => res.headers as Record<string, string>;

const BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

class CaptureProbe extends RouteMiddleware {
  public isEnabled(): boolean {
    return true;
  }

  public async onBefore(_req: express.Request, res: express.Response): Promise<void> {
    attachResponseCapture(res, { capture: (reply) => void captured.push(reply) });
  }

  public async onResponse(): Promise<void> {}

  public async onAfter(): Promise<void> {}
}

@BasePath('capture')
@Middleware(CaptureProbe)
class CaptureController extends BaseController {
  @Post()
  public created() {
    return new Created({ id: 7, name: '<b>' }, { Headers: [{ Name: 'Location', Value: '/capture/7' }] });
  }

  @Get()
  public coded() {
    throw new CodedHttpException(404, 'capture.missing', 'No such thing');
  }

  @Get()
  public empty() {
    return new Ok();
  }

  @Get()
  public bytesInJson() {
    return new Ok({ file: 'a.bin', bytes: BYTES });
  }

  @Get()
  public bytes() {
    return new BufferResponse(BYTES, 'application/octet-stream');
  }
}

describe('ResponseCapture', function () {
  this.timeout(15_000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({ configuration: TestConfiguration, register: (c) => c.register(CaptureController).as(BaseController), resolve: [Intl, Controllers] });
    await (await app.resolve(HttpServer)).start();
  });

  after(() => app.dispose());

  beforeEach(() => {
    captured.length = 0;
  });

  it('sees the JSON text, the status and the headers a replay restores', async () => {
    const res = await req().post('capture/created').set('Accept', 'application/json');

    expect(res.status).to.eq(201);
    expect(captured).to.deep.equal([{ status: 201, headers: { 'content-type': headersOf(res)['content-type'], location: '/capture/7', etag: headersOf(res).etag }, body: res.text }]);
  });

  it('sees the problem document an error answers with', async () => {
    const res = await req().get('capture/coded').set('Accept', 'application/json');

    expect(res.status).to.eq(404);
    expect(captured).to.have.length(1);
    expect(captured[0]).to.deep.include({ status: 404, body: res.text });
    expect(captured[0].headers['content-type']).to.equal(headersOf(res)['content-type']);
  });

  it('records an empty body as null', async () => {
    const res = await req().get('capture/empty').set('Accept', 'application/json');

    expect(res.status).to.eq(200);
    expect(captured).to.have.length(1);
    expect(captured[0]).to.deep.include({ status: 200, body: null });
  });

  it('sees nothing of a reply that is not JSON', async () => {
    const res = await req().post('capture/created').set('Accept', 'text/plain');

    expect(res.status).to.eq(201);
    expect(captured).to.deep.equal([]);
  });

  // a store keeps the reply as JSON: the captured text must come back from it byte for byte
  it('keeps the bytes express sent for a JSON reply holding a Buffer through a JSON round trip', async () => {
    const res = await req().get('capture/bytesInJson').set('Accept', 'application/json');

    expect(res.status).to.eq(200);
    expect(captured).to.have.length(1);
    expect(captured[0].body).to.equal(res.text);

    const stored = JSON.parse(JSON.stringify(captured[0])) as CapturedJsonReply;
    expect(stored).to.deep.equal(captured[0]);
    expect(Buffer.from((JSON.parse(stored.body!) as { bytes: { data: number[] } }).bytes.data).equals(BYTES)).to.equal(true);
  });

  it('sees nothing of a binary reply, which never passes jsonResponse', async () => {
    const res = await req().get('capture/bytes').buffer(true).parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => done(null, Buffer.concat(chunks)));
    });

    expect(res.status).to.eq(200);
    expect((res.body as Buffer).equals(BYTES)).to.equal(true);
    expect(captured).to.deep.equal([]);
  });
});
