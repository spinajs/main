import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { createClient, ProblemError, serializeQuery, type ClientDefinition } from '../../src/runtime/index.js';

chai.use(chaiAsPromised);

const definition: ClientDefinition = {
  users: {
    get: { method: 'get', path: '/users/{id}', params: ['id'] },
    list: { method: 'get', path: '/users', params: [], query: ['page', 'perPage'] },
    create: { method: 'post', path: '/users', params: [], body: 'json' },
    avatar: { method: 'post', path: '/users/{id}/avatar', params: ['id'], body: 'multipart', files: ['file'], void: true },
    update: { method: 'put', path: '/users/{id}', params: ['id'], query: ['dry'], body: 'json' },
  },
};

interface Users {
  get(params: { id: number }): Promise<{ id: number }>;
  list(params?: { page?: number; perPage?: number }): Promise<{ id: number }[]>;
  create(body: { email: string }): Promise<{ id: number }>;
  avatar(params: { id: number }, body: { file: Blob }): Promise<void>;
  update(params: { id: number }, query: { dry?: boolean }, body: { email: string }): Promise<{ id: number }>;
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return ((url: string | URL, init?: RequestInit) => Promise.resolve(handler(String(url), init ?? {}))) as typeof fetch;
}

describe('createClient runtime', () => {
  it('substitutes path params and serialises query with brackets', async () => {
    const seen: string[] = [];
    const client = createClient<{ users: Users }>(definition, {
      baseUrl: 'http://h',
      fetch: fakeFetch((url) => {
        seen.push(url);
        return Response.json([]);
      }),
    });
    await client.users.get({ id: 7 });
    await client.users.list({ page: 2, perPage: 5 });
    expect(seen).to.deep.equal(['http://h/users/7', 'http://h/users?page=2&perPage=5']);
  });

  it('sends json bodies and reads json replies', async () => {
    const client = createClient<{ users: Users }>(definition, {
      baseUrl: 'http://h',
      fetch: fakeFetch((_u, init) => {
        expect(init.headers).to.include({ 'content-type': 'application/json' });
        expect(init.body).to.equal('{"email":"a@b"}');
        return Response.json({ id: 1 }, { status: 200 });
      }),
    });
    expect(await client.users.create({ email: 'a@b' })).to.deep.equal({ id: 1 });
  });

  it('sends multipart for file routes and resolves void on 204', async () => {
    const client = createClient<{ users: Users }>(definition, {
      baseUrl: 'http://h',
      fetch: fakeFetch((_u, init) => {
        expect(init.body).to.be.instanceOf(FormData);
        return new Response(null, { status: 204 });
      }),
    });
    expect(await client.users.avatar({ id: 1 }, { file: new Blob(['x']) })).to.equal(undefined);
  });

  it('throws ProblemError on a problem+json reply and calls onProblem', async () => {
    const problems: unknown[] = [];
    const client = createClient<{ users: Users }>(definition, {
      baseUrl: 'http://h',
      onProblem: (p) => problems.push(p),
      fetch: fakeFetch(() => new Response(JSON.stringify({ type: 'about:blank', title: 'Not Found', status: 404 }), { status: 404, headers: { 'content-type': 'application/problem+json' } })),
    });
    await expect(client.users.get({ id: 9 })).to.be.rejectedWith(ProblemError);
    expect(problems).to.have.length(1);
  });

  it('merges async headers', async () => {
    const client = createClient<{ users: Users }>(definition, {
      baseUrl: 'http://h',
      headers: async () => ({ authorization: 'Bearer t' }),
      fetch: fakeFetch((_u, init) => {
        expect(init.headers).to.include({ authorization: 'Bearer t' });
        return Response.json({ id: 1 });
      }),
    });
    await client.users.get({ id: 1 });
  });

  it('orders arguments as params, query, body when a route has all three', async () => {
    let seenUrl = '';
    let seenBody: unknown;
    const client = createClient<{ users: Users }>(definition, {
      baseUrl: 'http://h/',
      fetch: fakeFetch((url, init) => {
        seenUrl = url;
        seenBody = init.body;
        return Response.json({ id: 3 });
      }),
    });
    await client.users.update({ id: 3 }, { dry: true }, { email: 'x@y' });
    expect(seenUrl).to.equal('http://h/users/3?dry=true');
    expect(seenBody).to.equal('{"email":"x@y"}');
  });

  it('falls back to a synthesised problem for non-json errors', async () => {
    const client = createClient<{ users: Users }>(definition, {
      baseUrl: 'http://h',
      fetch: fakeFetch(() => new Response('boom', { status: 502, statusText: 'Bad Gateway', headers: { 'content-type': 'text/plain' } })),
    });
    const error = await client.users.get({ id: 1 }).catch((e: unknown) => e);
    expect(error).to.be.instanceOf(ProblemError);
    expect((error as ProblemError).status).to.equal(502);
    expect((error as ProblemError).problem).to.deep.include({ title: 'Bad Gateway', detail: 'boom' });
  });

  it('rejects when a path parameter is missing', async () => {
    const client = createClient<{ users: Users }>(definition, { baseUrl: 'http://h', fetch: fakeFetch(() => Response.json({})) });
    await expect(client.users.get({} as { id: number })).to.be.rejectedWith(TypeError, /Missing path parameter 'id'/);
  });

  it('encodes path params', async () => {
    let seen = '';
    const client = createClient<{ users: Users }>(definition, {
      baseUrl: 'http://h',
      fetch: fakeFetch((url) => {
        seen = url;
        return Response.json({});
      }),
    });
    await client.users.get({ id: 'a/b' as unknown as number });
    expect(seen).to.equal('http://h/users/a%2Fb');
  });
});

describe('serializeQuery', () => {
  it('uses qs bracket notation for nested objects and arrays', () => {
    expect(serializeQuery({ a: { b: 1 }, c: [1, 2] })).to.equal('a%5Bb%5D=1&c%5B0%5D=1&c%5B1%5D=2');
  });

  it('skips undefined and null, and serialises dates as ISO strings', () => {
    expect(serializeQuery({ a: undefined, b: null, d: new Date('2020-01-02T00:00:00.000Z') })).to.equal('d=2020-01-02T00%3A00%3A00.000Z');
  });
});
