import 'mocha';
import { expect } from 'chai';
import { createHash, randomBytes } from 'node:crypto';
import { Agent, request } from 'node:http';
import { connect } from 'node:net';
import type { Readable } from 'node:stream';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument, LimitExceeded } from '@spinajs/exceptions';
import { fsService } from '@spinajs/fs';
import { Intl } from '@spinajs/intl';

import { appPort, releaseHttpServer, req, TestConfiguration, uncacheControllers } from './common.js';
import { BaseController, BasePath, Controllers, HttpServer, Ok, Post, Req, RequestStream, RequestStreamArg } from '../src/index.js';
import type { Request } from '../src/index.js';

interface IDrained {
  bytes: number;
  sha256: string;
}

async function drain(body: Readable): Promise<IDrained> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of body) {
    bytes += (chunk as Buffer).length;
    hash.update(chunk as Buffer);
  }
  return { bytes, sha256: hash.digest('hex') };
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const KiB = 1024;
const MiB = 1024 * KiB;

// Raw node:http, so the test controls connection reuse, which superagent does not expose.
function postOctets(agent: Agent, path: string, payload: Buffer): Promise<{ status: number; reusedSocket: boolean }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: 'localhost', port: appPort(), path, method: 'POST', agent, headers: { 'content-type': 'application/octet-stream', 'content-length': payload.length } },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, reusedSocket: outgoing.reusedSocket }));
      },
    );
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}

let reportAbort: (err: unknown) => void = () => undefined;
let reportEntered: () => void = () => undefined;
let readGate: Promise<void> = Promise.resolve();

@BasePath('request-stream')
class RequestStreamController extends BaseController {
  @Post()
  public async bounded(@RequestStream({ maxBytes: KiB }) body: Readable) {
    return new Ok(await drain(body));
  }

  @Post()
  public async megabyte(@RequestStream({ maxBytes: MiB }) body: Readable) {
    return new Ok(await drain(body));
  }

  @Post()
  public async unbounded(@RequestStream() body: Readable, @Req() request: Request) {
    const isRequest = body === request;
    return new Ok({ ...(await drain(body)), isRequest });
  }

  @Post()
  public async abortedBeforeRead(@RequestStream({ maxBytes: MiB }) body: Readable) {
    reportEntered();
    await readGate;
    try {
      await drain(body);
      reportAbort(null);
    } catch (err) {
      reportAbort(err);
    }
    return new Ok({});
  }

  @Post()
  public async aborted(@RequestStream({ maxBytes: MiB }) body: Readable) {
    try {
      await drain(body);
      reportAbort(null);
    } catch (err) {
      reportAbort(err);
    }
    return new Ok({});
  }
}

