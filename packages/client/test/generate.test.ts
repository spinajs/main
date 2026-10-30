import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Manifest, ParamEntry, ParamWire, RouteEntry } from '@spinajs/manifest';
import { generateClient } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';
import { typecheck } from './support/typecheck.js';

const snapshotPath = fileURLToPath(new URL('./__snapshots__/app-basic.client.ts', import.meta.url));

const source = { line: 1, col: 1, file: 'x.ts', package: 'x' };

function param(index: number, name: string, kind: string, wire: ParamWire | undefined, text: string, schema?: string, required = true): ParamEntry {
  return { index, name, kind, runtimeType: { text, ...(schema ? { schema } : {}) }, required, ...(wire ? { wire } : {}) };
}

function route(handler: string, method: RouteEntry['method'], fullPath: string, params: ParamEntry[], returnType: RouteEntry['returnType']): RouteEntry {
  return { method, path: '', handler, fullPath, params, returnType, policies: [], middlewares: [], source };
}

/** App-basic plus one extra controller and schemas. */
function extend(base: Manifest, routes: RouteEntry[], schemas: Record<string, unknown>): Manifest {
  return {
    ...base,
    schemas: { ...base.schemas, ...schemas },
    controllers: [...base.controllers, { id: 'x:ItemsController', className: 'ItemsController', basePath: 'items', policies: [], middlewares: [], routes, source }],
  };
}

