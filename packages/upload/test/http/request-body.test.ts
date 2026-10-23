import 'mocha';
import chai, { expect } from 'chai';
import chaiHttp from 'chai-http';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';

import { declaredLength, settleUnreadBody } from '../../src/http/request-body.js';
import { rawRequest, wait } from './support/raw.js';

chai.use(chaiHttp);

type Before = (req: http.IncomingMessage) => void | Promise<void>;

async function refuse(req: http.IncomingMessage, res: http.ServerResponse, bound: number, before: Before): Promise<void> {
  await before(req);
  await settleUnreadBody(req, res, bound);
  res.statusCode = 400;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ code: 'refused' }));
}

const listenersOf = (req: http.IncomingMessage) => ({
  data: req.listenerCount('data'),
  end: req.listenerCount('end'),
  close: req.listenerCount('close'),
  error: req.listenerCount('error'),
  readable: req.listenerCount('readable'),
});
type Listeners = ReturnType<typeof listenersOf>;

interface Settled {
  readonly before: Listeners;
  readonly after: Listeners;
  readonly destroyed: boolean;
}

describe('settleUnreadBody', function () {
  this.timeout(15000);

  const servers: http.Server[] = [];
  const OCTETS = { 'content-type': 'application/octet-stream' };

  function listen(server: http.Server): Promise<number> {
    servers.push(server);
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  }

  /** A server that refuses every request without reading it, the way putPart's refusals do. */
  function refusing(bound: number, before: Before = () => undefined): Promise<number> {
    return listen(
      http.createServer((req, res) => {
        void refuse(req, res, bound, before);
      }),
    );
  }

  /** A refusing server that reports the listeners on the first request around settleUnreadBody. */
  async function observing(bound: number): Promise<{ port: number; settled: Promise<Settled> }> {
    let report: (settled: Settled) => void = () => undefined;
    const settled = new Promise<Settled>((resolve) => (report = resolve));
    const settle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
      const before = listenersOf(req);
      await settleUnreadBody(req, res, bound);
      report({ before, after: listenersOf(req), destroyed: req.destroyed });
      res.statusCode = 400;
      res.end();
    };
    const port = await listen(
      http.createServer((req, res) => {
        void settle(req, res);
      }),
    );
    return { port, settled };
  }

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      server.close();
    }
  });

  it('reads the declared length from Content-Length only', () => {
    const of = (headers: http.IncomingHttpHeaders) => declaredLength({ headers } as http.IncomingMessage);
    expect([of({ 'content-length': '4' }), of({ 'content-length': '0' }), of({}), of({ 'content-length': '4.5' }), of({ 'content-length': '99999999999999999999' })]).to.deep.equal([4, 0, undefined, undefined, undefined]);
  });

  it('holds the answer until a body within the bound has arrived, and keeps the connection', async () => {
    const exchange = rawRequest(await refusing(4), 'PUT', '/', { ...OCTETS, 'content-length': 4 });
    exchange.write(Buffer.from('ab'));
    await wait(300);
    expect(exchange.answered(), 'answered while the client was still sending').to.eq(false);

    exchange.end(Buffer.from('cd'));
    const res = await exchange.response;
    expect([res.status, res.body, res.headers.connection]).to.deep.equal([400, '{"code":"refused"}', 'keep-alive']);
  });

  it('drains a body that was piped into a consumer nobody reads', async () => {
    const exchange = rawRequest(await refusing(4, (req) => void req.pipe(new PassThrough({ highWaterMark: 1 }))), 'PUT', '/', { ...OCTETS, 'content-length': 4 });
    exchange.end(Buffer.from('abcd'));

    const res = await exchange.response;
    expect([res.status, res.headers.connection]).to.deep.equal([400, 'keep-alive']);
  });

  // The body stays in flight in the next two; one that has arrived whole keeps the connection (below).
  it('answers at once with Connection: close when the body declares more than the bound', async () => {
    const exchange = rawRequest(await refusing(4), 'PUT', '/', { ...OCTETS, 'content-length': 10 });
    exchange.write(Buffer.alloc(2, 97));

    const res = await exchange.response;
    expect([res.status, res.headers.connection]).to.deep.equal([400, 'close']);
  });

  it('answers with Connection: close when the body has no Content-Length', async () => {
    const exchange = rawRequest(await refusing(4), 'PUT', '/', { ...OCTETS, 'transfer-encoding': 'chunked' });
    exchange.write(Buffer.from('abcd'));

    const res = await exchange.response;
    expect([res.status, res.headers.connection]).to.deep.equal([400, 'close']);
  });

  it('keeps the connection of a request without a body', async () => {
    const exchange = rawRequest(await refusing(4), 'GET', '/', {});
    exchange.end();

    const res = await exchange.response;
    expect([res.status, res.headers.connection]).to.deep.equal([400, 'keep-alive']);
  });

  it('keeps the connection when an unread body over the bound has already arrived whole', async () => {
    const arrived: Before = async (req) => {
      while (!req.complete) await wait(5);
    };
    const exchange = rawRequest(await refusing(4, arrived), 'PUT', '/', { ...OCTETS, 'content-length': 10 });
    exchange.end(Buffer.alloc(10, 97));

    const res = await exchange.response;
    expect([res.status, res.headers.connection]).to.deep.equal([400, 'keep-alive']);
  });

  it('returns at once for a body that was already read, whatever its length', async () => {
    const readAll: Before = async (req) => {
      for await (const _chunk of req) {
        // reading only
      }
    };
    const exchange = rawRequest(await refusing(0, readAll), 'PUT', '/', { ...OCTETS, 'content-length': 4 });
    exchange.end(Buffer.from('abcd'));

    const res = await exchange.response;
    expect([res.status, res.headers.connection]).to.deep.equal([400, 'keep-alive']);
  });

  it('lets a superagent client that sends a large bounded body piped into an unread consumer see the refusal', async () => {
    const MiB8 = 8 * 1024 * 1024;
    const port = await refusing(MiB8, (req) => void req.pipe(new PassThrough({ highWaterMark: 1 })));

    const res = await chai.request(`http://127.0.0.1:${port}`).put('/').set('Content-Type', 'application/octet-stream').send(Buffer.alloc(MiB8, 97));
    expect([res.status, res.body]).to.deep.equal([400, { code: 'refused' }]);
  });

  it('leaves no listeners of its own on the request after a drain', async () => {
    const { port, settled } = await observing(4);
    const exchange = rawRequest(port, 'PUT', '/', { ...OCTETS, 'content-length': 4 });
    exchange.end(Buffer.from('abcd'));
    await exchange.response;

    const { before, after } = await settled;
    expect(after).to.deep.equal(before);
  });

  it('stops draining, without leftover listeners, when the client goes away mid-body', async () => {
    const { port, settled } = await observing(4);
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => undefined);
    socket.write('PUT / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/octet-stream\r\nContent-Length: 4\r\n\r\nab');
    await wait(100);
    socket.destroy();

    const { before, after, destroyed } = await settled;
    expect([destroyed, after]).to.deep.equal([true, before]);
  });

  it('returns at once for a destroyed request, without touching it or the response', async () => {
    const req = new http.IncomingMessage(new net.Socket());
    req.headers['content-length'] = '4';
    const res = new http.ServerResponse(req);
    req.destroy();
    const before = listenersOf(req);

    await settleUnreadBody(req, res, 4);
    expect([listenersOf(req), req.readableFlowing, res.getHeader('connection')]).to.deep.equal([before, null, undefined]);
  });
});