describe('@RequestStream', function () {
  this.timeout(15000);

  before(async () => {
    uncacheControllers();
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
    DI.register(TestConfiguration).as(Configuration);
    DI.register(RequestStreamController).as(BaseController);
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Intl);
    await DI.resolve(Controllers);
    await (await DI.resolve<HttpServer>(HttpServer)).start();
  });

  after(async () => {
    await releaseHttpServer();
    DI.unregister(RequestStreamController as Class<unknown>);
    DI.uncache(RequestStreamController);
    DI.uncache(BaseController);
    DI.uncache(Configuration);
  });

  const octets = (path: string, payload: Buffer) => req().post(path).set('content-type', 'application/octet-stream').send(payload);

  it('is resolvable from DI by its parameter type name', async () => {
    expect(await DI.resolve('RequestStreamArg')).to.be.instanceOf(RequestStreamArg);
  });

  it('passes a body of exactly maxBytes intact', async () => {
    const payload = randomBytes(KiB);
    const res = await octets('request-stream/bounded', payload);
    expect(res).to.have.status(200);
    expect(res.body as IDrained).to.deep.eq({ bytes: KiB, sha256: sha256(payload) });
  });

  it('passes an empty body', async () => {
    const res = await octets('request-stream/bounded', Buffer.alloc(0));
    expect(res).to.have.status(200);
    expect((res.body as IDrained).bytes).to.eq(0);
  });

  it('answers 413 at maxBytes + 1', async () => {
    const res = await octets('request-stream/bounded', randomBytes(KiB + 1));
    expect(res).to.have.status(413);
  });

  it('answers 413 to a client that is still sending a body far over the limit', async () => {
    const res = await octets('request-stream/megabyte', randomBytes(4 * MiB));
    expect(res).to.have.status(413);
  });

  it('keeps the connection open for the next request after a 413', async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const refused = await postOctets(agent, '/request-stream/bounded', randomBytes(64 * KiB));
      const accepted = await postOctets(agent, '/request-stream/bounded', randomBytes(10));
      expect(refused.status).to.eq(413);
      expect(accepted).to.deep.eq({ status: 200, reusedSocket: true });
    } finally {
      agent.destroy();
    }
  });

  it('hands the request itself to the action without maxBytes', async () => {
    const payload = randomBytes(3 * MiB);
    const res = await octets('request-stream/unbounded', payload);
    expect(res).to.have.status(200);
    expect(res.body).to.deep.eq({ bytes: payload.length, sha256: sha256(payload), isRequest: true });
  });

  it('reads a content type that no body parser takes', async () => {
    const res = await req().post('request-stream/unbounded').set('content-type', 'text/plain').send('hello');
    expect(res).to.have.status(200);
    expect((res.body as IDrained).bytes).to.eq(5);
  });

  for (const [type, payload] of [
    ['application/json', '{"a":1}'],
    ['application/x-www-form-urlencoded', 'a=1'],
    ['application/xml', '<a>1</a>'],
  ] as const) {
    it(`answers 415 for ${type}, whose body a parser already took`, async () => {
      const res = await req().post('request-stream/unbounded').set('content-type', type).send(payload);
      expect(res).to.have.status(415);
    });
  }

  it('fails the stream with the request error when the client aborts', async () => {
    const outcome = new Promise<unknown>((resolve) => (reportAbort = resolve));
    const socket = connect(appPort(), 'localhost', () => {
      socket.write('POST /request-stream/aborted HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/octet-stream\r\nContent-Length: 1000\r\n\r\n');
      socket.write(Buffer.alloc(10));
      setTimeout(() => socket.destroy(), 100);
    });

    const err = (await outcome) as NodeJS.ErrnoException;
    expect(err).to.be.instanceOf(Error);
    expect(err).to.not.be.instanceOf(LimitExceeded);
    expect(err.code).to.eq('ECONNRESET');
  });

  it('stays up when the client aborts while the action awaits before reading', async () => {
    const uncaught: unknown[] = [];
    const record = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', record);
    let openGate: () => void = () => undefined;
    readGate = new Promise((resolve) => (openGate = resolve));
    const entered = new Promise<void>((resolve) => (reportEntered = resolve));
    const outcome = new Promise<unknown>((resolve) => (reportAbort = resolve));
    try {
      const socket = connect(appPort(), 'localhost', () => {
        socket.write('POST /request-stream/abortedBeforeRead HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/octet-stream\r\nContent-Length: 1000\r\n\r\n');
        socket.write(Buffer.alloc(10));
      });
      socket.on('error', () => undefined);
      await entered;
      socket.destroy();
      await new Promise((resolve) => setTimeout(resolve, 100));
      openGate();

      const err = (await outcome) as NodeJS.ErrnoException;
      expect(err).to.be.instanceOf(Error);
      expect(err.code).to.eq('ECONNRESET');
      const next = await octets('request-stream/bounded', randomBytes(10));
      expect(next).to.have.status(200);
    } finally {
      openGate();
      process.off('uncaughtException', record);
    }
    expect(uncaught).to.deep.eq([]);
  });

  it('refuses a maxBytes that is not a non-negative integer', () => {
    for (const maxBytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => RequestStream({ maxBytes })).to.throw(InvalidArgument);
    }
  });
});