describe('generateClient', () => {
  let manifest: Manifest;
  let output: string;

  before(async () => {
    manifest = await appBasicManifest();
    output = await generateClient({ manifest });
  });

  it('matches the committed snapshot', () => {
    if (!existsSync(snapshotPath)) writeFileSync(snapshotPath, output);
    expect(output).to.equal(readFileSync(snapshotPath, 'utf8'));
  });

  it('type-checks with zero errors', () => {
    expect(typecheck(output)).to.deep.equal([]);
  });

  it('is deterministic and LF only', async () => {
    expect(await generateClient({ manifest })).to.equal(output);
    expect(output).to.not.include('\r');
  });

  it('emits one argument per sent route parameter, in declaration order', () => {
    expect(output).to.include('list(query: ListQuery): Promise<UserDto[]>;');
    expect(output).to.include('get(id: number): Promise<UserDto>;');
    expect(output).to.include('create(body: CreateUserDto): Promise<UserDto | ValidationProblem>;');
    expect(output).to.include('avatar(id: number, file: Blob | File): Promise<void>;');
    expect(output).to.include('get(): Promise<{ ok: boolean }>;');
  });

  it('emits the served path and each argument wire binding in the route definition', () => {
    expect(output).to.include("get: { method: 'get', path: '/health/get', args: [] },");
    expect(output).to.include("list: { method: 'get', path: '/users/list', args: [{ in: 'query', name: 'query', shape: 'json' }] },");
    expect(output).to.include("get: { method: 'get', path: '/users/{id}', args: [{ in: 'path', name: 'id', shape: 'value' }] },");
    expect(output).to.include("create: { method: 'post', path: '/users/create', args: [{ in: 'body', shape: 'whole' }] },");
    expect(output).to.include("avatar: { method: 'post', path: '/users/{id}/avatar', args: [{ in: 'path', name: 'id', shape: 'value' }, { in: 'multipart', name: 'file', shape: 'value' }], void: true },");
  });

  it('emits a defineContract for each socket controller', () => {
    expect(output).to.include('export const chatContract = defineContract<{');
    expect(output).to.include('send: [{ text: string }, { id: string }]');
    expect(output).to.include('history: [{ since: string }, AsyncIterable<ChatMessage>]');
    expect(output).to.include('events: { message: ChatMessage };');
  });

  it('honours moduleName and includeSocket', async () => {
    const custom = await generateClient({ manifest, moduleName: './runtime.js', includeSocket: false });
    expect(custom).to.include("from './runtime.js';");
    expect(custom).to.not.include('defineContract');
  });

  it('leaves no x-* keys or schema ids in the output', () => {
    expect(output).to.not.match(/x-derived|x-explicit|\$id|[^@]spinajs\//);
  });

  describe('route shapes', () => {
    const query = (name: string): ParamWire => ({ in: 'query', name, shape: 'value' });

    it('fails generation for a parameter without a wire binding, naming the route and the parameter', async () => {
      const bare = extend(manifest, [route('open', 'get', '/items/open', [param(0, 'q', 'FromQuery', undefined, 'string')], { text: 'void' })], {});
      await expectRejection(generateClient({ manifest: bare }), /ItemsController\.open \(GET \/items\/open\).*'q'.*FromQuery/);
    });

    it('leaves out parameters that are not sent', async () => {
      const injected = extend(manifest, [route('who', 'get', '/items/who', [param(0, 'req', 'ArgAsRequest', { in: 'none', shape: 'whole' }, 'Request'), param(1, 'page', 'FromQuery', query('page'), 'number')], { text: 'void' })], {});
      const out = await generateClient({ manifest: injected });
      expect(out).to.include('who(page: number): Promise<void>;');
      expect(out).to.include("who: { method: 'get', path: '/items/who', args: [{ in: 'query', name: 'page', shape: 'value' }], void: true },");
    });

    it('keeps declaration order and types an optional argument before a required one as `| undefined`', async () => {
      const both = extend(
        manifest,
        [
          route(
            'search',
            'post',
            '/items/:id',
            [
              param(0, 'q', 'FromQuery', { in: 'query', name: 'q', shape: 'json' }, 'ListQuery', 'spinajs/app-basic/ListQuery', false),
              param(1, 'id', 'FromParams', { in: 'path', name: 'id', shape: 'value' }, 'number'),
              param(2, 'tenant', 'FromHeader', { in: 'header', name: 'x-tenant', shape: 'value' }, 'string', undefined, false),
            ],
            { text: 'string' },
          ),
        ],
        {},
      );
      const out = await generateClient({ manifest: both });
      expect(out).to.include('search(q: ListQuery | undefined, id: number, tenant?: string): Promise<string>;');
      expect(out).to.include("args: [{ in: 'query', name: 'q', shape: 'json' }, { in: 'path', name: 'id', shape: 'value' }, { in: 'header', name: 'x-tenant', shape: 'value' }]");
      expect(typecheck(out)).to.deep.equal([]);
    });

    it('types whole and field arguments by their parameter and files as Blob | File, arrays when multiple', async () => {
      const out = await generateClient({
        manifest: extend(
          manifest,
          [
            route(
              'fields',
              'post',
              '/items/:id',
              [
                param(0, 'p', 'ParamFieldRouteArgs', { in: 'path', shape: 'whole' }, 'Ids', 'spinajs/x/Ids'),
                param(1, 'q', 'QueryFieldRouteArgs', { in: 'query', shape: 'whole' }, 'ListQuery', 'spinajs/app-basic/ListQuery'),
                param(2, 'a', 'FromBody', { in: 'body', name: 'a', shape: 'field' }, 'CreateUserDto', 'spinajs/app-basic/CreateUserDto'),
                param(3, 'note', 'FromBody', { in: 'body', name: 'note', shape: 'field' }, 'string', undefined, false),
              ],
              { text: 'void' },
            ),
            route(
              'upload',
              'post',
              '/items/upload',
              [
                param(0, 'title', 'FromFormField', { in: 'multipart', name: 'title', shape: 'value' }, 'string'),
                param(1, 'doc', 'FromFile', { in: 'multipart', name: 'doc', shape: 'value' }, 'IUploadedFile'),
                param(2, 'docs', 'FromFile', { in: 'multipart', name: 'docs', shape: 'value', multiple: true }, 'IUploadedFile[]'),
              ],
              { text: 'void' },
            ),
          ],
          { 'spinajs/x/Ids': { $id: 'spinajs/x/Ids', type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
        ),
      });
      expect(out).to.include('fields(p: Ids, q: ListQuery, a: CreateUserDto, note?: string): Promise<void>;');
      expect(out).to.include('upload(title: string, doc: Blob | File, docs: (Blob | File)[]): Promise<void>;');
      expect(out).to.include("{ in: 'multipart', name: 'docs', shape: 'value', multiple: true }");
      expect(typecheck(out)).to.deep.equal([]);
    });

    it('adds a path argument for a placeholder no parameter binds', async () => {
      const out = await generateClient({ manifest: extend(manifest, [route('ping', 'get', '/items/:id/ping', [], { text: 'void' })], {}) });
      expect(out).to.include('ping(id: string | number): Promise<void>;');
      expect(out).to.include("ping: { method: 'get', path: '/items/{id}/ping', args: [{ in: 'path', name: 'id', shape: 'value' }], void: true },");
    });

    it('types a dependency model as an open object and a partial explicit schema from its derived shape', async () => {
      const out = await generateClient({
        manifest: extend(manifest, [route('mine', 'get', '/items/mine', [], { text: 'User', schema: 'spinajs/users/User' }), route('partial', 'get', '/items/partial', [], { text: 'Box', schema: 'spinajs/x/Box' })], {
          'spinajs/users/User': { $id: 'spinajs/users/User', type: 'object' },
          'spinajs/x/Box': { $id: 'spinajs/x/Box', type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false, 'x-explicit': 'partial' },
        }),
      });
      expect(out).to.include('mine(): Promise<User>;');
      expect(out).to.match(/export interface User \{\s*\[k: string\]: unknown;\s*\}/);
      expect(out).to.include('partial(): Promise<Box>;');
      expect(typecheck(out)).to.deep.equal([]);
    });

    it('resolves a bare wrapper return to unknown', async () => {
      const out = await generateClient({ manifest: extend(manifest, [route('bare', 'get', '/items/bare', [], { text: 'Ok' })], {}) });
      expect(out).to.include('bare(): Promise<unknown>;');
    });

    it('turns Express 5 optional groups and wildcards into runtime templates', async () => {
      const out = await generateClient({
        manifest: extend(
          manifest,
          [
            route('opt', 'get', '/items/opt{/:id}', [param(0, 'id', 'FromParams', { in: 'path', name: 'id', shape: 'value' }, 'number', undefined, false)], { text: 'void' }),
            route('tree', 'get', '/items/tree/*path', [param(0, 'path', 'FromParams', { in: 'path', name: 'path', shape: 'json' }, 'string[]')], { text: 'void' }),
            route('loose', 'get', '/items/loose{/:a}/*rest', [], { text: 'void' }),
            route('escaped', 'get', '/items/x\\{y\\}/:id', [], { text: 'void' }),
          ],
          {},
        ),
      });
      expect(out).to.include('opt(id?: number): Promise<void>;');
      expect(out).to.include("opt: { method: 'get', path: '/items/opt[/{id}]', args: [{ in: 'path', name: 'id', shape: 'value' }], void: true },");
      expect(out).to.include('tree(path: string[]): Promise<void>;');
      expect(out).to.include("tree: { method: 'get', path: '/items/tree/{*path}', args: [{ in: 'path', name: 'path', shape: 'json' }], void: true },");
      expect(out).to.include('loose(a: string | number | undefined, rest: string[]): Promise<void>;');
      expect(out).to.include("path: '/items/loose[/{a}]/{*rest}'");
      expect(out).to.include("path: '/items/x\\\\{y\\\\}/{id}'");
      expect(typecheck(out)).to.deep.equal([]);
    });

    it('fails generation for path syntax Express 5 refuses, naming the route', async () => {
      const legacy = extend(manifest, [route('legacy', 'get', '/items/:id(\\d+)', [param(0, 'id', 'FromParams', { in: 'path', name: 'id', shape: 'value' }, 'number')], { text: 'void' })], {});
      await expectRejection(generateClient({ manifest: legacy }), /ItemsController\.legacy \(GET \/items\/:id\(\\d\+\)\) uses path syntax the client does not support: '\(' at index 10 is reserved/);
      const open = extend(manifest, [route('open', 'get', '/items{/:id', [], { text: 'void' })], {});
      await expectRejection(generateClient({ manifest: open }), /ItemsController\.open .* an optional group is not closed/);
    });

    it('types a path argument as required even when the controller parameter is optional', async () => {
      const out = await generateClient({ manifest: extend(manifest, [route('one', 'get', '/items/:id', [param(0, 'id', 'FromParams', { in: 'path', name: 'id', shape: 'value' }, 'number', undefined, false)], { text: 'void' })], {}) });
      expect(out).to.include('one(id: number): Promise<void>;');
    });

    it('fails generation for a body argument next to a multipart one, which the server would bind as null', async () => {
      const mixed = extend(
        manifest,
        [
          route(
            'upload',
            'post',
            '/items/upload',
            [param(0, 'doc', 'FromFile', { in: 'multipart', name: 'doc', shape: 'value' }, 'IUploadedFile'), param(1, 'meta', 'FromBody', { in: 'body', shape: 'whole' }, 'CreateUserDto', 'spinajs/app-basic/CreateUserDto')],
            { text: 'void' },
          ),
        ],
        {},
      );
      await expectRejection(generateClient({ manifest: mixed }), /ItemsController\.upload \(POST \/items\/upload\) sends body argument\(s\) 'meta' next to multipart argument\(s\) 'doc'.*@FormField/);
    });

    it('escapes line breaks and line separators in emitted string literals', async () => {
      const out = await generateClient({
        manifest: extend(manifest, [route('odd', 'get', '/items/odd', [], { text: 'Odd', schema: 'spinajs/x/OddValues' })], {
          'spinajs/x/OddValues': { $id: 'spinajs/x/OddValues', enum: ['a\rb', 'c d', "e'f\\g"] },
        }),
      });
      expect(out).to.include("odd(): Promise<'a\\rb' | 'c\\u2028d' | 'e\\'f\\\\g'>;");
      expect(typecheck(out)).to.deep.equal([]);
    });
  });
});

async function expectRejection(promise: Promise<unknown>, message: RegExp): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).to.be.instanceOf(Error);
  expect((error as Error).message).to.match(message);
}
