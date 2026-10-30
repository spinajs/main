import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { createClient, ProblemError, type ClientDefinition, type ClientOptions } from '../../src/runtime/index.js';

chai.use(chaiAsPromised);

interface Seen {
  url: string;
  init: RequestInit;
}

function recording<T>(definition: ClientDefinition, options: Partial<ClientOptions> = {}, reply: () => Response = () => Response.json({})): { client: T; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(reply());
  }) as typeof globalThis.fetch;
  return { client: createClient<T>(definition, { baseUrl: 'http://h', fetch, ...options }), seen };
}

describe('path values that would change the request path', () => {
  const definition: ClientDefinition = {
    users: {
      avatar: { method: 'post', path: '/users/{id}/avatar', args: [{ in: 'path', name: 'id', shape: 'value' }, { in: 'multipart', name: 'file', shape: 'value' }] },
      byKeys: { method: 'get', path: '/users/{org}/{id}', args: [{ in: 'path', shape: 'whole' }] },
      legacy: { method: 'get', path: '/users/{id}', params: ['id'] },
    },
  };

  interface Users {
    avatar(id: string, file: Blob): Promise<unknown>;
    byKeys(keys: { org: string; id: string }): Promise<unknown>;
    legacy(params: { id: string }): Promise<unknown>;
  }

  for (const value of ['..', '.', '']) {
    it(`refuses '${value}' for value, whole and legacy path arguments before any request is made`, async () => {
      const { client, seen } = recording<{ users: Users }>(definition);
      await expect(client.users.avatar(value, new Blob(['x']))).to.be.rejectedWith(TypeError, `Path parameter 'id' of POST /users/{id}/avatar is '${value}', which would change the request path`);
      await expect(client.users.byKeys({ org: 'acme', id: value })).to.be.rejectedWith(TypeError, `Path parameter 'id'`);
      await expect(client.users.legacy({ id: value })).to.be.rejectedWith(TypeError, `Path parameter 'id'`);
      expect(seen).to.deep.equal([]);
    });
  }

  it('still sends values that merely contain dots or separators, encoded', async () => {
    const { client, seen } = recording<{ users: Users }>(definition);
    await client.users.avatar('...', new Blob(['x']));
    await client.users.byKeys({ org: 'a.b', id: '../x' });
    expect(seen.map((s) => s.url)).to.deep.equal(['http://h/users/.../avatar', 'http://h/users/a.b/..%2Fx']);
  });
});

describe('Express 5 path templates', () => {
  const definition: ClientDefinition = {
    items: {
      opt: { method: 'get', path: '/items[/{id}]', args: [{ in: 'path', name: 'id', shape: 'value' }] },
      files: { method: 'get', path: '/files/{*path}', args: [{ in: 'path', name: 'path', shape: 'json' }] },
      escaped: { method: 'get', path: '/x\\[{id}\\]', args: [{ in: 'path', name: 'id', shape: 'value' }] },
    },
  };

  interface Items {
    opt(id?: number): Promise<unknown>;
    files(path: string[]): Promise<unknown>;
    escaped(id: number): Promise<unknown>;
  }

  it('leaves out an optional group whose argument is undefined and fills it otherwise', async () => {
    const { client, seen } = recording<{ items: Items }>(definition);
    await client.items.opt();
    await client.items.opt(5);
    expect(seen.map((s) => s.url)).to.deep.equal(['http://h/items', 'http://h/items/5']);
  });

  it('joins a wildcard array with / and encodes each segment', async () => {
    const { client, seen } = recording<{ items: Items }>(definition);
    await client.items.files(['docs', 'a b', 'c/d']);
    expect(seen.map((s) => s.url)).to.deep.equal(['http://h/files/docs/a%20b/c%2Fd']);
  });

  it('refuses an empty wildcard and a dot segment inside one', async () => {
    const { client, seen } = recording<{ items: Items }>(definition);
    await expect(client.items.files([])).to.be.rejectedWith(TypeError, 'non-empty array');
    await expect(client.items.files(['docs', '..', 'secret'])).to.be.rejectedWith(TypeError, `Path parameter 'path' of GET /files/{*path} is '..'`);
    expect(seen).to.deep.equal([]);
  });

  it('keeps escaped template characters literal', async () => {
    const { client, seen } = recording<{ items: Items }>(definition);
    await client.items.escaped(1);
    expect(seen.map((s) => s.url)).to.deep.equal(['http://h/x[1]']);
  });
});

