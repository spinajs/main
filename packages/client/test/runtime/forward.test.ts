import 'mocha';
import { expect } from 'chai';
import { createClient, DEFAULT_FORWARDED_HEADERS, forwardedHeaders, serverClientOptions, type ClientDefinition, type ClientOptions, type IncomingHeaders, type ServerClientOptions } from '../../src/runtime/index.js';

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
  origin: 'https://app.example',
};

const getOnly = (record: Record<string, string>): IncomingHeaders => ({ get: (name: string) => record[name.toLowerCase()] ?? null });

const SHAPES: [string, IncomingHeaders][] = [
  ['a Headers', new Headers(incoming)],
  ['a plain record', incoming],
  ['an object with get(name)', getOnly(incoming)],
];

// Hop-by-hop, the incoming message's own framing and representation, conditional requests, and client-address or
// routing headers an API may trust.
const BLOCKED = [
  'host',
  'Host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'content-length',
  'content-type',
  'content-encoding',
  'expect',
  'range',
  'accept',
  'if-none-match',
  'If-Modified-Since',
  'if-match',
  'set-cookie',
  'forwarded',
  'x-forwarded-for',
  'X-Forwarded-Host',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'x-client-ip',
  'x-original-url',
  'x-http-method-override',
];

describe('forwardedHeaders', () => {
  it('forwards cookie and authorization by default, from a list no caller can change', () => {
    expect(DEFAULT_FORWARDED_HEADERS).to.deep.equal(['cookie', 'authorization']);
    expect(Object.isFrozen(DEFAULT_FORWARDED_HEADERS)).to.equal(true);
    expect(() => (DEFAULT_FORWARDED_HEADERS as string[]).push('host')).to.throw(TypeError);
  });

  for (const [label, shape] of SHAPES) {
    describe(`from ${label}`, () => {
      it('forwards only the listed names, lower-cased', () => {
        expect(forwardedHeaders(shape, DEFAULT_FORWARDED_HEADERS)).to.deep.equal({ cookie: 'session=abc', authorization: 'Bearer t0k' });
        expect(forwardedHeaders(shape, ['Accept-Language', 'origin'])).to.deep.equal({ 'accept-language': 'pl', origin: 'https://app.example' });
      });

      for (const name of BLOCKED) {
        it(`throws when forward lists ${name}, which is never forwarded`, () => {
          expect(() => forwardedHeaders(shape, ['cookie', name])).to.throw(TypeError, new RegExp(`'${name.toLowerCase()}' is never forwarded`));
        });
      }

      it('never forwards a header that the incoming connection header names as hop-by-hop', () => {
        expect(forwardedHeaders(shape, ['x-trace', 'cookie'])).to.deep.equal({ cookie: 'session=abc' });
      });

      it('skips a listed header that the request does not carry', () => {
        expect(forwardedHeaders(shape, ['x-missing', 'cookie'])).to.deep.equal({ cookie: 'session=abc' });
      });

      for (const name of [' cookie', 'bad name', '', 'a:b']) {
        it(`throws for the forward name ${JSON.stringify(name)}, whether or not the request carries it`, () => {
          expect(() => forwardedHeaders(shape, [name])).to.throw(TypeError, /is not a valid HTTP token/);
        });
      }
    });
  }

  it('validates the names even without incoming headers', () => {
    expect(forwardedHeaders(undefined, DEFAULT_FORWARDED_HEADERS)).to.deep.equal({});
    expect(() => forwardedHeaders(undefined, ['host'])).to.throw(TypeError, /never forwarded/);
    expect(() => forwardedHeaders(undefined, ['bad name'])).to.throw(TypeError, /not a valid HTTP token/);
  });

  it('matches record keys whatever their case, taking the first defined value', () => {
    expect(forwardedHeaders({ Cookie: 'a=1', AUTHORIZATION: 'Bearer x' }, ['cookie', 'authorization'])).to.deep.equal({ cookie: 'a=1', authorization: 'Bearer x' });
    expect(forwardedHeaders({ cookie: undefined, Cookie: 'b=2' }, ['cookie'])).to.deep.equal({ cookie: 'b=2' });
    expect(forwardedHeaders({ Cookie: 'a=1', cookie: 'b=2' }, ['cookie'])).to.deep.equal({ cookie: 'a=1' });
  });

  it('joins any multi-value record entry the way HTTP combines repeated fields', () => {
    expect(forwardedHeaders({ cookie: ['a=1', 'b=2'], 'x-tag': ['a', 'b'], empty: [] }, ['cookie', 'x-tag', 'empty'])).to.deep.equal({ cookie: 'a=1; b=2', 'x-tag': 'a, b' });
  });

  it('joins an array that a get() source returns, as Express-like request objects do', () => {
    const values: Record<string, unknown> = { cookie: ['a=1', 'b=2'], 'x-tag': ['a', 'b'] };
    const source = { get: (name: string) => (values[name] ?? null) as string | null };
    expect(forwardedHeaders(source, ['cookie', 'x-tag'])).to.deep.equal({ cookie: 'a=1; b=2', 'x-tag': 'a, b' });
  });

  it('throws through checkHeader for a value with CR or LF', () => {
    expect(() => forwardedHeaders({ cookie: 'a=1\r\nx-evil: 1' }, ['cookie'])).to.throw(TypeError, /control or non-Latin-1/);
    expect(() => forwardedHeaders(getOnly({ authorization: 'Bearer x\n' }), ['authorization'])).to.throw(TypeError, /control or non-Latin-1/);
  });
});

