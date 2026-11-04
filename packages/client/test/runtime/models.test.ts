import 'mocha';
import { expect } from 'chai';
import {
  createClient,
  createModelClient,
  dateCodec,
  fromClass,
  type ClientDefinition,
  type ConversionPlans,
  type ModelClientOptions,
  type RoutePlans,
} from '../../src/runtime/index.js';

const ISO = '2026-05-01T08:00:00.000Z';

class User {
  id: number;
  name: string;
  role = 'member';
  get label(): string {
    return `#${this.id} ${this.name}`;
  }
  greet(): string {
    return `hi ${this.name}`;
  }
}

class Article {
  id: number;
  title: string;
  publishedAt: Date;
  author?: User;
  get isFresh(): boolean {
    return this.publishedAt.getTime() > 0;
  }
}

describe('fromClass', () => {
  it('copies the decoded properties onto a new instance', () => {
    const user = fromClass(User).decode({ id: 7, name: 'Ann', role: 'admin' });
    expect(user).to.be.instanceOf(User);
    expect(user.label).to.equal('#7 Ann');
    expect(user.role).to.equal('admin');
  });

  it('keeps initialised fields the reply does not hold', () => {
    expect(fromClass(User).decode({ id: 1, name: 'x' }).role).to.equal('member');
  });

  it('does not let a JSON "__proto__" key change the prototype of the instance', () => {
    const wire = JSON.parse('{"__proto__":{"polluted":true,"label":"forged"},"id":1,"name":"x"}') as Record<string, unknown>;
    const user = fromClass(User).decode(wire);
    expect(Object.getPrototypeOf(user)).to.equal(User.prototype);
    expect(user.label).to.equal('#1 x');
    expect((user as unknown as Record<string, unknown>).polluted).to.equal(undefined);
    expect(Object.prototype.hasOwnProperty.call(user, '__proto__')).to.equal(false);
    expect(({} as Record<string, unknown>).polluted).to.equal(undefined);
  });

  it('skips constructor and prototype keys', () => {
    const user = fromClass(User).decode({ id: 1, constructor: 'x', prototype: 'y' });
    expect(user.constructor).to.equal(User);
    expect(Object.prototype.hasOwnProperty.call(user, 'prototype')).to.equal(false);
  });

  it('never lets a reply key shadow a class method or a getter without a setter', () => {
    const user = fromClass(User).decode({ id: 1, name: 'a', label: 'forged', greet: 'x' });
    expect(user.label).to.equal('#1 a');
    expect(user.greet()).to.equal('hi a');
    expect(Object.keys(user).sort()).to.deep.equal(['id', 'name', 'role']);
  });

  it('keeps a property named like an Object.prototype member as data', () => {
    const value = fromClass(User).decode({ id: 1, valueOf: 3, toString: 'x' });
    expect(['valueOf', 'toString'].map((key) => Object.getOwnPropertyDescriptor(value, key)?.value as unknown)).to.deep.equal([3, 'x']);
  });

  it('stores a property the class implements as an accessor pair through its setter', () => {
    class Person {
      private stored = '';
      writes = 0;
      get name(): string {
        return this.stored;
      }
      set name(value: string) {
        this.writes++;
        this.stored = value.trim();
      }
    }
    const person = fromClass(Person).decode({ name: ' Ann ' });
    expect(person.name).to.equal('Ann');
    expect(person.writes).to.equal(1);
    expect(Object.prototype.hasOwnProperty.call(person, 'name')).to.equal(false);
  });

  it('keeps a getter without a setter and passes a setter-only key to its setter', () => {
    class Guarded {
      written = '';
      set secret(value: string) {
        this.written = value;
      }
      get fixed(): number {
        return 1;
      }
    }
    const value = fromClass(Guarded).decode({ secret: 's', fixed: 2 });
    expect(value.written).to.equal('s');
    expect(value.fixed).to.equal(1);
  });
});

const definition: ClientDefinition = {
  articles: {
    read: { method: 'get', path: '/articles/{id}', args: [{ in: 'path', name: 'id', shape: 'value' }] },
    list: { method: 'get', path: '/articles', args: [] },
    add: { method: 'post', path: '/articles', args: [{ in: 'body', shape: 'whole' }] },
    remove: { method: 'delete', path: '/articles/{id}', args: [{ in: 'path', name: 'id', shape: 'value' }], void: true },
  },
};

const plans: ConversionPlans = {
  ArticleDto: { kind: 'object', closed: true, props: { id: null, title: null, publishedAt: { kind: 'format', format: 'date-time' }, author: { kind: 'ref', name: 'UserDto' } } },
  UserDto: { kind: 'object', closed: true, props: { id: null, name: null, role: null } },
};