describe('problem bodies', () => {
  const definition: ClientDefinition = { users: { get: { method: 'get', path: '/users/{id}', args: [{ in: 'path', name: 'id', shape: 'value' }] } } };
  const reply = (body: string, status: number, type = 'application/problem+json') => () => new Response(body, { status, statusText: 'Server Error', headers: { 'content-type': type } });

  async function problemOf(response: () => Response): Promise<ProblemError> {
    const { client } = recording<{ users: { get(id: number): Promise<unknown> } }>(definition, {}, response);
    const error = await client.users.get(1).catch((e: unknown) => e);
    expect(error).to.be.instanceOf(ProblemError);
    return error as ProblemError;
  }

  it('copies only the RFC 9457 members and the declared code and errors extensions', async () => {
    const body = { type: 'urn:x', title: 'Boom', status: 500, detail: 'd', instance: '/users/1', code: 'E1', errors: [{ path: 'a' }], stack: 'Error: at x', internal: { db: 'secret' } };
    const error = await problemOf(reply(JSON.stringify(body), 500));
    expect(error.problem).to.deep.equal({ type: 'urn:x', title: 'Boom', status: 500, detail: 'd', instance: '/users/1', code: 'E1', errors: [{ path: 'a' }] });
    expect(error.message).to.equal('500 Boom: d');
  });

  it('fills missing or mistyped members from the response', async () => {
    const error = await problemOf(reply(JSON.stringify({ title: 7, status: 'x', detail: { a: 1 }, extra: true }), 503, 'application/json'));
    expect(error.problem).to.deep.equal({ type: 'about:blank', title: 'Server Error', status: 503 });
    expect(error.message).to.equal('503 Server Error');
  });

  it('turns an unparsable JSON body into a problem holding the text', async () => {
    const error = await problemOf(reply('{not json', 502));
    expect(error.status).to.equal(502);
    expect(error.problem).to.deep.equal({ type: 'about:blank', title: 'Server Error', status: 502, detail: '{not json' });
  });

  it('turns a JSON body that is not an object into a problem holding the text', async () => {
    const error = await problemOf(reply('["a"]', 500, 'application/json'));
    expect(error.problem).to.deep.equal({ type: 'about:blank', title: 'Server Error', status: 500, detail: '["a"]' });
  });
});

describe('headers, forms and credentials', () => {
  const definition: ClientDefinition = {
    items: {
      tenant: { method: 'get', path: '/t', args: [{ in: 'header', name: 'x-tenant', shape: 'value' }] },
      form: { method: 'post', path: '/form', args: [{ in: 'multipart', shape: 'whole' }] },
      mixed: { method: 'post', path: '/mixed', args: [{ in: 'multipart', name: 'file', shape: 'value' }, { in: 'body', shape: 'whole' }] },
    },
  };

  interface Items {
    tenant(tenant: string): Promise<unknown>;
    form(form: unknown): Promise<unknown>;
    mixed(file: Blob, body: unknown): Promise<unknown>;
  }

  it('lower-cases option header names, so an argument header replaces one rather than joining it', async () => {
    const { client, seen } = recording<{ items: Items }>(definition, { headers: () => ({ Authorization: 'Bearer t', 'X-Tenant': 'from-options' }), credentials: 'include' });
    await client.items.tenant('acme');
    expect(seen[0].init.headers).to.deep.equal({ accept: 'application/json, application/problem+json', authorization: 'Bearer t', 'x-tenant': 'acme' });
    expect(seen[0].init.credentials).to.equal('include');
  });

  it('refuses header values with CR/LF or beyond Latin-1, and invalid header names', async () => {
    const { client, seen } = recording<{ items: Items }>(definition);
    await expect(client.items.tenant('a\r\nx-evil: 1')).to.be.rejectedWith(TypeError, `Header 'x-tenant'`);
    await expect(client.items.tenant('Zürich ✓')).to.be.rejectedWith(TypeError, 'non-Latin-1');
    await expect(recording<{ items: Items }>(definition, { headers: () => ({ 'bad name': 'x' }) }).client.items.tenant('a')).to.be.rejectedWith(TypeError, `Header name 'bad name'`);
    expect(seen).to.deep.equal([]);
  });

  it('sends a whole form with bracketed keys for nested objects and arrays', async () => {
    const { client, seen } = recording<{ items: Items }>(definition);
    await client.items.form({ name: 'Ada', address: { city: 'London', zip: 'N1' }, tags: ['a', 'b'], when: new Date('2020-01-02T00:00:00.000Z'), skip: undefined });
    const entries: [string, unknown][] = [];
    (seen[0].init.body as FormData).forEach((value, key) => entries.push([key, value]));
    expect(entries).to.deep.equal([
      ['name', 'Ada'],
      ['address[city]', 'London'],
      ['address[zip]', 'N1'],
      ['tags[0]', 'a'],
      ['tags[1]', 'b'],
      ['when', '2020-01-02T00:00:00.000Z'],
    ]);
  });

  it('refuses a body argument next to a multipart one', async () => {
    const { client, seen } = recording<{ items: Items }>(definition);
    await expect(client.items.mixed(new Blob(['x']), { a: 1 })).to.be.rejectedWith(TypeError, 'multipart');
    expect(seen).to.deep.equal([]);
  });
});