describe('serverClientOptions', () => {
  const headersOf = async (options: Pick<ClientOptions, 'headers'>) => (await options.headers?.()) ?? {};

  for (const baseUrl of ['/api', '', 'localhost:3000', 'api.internal:8080', 'javascript:alert(1)', 'ftp://api.internal/', 'http://user:pass@api.internal/']) {
    it(`throws TypeError for the baseUrl ${JSON.stringify(baseUrl)}`, () => {
      expect(() => serverClientOptions({ baseUrl })).to.throw(TypeError, /createServerAppClient: baseUrl must be an absolute http: or https: URL without credentials/);
    });
  }

  it('accepts absolute http and https URLs', () => {
    for (const baseUrl of ['http://api.internal:8080', 'https://api.example.com/v1/']) expect(serverClientOptions({ baseUrl }).baseUrl).to.equal(baseUrl);
  });

  it('forwards cookie and authorization by default and passes the other client options through', async () => {
    const fetch = (() => Promise.reject(new Error('unused'))) as typeof globalThis.fetch;
    const onProblem = () => undefined;
    const options = serverClientOptions({ baseUrl: 'http://api.internal:8080', incoming, fetch, onProblem });
    expect(options).to.include({ baseUrl: 'http://api.internal:8080', fetch, onProblem });
    expect(options).to.not.have.any.keys('incoming', 'forward', 'credentials', 'redirect');
    expect(await headersOf(options)).to.deep.equal({ cookie: 'session=abc', authorization: 'Bearer t0k' });
  });

  it('keeps options the caller adds beyond ServerClientOptions, in the types and at runtime', () => {
    const models = { users: { decode: (value: unknown) => value } };
    const options = serverClientOptions({ baseUrl: 'http://api', models });
    const kept: typeof models = options.models;
    expect(kept).to.equal(models);
  });

  it('replaces the default list with forward', async () => {
    expect(await headersOf(serverClientOptions({ baseUrl: 'http://api', incoming, forward: ['accept-language', 'origin'] }))).to.deep.equal({ 'accept-language': 'pl', origin: 'https://app.example' });
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

  it('throws when it is created with a CR/LF value or a blocked name, not on the first request', () => {
    expect(() => serverClientOptions({ baseUrl: 'http://api', incoming: { cookie: 'a\r\n' } })).to.throw(TypeError);
    expect(() => serverClientOptions({ baseUrl: 'http://api', forward: ['cookie', 'x-forwarded-for'] })).to.throw(TypeError, /never forwarded/);
  });

  describe('on the wire', () => {
    const definition: ClientDefinition = { users: { get: { method: 'get', path: '/users/{id}', args: [{ in: 'path', name: 'id', shape: 'value' }] } } };
    type Users = { users: { get(id: number): Promise<unknown> } };

    function recording(): { fetch: typeof fetch; seen: { url: string; init: RequestInit }[] } {
      const seen: { url: string; init: RequestInit }[] = [];
      const fetch: typeof globalThis.fetch = async (url, init) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        seen.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
        return Response.json({});
      };
      return { fetch, seen };
    }

    const client = (options: ServerClientOptions) => createClient<Users>(definition, serverClientOptions(options));

    it("lets the app's Authorization, in any case, replace the forwarded authorization", async () => {
      const { fetch, seen } = recording();
      await client({ baseUrl: 'http://api', incoming, fetch, headers: { Authorization: 'Bearer svc' } }).users.get(1);
      expect(seen[0].init.headers).to.deep.equal({ accept: 'application/json, application/problem+json', cookie: 'session=abc', authorization: 'Bearer svc' });
    });

    it('keeps the credentials of two concurrent clients apart', async () => {
      const { fetch, seen } = recording();
      const a = client({ baseUrl: 'http://api', incoming: { cookie: 'session=a', authorization: 'Bearer a' }, fetch });
      const b = client({ baseUrl: 'http://api', incoming: new Headers({ cookie: 'session=b' }), fetch });
      await Promise.all([a.users.get(1), b.users.get(2), a.users.get(3), b.users.get(4)]);
      const byUrl = Object.fromEntries(seen.map((s) => [s.url, s.init.headers as Record<string, string>]));
      expect(byUrl['http://api/users/1']).to.include({ cookie: 'session=a', authorization: 'Bearer a' });
      expect(byUrl['http://api/users/3']).to.include({ cookie: 'session=a', authorization: 'Bearer a' });
      expect(byUrl['http://api/users/2']).to.include({ cookie: 'session=b' }).and.not.have.property('authorization');
      expect(byUrl['http://api/users/4']).to.include({ cookie: 'session=b' }).and.not.have.property('authorization');
    });

    it("passes redirect to every fetch when set, and leaves fetch's own default otherwise", async () => {
      const { fetch, seen } = recording();
      await client({ baseUrl: 'http://api', fetch, redirect: 'error' }).users.get(1);
      await client({ baseUrl: 'http://api', fetch }).users.get(2);
      expect(seen.map((s) => s.init.redirect)).to.deep.equal(['error', undefined]);
      expect(seen[0].init.method).to.equal('GET');
    });

    it('looks up globalThis.fetch on every call when redirect is set without a fetch', async () => {
      const { fetch, seen } = recording();
      const original = globalThis.fetch;
      const users = client({ baseUrl: 'http://api', redirect: 'manual' }).users;
      globalThis.fetch = fetch;
      try {
        await users.get(1);
      } finally {
        globalThis.fetch = original;
      }
      expect(seen.map((s) => s.init.redirect)).to.deep.equal(['manual']);
    });
  });
});
