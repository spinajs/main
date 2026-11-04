import 'mocha';
import { expect } from 'chai';
import { createClient, serverClientOptions, type ClientDefinition, type ClientOptions } from '../../src/runtime/index.js';

const definition: ClientDefinition = {
  users: {
    get: { method: 'get', path: '/users/{id}', params: ['id'] },
    create: { method: 'post', path: '/users', params: [], body: 'json' },
  },
  health: { get: { method: 'get', path: '/health' } },
};

interface App {
  users: { get(params: { id: number }): Promise<unknown>; create(body: { email: string }): Promise<unknown> };
  health: { get(): Promise<unknown> };
}

type Seen = { url: string; init: RequestInit & { next?: unknown } };

function recording(options: Omit<ClientOptions, 'baseUrl' | 'fetch'>): { client: App; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch = ((url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(Response.json({ ok: true }));
  }) as typeof globalThis.fetch;
  return { client: createClient<App>(definition, { baseUrl: 'http://h', fetch, ...options }), seen };
}

describe('ClientOptions.init', () => {
  it('is called once per call with the controller, the handler name and the method', async () => {
    const routes: unknown[] = [];
    const { client } = recording({ init: (route) => (routes.push(route), {}) });
    await client.users.get({ id: 1 });
    await client.users.create({ email: 'a@b' });
    await client.health.get();
    expect(routes).to.deep.equal([
      { controller: 'users', name: 'get', method: 'get' },
      { controller: 'users', name: 'create', method: 'post' },
      { controller: 'health', name: 'get', method: 'get' },
    ]);
  });

  it('merges what it returns into the fetch init, members fetch does not know included', async () => {
    const signal = new AbortController().signal;
    const { client, seen } = recording({ init: () => ({ cache: 'no-store', signal, next: { tags: ['t'] } }) as RequestInit });
    await client.users.get({ id: 1 });
    expect(seen[0].init).to.include({ method: 'GET', cache: 'no-store', signal });
    expect(seen[0].init.next).to.deep.equal({ tags: ['t'] });
  });

  it('keeps the method, the headers and the body the runtime built', async () => {
    const { client, seen } = recording({
      headers: () => ({ authorization: 'Bearer t' }),
      init: () => ({ method: 'DELETE', headers: { authorization: 'Bearer other', 'x-extra': '1' }, body: '{"email":"evil"}' }),
    });
    await client.users.create({ email: 'a@b' });
    expect(seen[0].init.method).to.equal('POST');
    expect(seen[0].init.headers).to.deep.equal({ accept: 'application/json, application/problem+json', authorization: 'Bearer t', 'content-type': 'application/json' });
    expect(seen[0].init.body).to.equal('{"email":"a@b"}');
  });

  it('leaves out a body for a call without one, even when init returns a body', async () => {
    const { client, seen } = recording({ init: () => ({ body: 'x' }) });
    await client.users.get({ id: 1 });
    expect(seen[0].init).to.not.have.property('body');
  });

  it('is merged after the runtime options, so it can override credentials', async () => {
    const { client, seen } = recording({ credentials: 'include', init: () => ({ credentials: 'omit' }) });
    await client.users.get({ id: 1 });
    expect(seen[0].init.credentials).to.equal('omit');
  });

  it('changes nothing when it is not set', async () => {
    const { client, seen } = recording({});
    await client.users.get({ id: 1 });
    expect(seen[0].init).to.deep.equal({ method: 'GET', headers: { accept: 'application/json, application/problem+json' } });
  });

  it('passes through serverClientOptions', async () => {
    const seen: RequestInit[] = [];
    const fetch = ((_url: string, init: RequestInit) => (seen.push(init), Promise.resolve(Response.json({})))) as typeof globalThis.fetch;
    const options = serverClientOptions({ baseUrl: 'http://api', fetch, redirect: 'error', init: () => ({ cache: 'no-store' }) });
    await createClient<App>(definition, options).health.get();
    expect(seen[0]).to.include({ cache: 'no-store', redirect: 'error' });
  });
});
