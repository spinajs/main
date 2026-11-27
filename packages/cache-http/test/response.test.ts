import 'mocha';
import { expect } from 'chai';
import { once } from 'node:events';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { InvalidArgument } from '@spinajs/exceptions';
import type { CapturedJsonReply } from '@spinajs/http';
import { CachedResponse, replayableReply, replyToStore } from '../src/index.js';

const JSON_TYPE = 'application/json; charset=utf-8';
const STORED: CapturedJsonReply = { status: 200, headers: { 'content-type': JSON_TYPE, etag: 'W/"b-stored"', 'x-route': 'items' }, body: '{ "a": 1 }' };

interface Sent {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface Replay {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly change?: (response: CachedResponse) => void;
}

async function replay(reply: CapturedJsonReply, { method = 'GET', headers, change }: Replay = {}): Promise<Sent> {
  const app = express();
  // express 5 hands a rejected handler to its error handler
  app.get('/r', async (req, res) => {
    const response = new CachedResponse(reply);
    change?.(response);
    (await response.execute())(req, res);
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    return await new Promise<Sent>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/r', method, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    server.close();
  }
}

const headersOf = (headers: Record<string, string | readonly string[] | undefined>) => ({ getHeader: (name: string) => headers[name] });

describe('CachedResponse', () => {
  it('sends the stored status, headers and bytes, without a replay marker', async () => {
    const sent = await replay(STORED);
    expect(sent.status).to.eq(200);
    expect(sent.body).to.eq('{ "a": 1 }');
    expect(sent.headers['content-type']).to.eq(JSON_TYPE);
    expect(sent.headers.etag).to.eq('W/"b-stored"');
    expect(sent.headers['x-route']).to.eq('items');
    expect(sent.headers['idempotent-replayed']).to.eq(undefined);
  });

  it('never sends a cookie, an authentication answer, a hop-by-hop header, a Date or a replay marker a stored reply holds', async () => {
    const planted = { 'set-cookie': 'sid=alice', 'Set-Cookie2': 'sid=alice', 'authentication-info': 'nextnonce="a"', 'www-authenticate': 'Bearer', connection: 'close', 'keep-alive': 'timeout=99', 'transfer-encoding': 'gzip', 'content-length': '999', date: 'Mon, 01 Jan 2001 00:00:00 GMT', age: '99', 'idempotent-replayed': 'true' };
    const sent = await replay({ ...STORED, headers: { ...STORED.headers, ...planted } });
    expect(sent.body).to.eq('{ "a": 1 }');
    for (const name of ['set-cookie', 'set-cookie2', 'authentication-info', 'www-authenticate', 'age', 'idempotent-replayed']) {
      expect(sent.headers[name], name).to.eq(undefined);
    }
    expect(sent.headers['keep-alive']).to.not.eq(planted['keep-alive']);
    expect(sent.headers['content-length']).to.eq('10');
    expect(sent.headers.date).to.not.eq(planted.date);
    expect(sent.headers['transfer-encoding']).to.eq(undefined);
  });

  it('answers a request with the stored ETag 304, and a HEAD request without the body', async () => {
    const conditional = await replay(STORED, { headers: { 'if-none-match': 'W/"b-stored"' } });
    expect([conditional.status, conditional.body]).to.deep.eq([304, '']);
    const head = await replay(STORED, { method: 'HEAD' });
    expect([head.status, head.body, head.headers.etag]).to.deep.eq([200, '', 'W/"b-stored"']);
  });

  it('sends the data a hook changed as JSON, with a new ETag', async () => {
    const sent = await replay(STORED, {
      change: (response) => {
        response.data = { a: 2 };
      },
    });
    expect(sent.body).to.eq('{"a":2}');
    expect(sent.headers.etag).to.not.eq('W/"b-stored"');
  });

  it('refuses a stored reply it may not send: one without a JSON content type, unsafe headers or a body that does not parse', () => {
    const refused: CapturedJsonReply[] = [{ status: 200, headers: {}, body: '"<script>alert(1)</script>"' }, { ...STORED, headers: { 'content-type': 'text/html' } }, { ...STORED, headers: { ...STORED.headers, 'x-a': 'a\r\nset-cookie: sid=1' } }, { ...STORED, body: '{' }, { ...STORED, status: 500 }];
    for (const reply of refused) expect(() => new CachedResponse(reply), JSON.stringify(reply)).to.throw(InvalidArgument);
  });
});

describe('the stored reply', () => {
  const jsonReply = (more: Partial<CapturedJsonReply> = {}): CapturedJsonReply => ({ ...STORED, ...more });

  it('is a 200 JSON reply only', () => {
    expect(replayableReply(jsonReply())).to.deep.eq(STORED);
    expect(replayableReply(jsonReply({ body: null }))).to.deep.eq({ ...STORED, body: null });
    expect(replayableReply(jsonReply({ headers: { 'content-type': 'application/problem+json' } }))?.status).to.eq(200);
    for (const status of [201, 203, 204, 206, 301, 304, 400, 401, 404, 500, 503]) {
      expect(replayableReply(jsonReply({ status })), String(status)).to.eq(undefined);
    }
    const bodies: unknown[] = ['{', 'undefined', 42, Buffer.from('{}'), { a: 1 }, undefined];
    const headers: unknown[] = [{}, { 'content-type': 'text/html' }, { 'content-type': 'application/jsonp' }, { 'content-type': JSON_TYPE, 'x bad': '1' }, { 'content-type': JSON_TYPE, 'x-a': 'a\r\nset-cookie: sid=1' }, { 'content-type': JSON_TYPE, 'x-a': 1 }, null, ['content-type']];
    const broken: unknown[] = [null, 'reply', [], { status: '200', headers: STORED.headers, body: '{}' }, ...bodies.map((body) => ({ ...STORED, body })), ...headers.map((h) => ({ ...STORED, headers: h }))];
    for (const value of broken) {
      expect(replayableReply(value), JSON.stringify(value)).to.eq(undefined);
    }
  });

  it('leaves out every header no other request may get', () => {
    const reply = jsonReply({ headers: { ...STORED.headers, 'Set-Cookie': 'sid=alice', 'authentication-info': 'x', 'proxy-authentication-info': 'x', connection: 'close', 'transfer-encoding': 'chunked', 'content-length': '3', date: 'x', 'idempotent-replayed': 'true' } });
    expect(replayableReply(reply)?.headers).to.deep.eq(STORED.headers);
  });

  it('leaves out every header its Connection header names', async () => {
    const reply = jsonReply({ headers: { ...STORED.headers, Connection: 'X-Hop, x-tunnel', 'x-hop': 'a', 'x-tunnel': 'b' } });
    expect(replayableReply(reply)?.headers).to.deep.eq(STORED.headers);
    const sent = await replay(reply);
    expect([sent.headers['x-hop'], sent.headers['x-tunnel']]).to.deep.eq([undefined, undefined]);
  });

  it('leaves out Proxy-Authorization', () => {
    expect(replayableReply(jsonReply({ headers: { ...STORED.headers, 'Proxy-Authorization': 'Basic YTpi' } }))?.headers).to.deep.eq(STORED.headers);
  });

  it('is not taken from a response that varies on everything', () => {
    for (const vary of ['*', 'accept, *', ['accept', ' * ']]) {
      expect(replyToStore({ reply: STORED }, headersOf({ vary }), 'principal'), String(vary)).to.eq(undefined);
    }
    expect(replyToStore({ reply: STORED }, headersOf({ vary: 'accept' }), 'principal')).to.deep.eq(STORED);
  });

  it('is not taken from a response that failed, sets a cookie or says no-store, nor from a private one on a wider scope', () => {
    const plain = headersOf({ 'cache-control': 'max-age=60' });
    expect(replyToStore({ reply: STORED }, plain, 'shared')).to.deep.eq({ ...STORED, headers: { 'content-type': JSON_TYPE, etag: 'W/"b-stored"' } });
    expect(replyToStore({ reply: null }, plain, 'principal')).to.eq(undefined);
    expect(replyToStore({ reply: STORED, error: new Error('boom') }, plain, 'principal')).to.eq(undefined);
    expect(replyToStore({ reply: jsonReply({ status: 500 }) }, plain, 'principal')).to.eq(undefined);
    for (const scope of ['principal', 'tenant', 'shared'] as const) {
      expect(replyToStore({ reply: STORED }, headersOf({ 'set-cookie': ['sid=alice'] }), scope), scope).to.eq(undefined);
      expect(replyToStore({ reply: STORED }, headersOf({ 'cache-control': 'max-age=60, No-Store' }), scope), scope).to.eq(undefined);
      expect(replyToStore({ reply: STORED }, headersOf({ 'cache-control': ['public', 'no-store'] }), scope), scope).to.eq(undefined);
    }
    const personal = headersOf({ 'cache-control': 'private, max-age=60' });
    expect(replyToStore({ reply: STORED }, personal, 'principal')).to.deep.eq(STORED);
    expect(replyToStore({ reply: STORED }, personal, 'tenant')).to.eq(undefined);
    expect(replyToStore({ reply: STORED }, personal, 'shared')).to.eq(undefined);
  });

  it('is not taken from a response that says no-cache: it may not be used without asking the origin again', () => {
    for (const scope of ['principal', 'tenant', 'shared'] as const) {
      expect(replyToStore({ reply: STORED }, headersOf({ 'cache-control': 'No-Cache' }), scope), scope).to.eq(undefined);
      expect(replyToStore({ reply: STORED }, headersOf({ 'cache-control': ['private', 'no-cache="x-route"'] }), scope), scope).to.eq(undefined);
    }
  });

  it('is not taken on a wider scope from a response that varies on the cookie or the credentials of its caller', () => {
    for (const vary of ['Cookie', 'accept, authorization', ['origin', ' COOKIE ']]) {
      expect(replyToStore({ reply: STORED }, headersOf({ vary }), 'tenant'), String(vary)).to.eq(undefined);
      expect(replyToStore({ reply: STORED }, headersOf({ vary }), 'shared'), String(vary)).to.eq(undefined);
      expect(replyToStore({ reply: STORED }, headersOf({ vary }), 'principal'), String(vary)).to.deep.eq(STORED);
    }
    // CORS varies every reply on Origin: it changes headers a middleware sets again on a hit, not the body
    expect(replyToStore({ reply: STORED }, headersOf({ vary: 'Origin' }), 'shared')).to.not.eq(undefined);
  });

  it('keeps on a wider scope only the headers that describe the body, and every header of a per-principal reply', () => {
    const described = { 'content-type': JSON_TYPE, etag: 'W/"b"', 'content-language': 'pl', link: '</items?page=2>; rel="next"', 'last-modified': 'Mon, 01 Jan 2001 00:00:00 GMT' };
    const reply = jsonReply({ headers: { ...described, 'x-csrf-token': 'token-of-ann', 'x-route': 'items' } });
    expect(replyToStore({ reply }, headersOf({}), 'shared')).to.deep.eq({ ...reply, headers: described });
    expect(replyToStore({ reply }, headersOf({}), 'tenant')).to.deep.eq({ ...reply, headers: described });
    expect(replyToStore({ reply }, headersOf({}), 'principal')).to.deep.eq(reply);
  });
});
