import 'mocha';
import { expect } from 'chai';
import { DEFAULT_FORWARDED_HEADERS, forwardedHeaders, serverClientOptions, type IncomingHeaders } from '../../src/runtime/index.js';

const incoming = {
  cookie: 'session=abc',
  authorization: 'Bearer t0k',
  host: 'evil.example',
  connection: 'keep-alive, x-trace',
  'content-length': '42',
  'x-forwarded-for': '10.0.0.1',
  'x-forwarded-host': 'evil.example',
  'x-forwarded-proto': 'http',
  forwarded: 'for=10.0.0.1',
  'transfer-encoding': 'chunked',
  te: 'trailers',
  upgrade: 'websocket',
  'keep-alive': 'timeout=5',
  'proxy-authorization': 'Basic eA==',
  'x-trace': 'abc',
  'accept-language': 'pl',
};

const getOnly = (record: Record<string, string>): IncomingHeaders => ({ get: (name: string) => record[name.toLowerCase()] ?? null });

const SHAPES: [string, IncomingHeaders][] = [
  ['a Headers', new Headers(incoming)],
  ['a plain record', incoming],
  ['an object with get(name)', getOnly(incoming)],
];

describe('forwardedHeaders', () => {
  it('forwards cookie and authorization by default', () => {
    expect(DEFAULT_FORWARDED_HEADERS).to.deep.equal(['cookie', 'authorization']);
  });

  for (const [label, shape] of SHAPES) {
    describe(`from ${label}`, () => {
      it('forwards only the listed names, lower-cased', () => {
        expect(forwardedHeaders(shape, DEFAULT_FORWARDED_HEADERS)).to.deep.equal({ cookie: 'session=abc', authorization: 'Bearer t0k' });
        expect(forwardedHeaders(shape, ['Accept-Language'])).to.deep.equal({ 'accept-language': 'pl' });
      });

      it('never forwards host, hop-by-hop headers, content-length or the proxy headers, even when listed', () => {
        const listed = ['host', 'connection', 'content-length', 'x-forwarded-for', 'X-Forwarded-Host', 'x-forwarded-proto', 'forwarded', 'transfer-encoding', 'te', 'upgrade', 'keep-alive', 'proxy-authorization'];
        expect(forwardedHeaders(shape, listed)).to.deep.equal({});
      });

      it('never forwards a header that the incoming connection header names as hop-by-hop', () => {
        expect(forwardedHeaders(shape, ['x-trace', 'cookie'])).to.deep.equal({ cookie: 'session=abc' });
      });

      it('skips a listed header that the request does not carry', () => {
        expect(forwardedHeaders(shape, ['x-missing', 'cookie'])).to.deep.equal({ cookie: 'session=abc' });
      });
    });
  }

  it('matches record keys whatever their case', () => {
    expect(forwardedHeaders({ Cookie: 'a=1', AUTHORIZATION: 'Bearer x' }, ['cookie', 'authorization'])).to.deep.equal({ cookie: 'a=1', authorization: 'Bearer x' });
  });

  it('forwards nothing without incoming headers', () => {
    expect(forwardedHeaders(undefined, DEFAULT_FORWARDED_HEADERS)).to.deep.equal({});
  });

  it('never forwards a multi-value set-cookie record entry', () => {
    expect(forwardedHeaders({ 'set-cookie': ['a=1', 'b=2'], cookie: 'c=3' }, ['set-cookie', 'cookie'])).to.deep.equal({ cookie: 'c=3' });
  });

  it('joins any other multi-value record entry the way HTTP combines repeated fields', () => {
    expect(forwardedHeaders({ cookie: ['a=1', 'b=2'], 'x-tag': ['a', 'b'], empty: [] }, ['cookie', 'x-tag', 'empty'])).to.deep.equal({ cookie: 'a=1; b=2', 'x-tag': 'a, b' });
  });

  it('throws through checkHeader for a value with CR or LF', () => {
    expect(() => forwardedHeaders({ cookie: 'a=1\r\nx-evil: 1' }, ['cookie'])).to.throw(TypeError, /control or non-Latin-1/);
    expect(() => forwardedHeaders(getOnly({ authorization: 'Bearer x\n' }), ['authorization'])).to.throw(TypeError, /control or non-Latin-1/);
  });

  it('throws for a listed name that is not an HTTP token', () => {
    expect(() => forwardedHeaders({ 'bad name': 'x' }, ['bad name'])).to.throw(TypeError, /not a valid HTTP token/);
  });
});

describe('serverClientOptions', () => {
  const headersOf = async (options: ReturnType<typeof serverClientOptions>) => (await options.headers?.()) ?? {};

  it('throws TypeError for a relative baseUrl', () => {
    expect(() => serverClientOptions({ baseUrl: '/api' })).to.throw(TypeError, /absolute URL.*'\/api'/);
    expect(() => serverClientOptions({ baseUrl: '' })).to.throw(TypeError);
  });

  it('forwards cookie and authorization by default and passes the other client options through', async () => {
    const fetch = (() => Promise.reject(new Error('unused'))) as typeof globalThis.fetch;
    const onProblem = () => undefined;
    const options = serverClientOptions({ baseUrl: 'http://api.internal:8080', incoming, fetch, onProblem });
    expect(options).to.include({ baseUrl: 'http://api.internal:8080', fetch, onProblem });
    expect(options).to.not.have.any.keys('incoming', 'forward', 'credentials');
    expect(await headersOf(options)).to.deep.equal({ cookie: 'session=abc', authorization: 'Bearer t0k' });
  });

  it('replaces the default list with forward', async () => {
    expect(await headersOf(serverClientOptions({ baseUrl: 'http://api', incoming, forward: ['accept-language', 'host'] }))).to.deep.equal({ 'accept-language': 'pl' });
  });

  it('adds the extra headers after the forwarded ones, as a record or a function', async () => {
    expect(await headersOf(serverClientOptions({ baseUrl: 'http://api', incoming, headers: { authorization: 'Bearer service', 'x-app': '1' } }))).to.deep.equal({ cookie: 'session=abc', authorization: 'Bearer service', 'x-app': '1' });
    expect(await headersOf(serverClientOptions({ baseUrl: 'http://api', incoming, headers: () => Promise.resolve({ 'x-app': '2' }) }))).to.deep.equal({ cookie: 'session=abc', authorization: 'Bearer t0k', 'x-app': '2' });
  });

  it('reads the incoming headers once, when the client is created', async () => {
    const live = new Headers({ cookie: 'a=1' });
    const options = serverClientOptions({ baseUrl: 'http://api', incoming: live });
    live.set('cookie', 'b=2');
    expect(await headersOf(options)).to.deep.equal({ cookie: 'a=1' });
  });

  it('throws when it is created with a CR/LF value, not on the first request', () => {
    expect(() => serverClientOptions({ baseUrl: 'http://api', incoming: { cookie: 'a\r\n' } })).to.throw(TypeError);
  });
});
