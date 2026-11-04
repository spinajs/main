import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { createClient, ProblemError, type ClientDefinition } from '../../src/runtime/index.js';

chai.use(chaiAsPromised);

const definition: ClientDefinition = {
  users: {
    get: { method: 'get', path: '/users/{id}', params: ['id'] },
    remove: { method: 'delete', path: '/users/{id}', params: ['id'], void: true },
    name: { method: 'get', path: '/users/name' },
  },
};

interface Users {
  get(params: { id: number }): Promise<{ id: number }>;
  remove(params: { id: number }): Promise<void>;
  name(): Promise<string>;
}

const fetchOf = (make: () => Response): typeof fetch => (() => Promise.resolve(make()));

describe('ClientOptions.parseReply', () => {
  it('does nothing without the option', async () => {
    const client = createClient<{ users: Users }>(definition, { baseUrl: 'http://h', fetch: fetchOf(() => Response.json({ id: 1, extra: true })) });
    expect(await client.users.get({ id: 1 })).to.deep.equal({ id: 1, extra: true });
  });

  it('is called with the route and the parsed json, and its result is returned', async () => {
    const seen: unknown[] = [];
    const client = createClient<{ users: Users }>(definition, {
      baseUrl: 'http://h',
      fetch: fetchOf(() => Response.json({ id: 1, extra: true })),
      parseReply: (route, value) => {
        seen.push(route, value);
        return { id: (value as { id: number }).id };
      },
    });
    expect(await client.users.get({ id: 1 })).to.deep.equal({ id: 1 });
    expect(seen).to.deep.equal([{ controller: 'users', name: 'get' }, { id: 1, extra: true }]);
  });

  it('rejects the call with what the parser throws', async () => {
    const client = createClient<{ users: Users }>(definition, {
      baseUrl: 'http://h',
      fetch: fetchOf(() => Response.json({ id: 'x' })),
      parseReply: () => {
        throw new RangeError('bad reply');
      },
    });
    await expect(client.users.get({ id: 1 })).to.be.rejectedWith(RangeError, 'bad reply');
  });

  it('is not called for 204, a void route, a text reply or an error status', async () => {
    let calls = 0;
    const parseReply = () => {
      calls++;
      return 'parsed';
    };
    const options = { baseUrl: 'http://h', parseReply };
    const noContent = createClient<{ users: Users }>(definition, { ...options, fetch: fetchOf(() => new Response(null, { status: 204 })) });
    expect(await noContent.users.get({ id: 1 })).to.equal(undefined);
    const empty = createClient<{ users: Users }>(definition, { ...options, fetch: fetchOf(() => Response.json({ ignored: true })) });
    expect(await empty.users.remove({ id: 1 })).to.equal(undefined);
    const text = createClient<{ users: Users }>(definition, { ...options, fetch: fetchOf(() => new Response('plain', { headers: { 'content-type': 'text/plain' } })) });
    expect(await text.users.name()).to.equal('plain');
    const failing = createClient<{ users: Users }>(definition, { ...options, fetch: fetchOf(() => Response.json({ title: 'Nope', status: 404 }, { status: 404 })) });
    await expect(failing.users.get({ id: 1 })).to.be.rejectedWith(ProblemError);
    expect(calls).to.equal(0);
  });
});
