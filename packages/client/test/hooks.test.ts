import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Manifest, ParamEntry, ParamWire, RouteEntry } from '@spinajs/manifest';
import { buildClientModel, generateClientFiles, type GenerateClientFilesOptions } from '../src/index.js';
import { hookRoutes, varsParameter } from '../src/generate/hooks/shared.js';
import { appBasicManifest } from './support/fixture.js';
import { keyTable, loadKeys } from './support/keys.js';
import { typecheckFiles } from './support/typecheck.js';

const source = { line: 1, col: 1, file: 'x.ts', package: 'x' };

function param(index: number, name: string, wire: ParamWire, text: string, required = true): ParamEntry {
  return { index, name, kind: wire.in === 'path' ? 'FromParams' : 'FromQuery', runtimeType: { text }, required, wire };
}

const idParam = (index = 0) => param(index, 'id', { in: 'path', name: 'id', shape: 'value' }, 'number');
const qParam = (index = 1) => param(index, 'q', { in: 'query', name: 'q', shape: 'value' }, 'string', false);

function searchRoute(params: ParamEntry[]): RouteEntry {
  return { method: 'get', path: '', handler: 'search', fullPath: '/items/:id/search', params, returnType: { text: 'string' }, policies: [], middlewares: [], source };
}

function withItems(base: Manifest, routes: RouteEntry[]): Manifest {
  return { ...base, controllers: [...base.controllers, { id: 'x:ItemsController', className: 'ItemsController', basePath: 'items', policies: [], middlewares: [], routes, source }] };
}

function mapRoute(base: Manifest, className: string, handler: string, change: (r: RouteEntry) => RouteEntry): Manifest {
  return { ...base, controllers: base.controllers.map((c) => (c.className === className ? { ...c, routes: c.routes.map((r) => (r.handler === handler ? change(r) : r)) } : c)) };
}

async function hookFiles(manifest: Manifest, options: Partial<GenerateClientFilesOptions> = {}): Promise<Record<string, string>> {
  const files = await generateClientFiles({ manifest, hooks: ['react-query'], ...options });
  return Object.fromEntries(files.map((f) => [f.path, f.contents]));
}

// The files every hooks target writes; each library adds its own after them.
const SHARED = /^[^.]+(\.keys|\.react)?\.ts$/;

const shared = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).filter(([path]) => SHARED.test(path)));

const snapshot = (name: string) => fileURLToPath(new URL(`./__snapshots__/${name}`, import.meta.url));

function matchSnapshot(name: string, contents: string): void {
  if (!existsSync(snapshot(name))) writeFileSync(snapshot(name), contents);
  expect(contents).to.equal(readFileSync(snapshot(name), 'utf8'));
}