const routePlans: RoutePlans = {
  articles: {
    read: { reply: { kind: 'ref', name: 'ArticleDto' }, args: [null] },
    list: { reply: { kind: 'array', items: { kind: 'ref', name: 'ArticleDto' } }, args: [] },
    add: { reply: { kind: 'ref', name: 'ArticleDto' }, args: [{ kind: 'ref', name: 'ArticleDto' }] },
  },
};

interface Api {
  articles: {
    read(id: number): Promise<Article>;
    list(): Promise<Article[]>;
    add(body: Article): Promise<Article>;
    remove(id: number): Promise<void>;
  };
}

const wireArticle = { id: 1, title: 'T', publishedAt: ISO, author: { id: 7, name: 'Ann', role: 'admin' } };

function server(reply: unknown = wireArticle): { fetch: typeof fetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const doFetch = ((_url: string | URL, init?: RequestInit) => {
    if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body));
    return Promise.resolve(init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json(reply));
  }) as typeof fetch;
  return { fetch: doFetch, bodies };
}

function api(options: Omit<ModelClientOptions, 'baseUrl'>): Api {
  return createModelClient<Api>(definition, plans, routePlans, { baseUrl: 'http://h', ...options });
}

describe('createModelClient', () => {
  it('decodes a reply into registered models and formats', async () => {
    const { fetch } = server();
    const article = await api({ fetch, formats: { 'date-time': dateCodec }, models: { ArticleDto: fromClass(Article), UserDto: fromClass(User) } }).articles.read(1);
    expect(article).to.be.instanceOf(Article);
    expect(article.publishedAt).to.be.instanceOf(Date);
    expect(article.isFresh).to.equal(true);
    expect(article.author).to.be.instanceOf(User);
    expect(article.author?.label).to.equal('#7 Ann');
  });

  it('drops undeclared reply fields before the model sees them', async () => {
    const { fetch } = server({ ...wireArticle, isFresh: false, author: { ...wireArticle.author, label: 'forged', greet: 'x', toString: 's', valueOf: 1 } });
    const article = await api({ fetch, formats: { 'date-time': dateCodec }, models: { ArticleDto: fromClass(Article), UserDto: fromClass(User) } }).articles.read(1);
    expect(article.isFresh).to.equal(true);
    expect(article.author?.label).to.equal('#7 Ann');
    expect(article.author?.greet()).to.equal('hi Ann');
    expect(Object.keys(article.author ?? {}).sort()).to.deep.equal(['id', 'name', 'role']);
  });

  it('decodes every item of an array reply', async () => {
    const { fetch } = server([wireArticle, wireArticle]);
    const list = await api({ fetch, models: { ArticleDto: fromClass(Article) } }).articles.list();
    expect(list.map((a) => a instanceof Article)).to.deep.equal([true, true]);
    expect(list[0].publishedAt).to.equal(ISO);
  });

  it('encodes a model argument and projects it onto the closed schema', async () => {
    const { fetch, bodies } = server();
    const client = api({ fetch, formats: { 'date-time': dateCodec }, models: { ArticleDto: fromClass(Article), UserDto: fromClass(User) } });
    const article = await client.articles.read(1);
    (article as unknown as Record<string, unknown>).draftNote = 'local only';
    (article.author as unknown as Record<string, unknown>).avatarCache = 'blob:x';
    await client.articles.add(article);
    expect(bodies[0]).to.deep.equal(wireArticle);
  });

  it('passes a void route through untouched', async () => {
    const { fetch } = server();
    expect(await api({ fetch, models: { ArticleDto: fromClass(Article) } }).articles.remove(1)).to.equal(undefined);
  });

  it('behaves as createClient when neither formats nor models is given', async () => {
    const extra = { ...wireArticle, extra: true };
    const plain = server();
    const model = server();
    const viaModel = await api({ fetch: model.fetch }).articles.read(1);
    const viaPlain = await createClient<Api>(definition, { baseUrl: 'http://h', fetch: plain.fetch }).articles.read(1);
    expect(viaModel).to.deep.equal(viaPlain);
    expect(Object.getPrototypeOf(viaModel)).to.equal(Object.prototype);
    await api({ fetch: model.fetch }).articles.add(extra as unknown as Article);
    expect(model.bodies[0]).to.deep.equal(extra);
  });

  it('converts when only formats is given', async () => {
    const { fetch } = server();
    const article = await api({ fetch, formats: { 'date-time': dateCodec } }).articles.read(1);
    expect(article.publishedAt).to.be.instanceOf(Date);
    expect(article).not.to.be.instanceOf(Article);
  });
});
