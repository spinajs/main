import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Manifest, ParamEntry, RouteEntry } from '@spinajs/manifest';
import { generateClient } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';
import { typecheck } from './support/typecheck.js';

const snapshotPath = fileURLToPath(new URL('./__snapshots__/app-basic.client.ts', import.meta.url));

const source = { line: 1, col: 1, file: 'x.ts', package: 'x' };

function param(index: number, name: string, kind: string, text: string, schema?: string, required = true): ParamEntry {
  return { index, name, kind, runtimeType: { text, ...(schema ? { schema } : {}) }, required };
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

  it('emits one interface per controller with the (params, query, body) argument order', () => {
    expect(output).to.include('list(query?: ListQuery): Promise<UserDto[]>;');
    expect(output).to.include('get(params: { id: number }): Promise<UserDto>;');
    expect(output).to.include('create(body: CreateUserDto): Promise<UserDto | ValidationProblem>;');
    expect(output).to.include('avatar(params: { id: number }, body: { file: Blob | File }): Promise<void>;');
    expect(output).to.include('get(): Promise<{ ok: boolean }>;');
  });

  it('emits the route definition the runtime consumes', () => {
    expect(output).to.include("list: { method: 'get', path: '/users', params: [], query: ['page', 'perPage'] },");
    expect(output).to.include("get: { method: 'get', path: '/users/{id}', params: ['id'] },");
    expect(output).to.include("create: { method: 'post', path: '/users', params: [], body: 'json' },");
    expect(output).to.include("avatar: { method: 'post', path: '/users/{id}/avatar', params: ['id'], body: 'multipart', files: ['file'], void: true },");
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
    it('omits the query argument when the query shape has no known keys', async () => {
      const open = extend(manifest, [route('open', 'get', '/items', [param(0, 'q', 'FromQuery', 'Opaque', 'spinajs/x/Opaque')], { text: 'void' })], { 'spinajs/x/Opaque': { $id: 'spinajs/x/Opaque', type: 'object' } });
      const out = await generateClient({ manifest: open });
      expect(out).to.include('open(): Promise<void>;');
      expect(out).to.include("open: { method: 'get', path: '/items', params: [], void: true },");
    });

    it('keeps the query slot in front of a body', async () => {
      const both = extend(manifest, [route('search', 'post', '/items/:id', [param(0, 'id', 'FromParams', 'number'), param(1, 'q', 'FromQuery', 'ListQuery', 'spinajs/app-basic/ListQuery'), param(2, 'body', 'FromBody', 'CreateUserDto', 'spinajs/app-basic/CreateUserDto')], { text: 'string' })], {});
      const out = await generateClient({ manifest: both });
      expect(out).to.include('search(params: { id: number }, query: ListQuery | undefined, body: CreateUserDto): Promise<string>;');
      expect(typecheck(out)).to.deep.equal([]);
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

    it('types whole-request kinds by their parameter and multipart from form fields', async () => {
      const out = await generateClient({
        manifest: extend(
          manifest,
          [
            route('fields', 'post', '/items/:id', [param(0, 'p', 'ParamFieldRouteArgs', 'Ids', 'spinajs/x/Ids'), param(1, 'q', 'QueryFieldRouteArgs', 'ListQuery', 'spinajs/app-basic/ListQuery'), param(2, 'b', 'BodyFieldRouteArgs', 'CreateUserDto', 'spinajs/app-basic/CreateUserDto', false)], { text: 'void' }),
            route('upload', 'post', '/items/upload', [param(0, 'title', 'FromFormField', 'string'), param(1, 'doc', 'FromFile', 'IUploadedFile')], { text: 'void' }),
          ],
          { 'spinajs/x/Ids': { $id: 'spinajs/x/Ids', type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
        ),
      });
      expect(out).to.include('fields(params: { id: number }, query: ListQuery | undefined, body?: CreateUserDto): Promise<void>;');
      expect(out).to.include('upload(body: { title: string; doc: Blob | File }): Promise<void>;');
      expect(out).to.include("body: 'multipart', files: ['doc']");
      expect(typecheck(out)).to.deep.equal([]);
    });
  });
});