describe('hooks shared module', () => {
  let manifest: Manifest;
  let files: Record<string, string>;

  before(async () => {
    manifest = await appBasicManifest();
    files = await hookFiles(manifest);
  });

  // Named after the 4.0 snapshot, so the snapshots' imports of `./app-basic.client.js` resolve for the linter.
  it('matches the committed snapshots of client.keys.ts and client.react.ts', async () => {
    expect(Object.keys(shared(files))).to.deep.equal(['client.ts', 'client.keys.ts', 'client.react.ts']);
    const named = await hookFiles(manifest, { basename: 'app-basic.client' });
    matchSnapshot('app-basic.client.keys.ts', named['app-basic.client.keys.ts']);
    matchSnapshot('app-basic.client.react.ts', named['app-basic.client.react.ts']);
  });

  it('writes the shared files once, the same for React Query, SWR and both', async () => {
    for (const hooks of [['swr'], ['react-query', 'swr'], ['swr', 'react-query']] as GenerateClientFilesOptions['hooks'][]) {
      expect(shared(await hookFiles(manifest, { hooks }))).to.deep.equal(shared(files));
    }
  });

  it('names the client module after basename and imports the runtime from moduleName', async () => {
    const custom = await hookFiles(manifest, { basename: 'api', moduleName: './runtime.js' });
    expect(Object.keys(shared(custom))).to.deep.equal(['api.ts', 'api.keys.ts', 'api.react.ts']);
    expect(custom['api.keys.ts']).to.include("import type { ProblemError } from './runtime.js';");
    expect(custom['api.keys.ts']).to.include("from './api.js';");
    expect(custom['api.react.ts']).to.include("from './api.js';");
  });

  for (const react of [18, 19] as const) {
    it(`type-checks with React ${react} types, strict and noUnusedLocals, and serves a typed app`, () => {
      expect(typecheckFiles({ ...files, 'app.ts': typedApp }, { noUnusedLocals: true, react })).to.deep.equal([]);
    });
  }

  const typedApp = [
      "import { createElement } from 'react';",
      "import { createAppClient, type UserDto } from './client.js';",
      "import { appKeys, appTags, clientShapeHash, type AppClientError } from './client.keys.js';",
      "import { AppClientProvider, useAppClient } from './client.react.js';",
      '',
      "export const get: readonly ['spinajs', 'users', 'get', { id: number }] = appKeys.users.get({ id: 7 });",
      "export const health: readonly ['spinajs', 'health', 'get', {}] = appKeys.health.get();",
      "export const healthVars: readonly ['spinajs', 'health', 'get', {}] = appKeys.health.get({});",
      "export const create: readonly ['spinajs', 'users', 'create'] = appKeys.users.create;",
      "export const all: readonly ['spinajs', 'users'] = appKeys.users.all;",
      "export const tag: 'spinajs:users:get' = appTags.users.get;",
      'export const buster: string = clientShapeHash;',
      "export const failure: AppClientError = new TypeError('fetch failed');",
      "export const tree = createElement(AppClientProvider, { client: createAppClient({ baseUrl: 'http://api' }) }, 'child');",
      'export function useUser(): Promise<UserDto> {',
      '  return useAppClient().users.get(7);',
      '}',
      '// @ts-expect-error the id is required',
      'appKeys.users.get({});',
      '// @ts-expect-error a route without arguments takes no variables',
      'appKeys.health.get({ id: 1 });',
      '// @ts-expect-error a mutation route has no tag',
      'void appTags.users.create;',
      '',
    ].join('\n');

  it('fails to compile against a client.ts generated from another manifest', () => {
    const stale = files['client.ts'].replace(`manifestHash = '${manifest.hash}'`, "manifestHash = 'other'");
    const errors = typecheckFiles({ ...files, 'client.ts': stale });
    expect(errors.filter((e) => e.startsWith('client.keys.ts: ') || e.startsWith('client.react.ts: '))).to.have.length(2);
  });

  it('starts every key with keyPrefix and every tag with it', async () => {
    const keys = await loadKeys((await hookFiles(manifest, { keyPrefix: 'app' }))['client.keys.ts']);
    expect(keys.appKeys.all).to.deep.equal(['app']);
    expect(keyTable(keys, { 'users.get': { id: 7 } })['users.get']).to.deep.equal(['app', 'users', 'get', { id: 7 }]);
    expect(keys.appTags.users).to.deep.equal({ all: 'app:users', list: 'app:users:list', get: 'app:users:get' });
  });

  it('builds every key as [prefix, controllerKey, handler, vars] and a mutation key without vars', async () => {
    const keys = await loadKeys(files['client.keys.ts']);
    expect(keyTable(keys, { 'users.get': { id: 7 }, 'users.list': { query: { page: 2 } }, 'articles.read': { id: 1 } })).to.deep.equal({
      all: ['spinajs'],
      'articles.all': ['spinajs', 'articles'],
      'articles.read': ['spinajs', 'articles', 'read', { id: 1 }],
      'articles.add': ['spinajs', 'articles', 'add'],
      'health.all': ['spinajs', 'health'],
      'health.get': ['spinajs', 'health', 'get', {}],
      'users.all': ['spinajs', 'users'],
      'users.list': ['spinajs', 'users', 'list', { query: { page: 2 } }],
      'users.get': ['spinajs', 'users', 'get', { id: 7 }],
      'users.create': ['spinajs', 'users', 'create'],
      'users.avatar': ['spinajs', 'users', 'avatar'],
    });
    expect(keys.appTags).to.deep.equal({
      articles: { all: 'spinajs:articles', read: 'spinajs:articles:read' },
      health: { all: 'spinajs:health', get: 'spinajs:health:get' },
      users: { all: 'spinajs:users', list: 'spinajs:users:list', get: 'spinajs:users:get' },
    });
  });

  it('refuses an empty keyPrefix', async () => {
    const error = await generateClientFiles({ manifest, hooks: ['swr'], keyPrefix: '' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as Error).message).to.equal('generateClientFiles: keyPrefix must not be empty');
  });

  describe('hookRoutes', () => {
    it('describes each query and mutation route with its hook name, variables, client call, key and tags', () => {
      const rows = hookRoutes(buildClientModel(manifest)).map((h) => [h.route.kind, h.hookName, h.varsType, h.varsOptional, h.callExpression, h.keyExpression, h.tags.controller, h.tags.route]);
      expect(rows).to.deep.equal([
        ['query', 'useArticlesRead', '{ id: number }', false, 'client.articles.read(vars.id)', 'appKeys.articles.read(vars)', 'spinajs:articles', 'spinajs:articles:read'],
        ['mutation', 'useArticlesAdd', '{ body: CreateArticleDto }', false, 'client.articles.add(vars.body)', 'appKeys.articles.add', 'spinajs:articles', 'spinajs:articles:add'],
        ['query', 'useHealthGet', 'Record<string, never>', true, 'client.health.get()', 'appKeys.health.get(vars)', 'spinajs:health', 'spinajs:health:get'],
        ['query', 'useUsersList', '{ query: ListQuery }', false, 'client.users.list(vars.query)', 'appKeys.users.list(vars)', 'spinajs:users', 'spinajs:users:list'],
        ['query', 'useUsersGet', '{ id: number }', false, 'client.users.get(vars.id)', 'appKeys.users.get(vars)', 'spinajs:users', 'spinajs:users:get'],
        ['mutation', 'useUsersCreate', '{ body: CreateUserDto }', false, 'client.users.create(vars.body)', 'appKeys.users.create', 'spinajs:users', 'spinajs:users:create'],
        ['mutation', 'useUsersAvatar', '{ file: Blob | File; id: number }', false, 'client.users.avatar(vars.id, vars.file)', 'appKeys.users.avatar', 'spinajs:users', 'spinajs:users:avatar'],
      ]);
    });

    it('gives HEAD and file routes no hook, and marks all-optional variables as optional', () => {
      const route = (handler: string, method: RouteEntry['method'], params: ParamEntry[] = []): RouteEntry => ({ ...searchRoute(params), handler, method, fullPath: `/items/${handler}` });
      const model = buildClientModel(withItems(manifest, [route('peek', 'head'), route('download', 'file'), route('find', 'get', [qParam(0)])]), { includeSocket: false });
      const items = hookRoutes(model).filter((h) => h.route.controllerKey === 'items');
      expect(items.map((h) => [h.route.name, h.varsType, h.varsOptional, h.keyExpression])).to.deep.equal([['find', '{ q?: string }', true, 'appKeys.items.find(vars)']]);
    });

    for (const [what, className, handler, message] of [
      ['a handler named all', 'ItemsController', 'all', 'generateClientFiles: ItemsController.all (GET /items/all) would replace appKeys.items.all; rename the handler to generate hooks, or generate client.ts alone without hooks'],
      ['a controller keyed all', 'AllController', 'search', "generateClientFiles: AllController (base path 'items') would replace appKeys.all; rename the controller to generate hooks, or generate client.ts alone without hooks"],
    ]) {
      it(`refuses ${what}, which would replace a prefix key`, () => {
        const clash: Manifest = { ...manifest, controllers: [{ id: `x:${className}`, className, basePath: 'items', policies: [], middlewares: [], routes: [{ ...searchRoute([]), handler, fullPath: `/items/${handler}` }], source }] };
        expect(() => hookRoutes(buildClientModel(clash, { includeSocket: false }))).to.throw(message);
      });
    }

    it('refuses two routes whose hooks would share a name', () => {
      const listGet: RouteEntry = { ...searchRoute([]), handler: 'listGet', fullPath: '/users/list-get' };
      const get: RouteEntry = { ...searchRoute([]), handler: 'get', fullPath: '/users-list/get' };
      const clash: Manifest = {
        ...manifest,
        controllers: [
          { id: 'x:UsersController', className: 'UsersController', basePath: 'users', policies: [], middlewares: [], routes: [listGet], source },
          { id: 'x:UsersListController', className: 'UsersListController', basePath: 'users-list', policies: [], middlewares: [], routes: [get], source },
        ],
      };
      expect(() => hookRoutes(buildClientModel(clash, { includeSocket: false }))).to.throw(
        'generateClientFiles: UsersController.listGet (GET /users/list-get) and UsersListController.get (GET /users-list/get) would both be useUsersListGet; rename one to generate hooks, or generate client.ts alone without hooks',
      );
    });

    it('imports exactly the types the variables reference, not a member that shares a type name', async () => {
      const named = withItems(manifest, [{ ...searchRoute([param(0, 'UserDto', { in: 'query', name: 'UserDto', shape: 'value' }, 'string')]), fullPath: '/items/search' }]);
      const generated = await hookFiles(named);
      expect(generated['client.keys.ts']).to.include("import type { ListQuery, manifestHash } from './client.js';");
      expect(typecheckFiles(generated, { noUnusedLocals: true })).to.deep.equal([]);
    });
  });

  describe('query-key stability', () => {
    const keysOf = async (m: Manifest) => loadKeys((await hookFiles(m))['client.keys.ts']);
    const vars = { 'users.get': { id: 7 }, 'users.list': { query: {} }, 'articles.read': { id: 1 }, 'items.search': { id: 3 } };

    it('keeps every key, tag and the shape hash when a route moves to another path', async () => {
      const moved = mapRoute(manifest, 'UsersController', 'get', (r) => ({ ...r, fullPath: '/people/:id', path: '/people/:id' }));
      const [before, after] = [await hookFiles(manifest), await hookFiles(moved)];
      expect(after['client.ts']).to.not.equal(before['client.ts']);
      expect(after['client.keys.ts']).to.equal(before['client.keys.ts']);
      expect(keyTable(await keysOf(moved), vars)).to.deep.equal(keyTable(await keysOf(manifest), vars));
    });

    it('changes exactly the renamed route: its key, its hook name, its tag', async () => {
      const renamed = mapRoute(manifest, 'UsersController', 'get', (r) => ({ ...r, handler: 'read' }));
      const [before, after] = [keyTable(await keysOf(manifest), vars), keyTable(await keysOf(renamed), { ...vars, 'users.read': { id: 7 } })];
      const { 'users.get': oldKey, ...unchanged } = before;
      const { 'users.read': newKey, ...rest } = after;
      expect(rest).to.deep.equal(unchanged);
      expect([oldKey, newKey]).to.deep.equal([
        ['spinajs', 'users', 'get', { id: 7 }],
        ['spinajs', 'users', 'read', { id: 7 }],
      ]);
      const names = (m: Manifest) => hookRoutes(buildClientModel(m)).map((h) => h.hookName);
      expect(names(renamed)).to.deep.equal(names(manifest).map((n) => (n === 'useUsersGet' ? 'useUsersRead' : n)));
    });

    it('keeps the key and the variables type when the parameters are reordered; only the client call follows', async () => {
      const ordered = withItems(manifest, [searchRoute([idParam(0), qParam(1)])]);
      const swapped = withItems(manifest, [searchRoute([qParam(0), idParam(1)])]);
      const [a, b] = [await hookFiles(ordered), await hookFiles(swapped)];
      expect(b['client.keys.ts']).to.equal(a['client.keys.ts']);
      const search = (m: Manifest) => hookRoutes(buildClientModel(m)).find((h) => h.route.controllerKey === 'items');
      expect([search(ordered)?.varsType, search(ordered)?.callExpression, search(swapped)?.callExpression]).to.deep.equal(['{ id: number; q?: string }', 'client.items.search(vars.id, vars.q)', 'client.items.search(vars.q, vars.id)']);
    });

    // The shape FG-10 and FG-11 print: the variables slot, then options.
    const hookSketch = (m: Manifest) =>
      [
        "import { appKeys } from './client.keys.js';",
        ...hookRoutes(buildClientModel(m))
          .filter((h) => h.route.controllerKey === 'items')
          .map((h) => `export function ${h.hookName}(${varsParameter(h)}, options?: { staleTime?: number }) {\n  return [${h.keyExpression}, options] as const;\n}`),
        '',
      ].join('\n');

    it('keeps existing call sites of keys and hooks compiling when an optional argument is added, and the no-argument key unchanged', async () => {
      const v1 = withItems(manifest, [searchRoute([idParam(0)]), { ...searchRoute([]), handler: 'count', fullPath: '/items/count' }]);
      const v2 = withItems(manifest, [searchRoute([idParam(0), qParam(1)]), { ...searchRoute([qParam(0)]), handler: 'count', fullPath: '/items/count' }]);
      const app = [
        "import { appKeys } from './client.keys.js';",
        "import { useItemsCount, useItemsSearch } from './hooks.js';",
        'export const search = appKeys.items.search({ id: 1 });',
        'export const count = appKeys.items.count();',
        'export const counted = [useItemsCount(), useItemsCount({}), useItemsCount({}, { staleTime: 1 }), useItemsSearch({ id: 1 }, { staleTime: 1 })];',
        '// @ts-expect-error options never go into the variables slot',
        'useItemsCount({ staleTime: 1 });',
        '',
      ].join('\n');
      for (const m of [v1, v2]) expect(typecheckFiles({ ...(await hookFiles(m)), 'hooks.ts': hookSketch(m), 'app.ts': app })).to.deep.equal([]);
      const counts = await Promise.all([v1, v2].map(async (m) => keyTable(await keysOf(m))['items.count']));
      expect(counts).to.deep.equal([
        ['spinajs', 'items', 'count', {}],
        ['spinajs', 'items', 'count', {}],
      ]);
    });
  });

  describe('clientShapeHash', () => {
    const hashOf = async (m: Manifest) => (await loadKeys((await hookFiles(m))['client.keys.ts'])).clientShapeHash;
    let base: string;

    before(async () => {
      base = await hashOf(manifest);
    });

    it('is a sha256 hex digest', () => {
      expect(base).to.match(/^[0-9a-f]{64}$/);
    });

    it('ignores a path move, a policy change, annotations, HEAD and file routes, and the order of routes and parameters', async () => {
      const userDto = manifest.schemas['spinajs/app-basic/UserDto'] as { properties: Record<string, Record<string, unknown>> };
      const annotated = { ...userDto, description: 'A user', $comment: 'c', deprecated: true, properties: { ...userDto.properties, email: { ...userDto.properties.email, examples: ['a@b.c'], readOnly: true, writeOnly: false } } };
      const head: RouteEntry = { ...searchRoute([]), handler: 'peek', method: 'head', fullPath: '/items/peek' };
      const unchanged = [
        { ...manifest, schemas: { ...manifest.schemas, 'spinajs/app-basic/UserDto': annotated } },
        withItems(manifest, [head, { ...head, handler: 'download', method: 'file', fullPath: '/items/download' }]),
        mapRoute(manifest, 'UsersController', 'get', (r) => ({ ...r, fullPath: '/people/:id' })),
        mapRoute(manifest, 'UsersController', 'get', (r) => ({ ...r, policies: [] })),
        { ...manifest, controllers: manifest.controllers.map((c) => ({ ...c, routes: [...c.routes].reverse() })) },
      ];
      for (const m of unchanged) expect(await hashOf(m)).to.equal(base);
      expect(await hashOf(withItems(manifest, [searchRoute([qParam(0), idParam(1)])]))).to.equal(await hashOf(withItems(manifest, [searchRoute([idParam(0), qParam(1)])])));
    });

    it('changes with a route name, an argument name or a reply schema, nested ones included', async () => {
      const userDto = manifest.schemas['spinajs/app-basic/UserDto'] as { properties: Record<string, unknown> };
      const changed = [
        mapRoute(manifest, 'UsersController', 'get', (r) => ({ ...r, handler: 'read' })),
        mapRoute(manifest, 'UsersController', 'get', (r) => ({ ...r, params: r.params.map((p) => ({ ...p, name: 'userId' })) })),
        { ...manifest, schemas: { ...manifest.schemas, 'spinajs/app-basic/UserDto': { ...userDto, properties: { ...userDto.properties, age: { type: 'number' } } } } },
        { ...manifest, schemas: { ...manifest.schemas, 'spinajs/app-basic/UserDto': { ...userDto, properties: { ...userDto.properties, description: { type: 'string' } } } } },
      ];
      for (const m of changed) expect(await hashOf(m)).to.not.equal(base);
    });
  });
});
