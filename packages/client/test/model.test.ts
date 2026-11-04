import 'mocha';
import { expect } from 'chai';
import type { Manifest, RouteEntry } from '@spinajs/manifest';
import { buildClientModel, generateClient, type ClientModel, type RouteModel } from '../src/index.js';
import { emitClient } from '../src/generate.js';
import { appBasicManifest } from './support/fixture.js';

const source = { line: 1, col: 1, file: 'x.ts', package: 'x' };

function route(handler: string, method: RouteEntry['method']): RouteEntry {
  return { method, path: '', handler, fullPath: `/items/${handler}`, params: [], returnType: { text: 'void' }, policies: [], middlewares: [], source };
}

function routeOf(model: ClientModel, controllerKey: string, name: string): RouteModel {
  const found = model.controllers.find((c) => c.key === controllerKey)?.routes.find((r) => r.name === name);
  if (!found) throw new Error(`no route ${controllerKey}.${name}`);
  return found;
}

describe('buildClientModel', () => {
  let manifest: Manifest;
  let model: ClientModel;

  before(async () => {
    manifest = await appBasicManifest();
    model = buildClientModel(manifest);
  });

  it('carries the manifest hash and the socket controllers', () => {
    expect(model.manifestHash).to.equal(manifest.hash);
    expect(model.sockets.map((s) => s.id)).to.deep.equal(['app-basic:ChatSocketController']);
  });

  it('records whether the client includes sockets, so every printer of the model agrees', async () => {
    const noSockets: Manifest = { ...manifest, socketControllers: [] };
    expect(model.includeSocket).to.equal(true);
    expect(buildClientModel(manifest, { includeSocket: false }).includeSocket).to.equal(false);
    expect(buildClientModel(noSockets).includeSocket).to.equal(false);
    const forced = buildClientModel(noSockets, { includeSocket: true });
    expect(forced.includeSocket).to.equal(true);
    expect(await emitClient(forced)).to.include("import { defineContract } from '@spinajs/http-socket-common';");
  });

  it('orders controllers by class name and names them as the client does', () => {
    expect(model.controllers.map((c) => [c.key, c.base, c.entry.className])).to.deep.equal([
      ['articles', 'Articles', 'ArticlesController'],
      ['health', 'Health', 'HealthController'],
      ['users', 'Users', 'UsersController'],
    ]);
  });

  it('records each route with its key, method, TS types, schema ids and route-table literal', () => {
    expect(routeOf(model, 'users', 'get')).to.deep.equal({
      controllerKey: 'users',
      name: 'get',
      method: 'get',
      kind: 'query',
      args: [{ name: 'id', type: 'number', required: true, wire: { in: 'path', name: 'id', shape: 'value' }, schema: 'spinajs/app-basic/UsersController_get_id' }],
      returns: 'UserDto',
      returnSchema: 'spinajs/app-basic/UserDto',
      definition: "{ method: 'get', path: '/users/{id}', args: [{ in: 'path', name: 'id', shape: 'value' }] }",
    });
  });

  it('leaves the schema id out where the manifest has none', () => {
    const avatar = routeOf(model, 'users', 'avatar');
    expect(avatar.kind).to.equal('mutation');
    expect(avatar.returnSchema).to.equal(undefined);
    expect(avatar.args[1]).to.deep.equal({ name: 'file', type: 'Blob | File', required: true, wire: { in: 'multipart', name: 'file', shape: 'value' } });
  });

  it('gives GET a query, POST, PUT, PATCH and DELETE a mutation, and HEAD and file routes neither', () => {
    const methods: RouteEntry['method'][] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'file'];
    const items = buildClientModel({
      ...manifest,
      controllers: [{ id: 'x:ItemsController', className: 'ItemsController', basePath: 'items', policies: [], middlewares: [], routes: methods.map((m) => route(m, m)), source }],
    });
    const routes = items.controllers[0].routes.map((r) => [r.name, r.method, r.kind]);
    expect(routes).to.deep.equal([
      ['get', 'get', 'query'],
      ['post', 'post', 'mutation'],
      ['put', 'put', 'mutation'],
      ['patch', 'patch', 'mutation'],
      ['delete', 'delete', 'mutation'],
      ['head', 'head', 'none'],
      ['file', 'get', 'none'],
    ]);
  });

  it('describes a placeholder no parameter binds as a required path argument without a schema', () => {
    const ping = buildClientModel({ ...manifest, controllers: [items([{ ...route('ping', 'get'), fullPath: '/items/:id/ping' }])] });
    expect(ping.controllers[0].routes[0].args).to.deep.equal([{ name: 'id', type: 'string | number', required: true, wire: { in: 'path', name: 'id', shape: 'value' } }]);
  });

  describe('schema set', () => {
    const names = (m: ClientModel) => [...m.ctx.used].map((id) => m.ctx.nameOf(id)).sort();
    const declared = (client: string) => [...client.matchAll(/^export (?:interface|type) (\w+)/gm)].map((m) => m[1]).filter((n) => !n.endsWith('Client')).sort();

    it('is complete when the model is built, socket types included, and equals what client.ts declares', async () => {
      const fresh = buildClientModel(manifest);
      expect(names(fresh)).to.deep.equal(['ArticleDto', 'ChatMessage', 'CreateArticleDto', 'CreateUserDto', 'ListQuery', 'UserDto', 'ValidationProblem']);
      expect(declared(await generateClient({ manifest }))).to.deep.equal(names(fresh));
    });

    it('leaves the socket controllers and their types out when includeSocket is false', async () => {
      const httpOnly = buildClientModel(manifest, { includeSocket: false });
      expect(httpOnly.sockets).to.deep.equal([]);
      expect(names(httpOnly)).to.not.include('ChatMessage');
      expect(declared(await generateClient({ manifest, includeSocket: false }))).to.deep.equal(names(httpOnly));
    });

    it('follows $refs through nested schemas without printing, and skips the x-* keys client.ts drops', async () => {
      const nested: Manifest = {
        ...manifest,
        schemas: {
          ...manifest.schemas,
          'spinajs/x/Outer': { type: 'object', properties: { inner: { $ref: 'spinajs/x/Inner' } }, 'x-meta': { $ref: 'spinajs/x/Hidden' } },
          'spinajs/x/Inner': { type: 'object', properties: { deep: { type: 'array', items: { $ref: 'spinajs/x/Deep' } } } },
          'spinajs/x/Deep': { type: 'object', properties: { n: { type: 'number' } } },
          'spinajs/x/Hidden': { type: 'object' },
        },
        controllers: [items([{ ...route('outer', 'get'), returnType: { text: 'Outer', schema: 'spinajs/x/Outer' } }])],
      };
      const built = buildClientModel(nested, { includeSocket: false });
      expect(names(built)).to.deep.equal(['Deep', 'Inner', 'Outer']);
      expect(declared(await generateClient({ manifest: nested, includeSocket: false }))).to.deep.equal(['Deep', 'Inner', 'Outer']);
    });

    it('refuses to print a schema the model did not resolve', () => {
      expect(() => buildClientModel(manifest).ctx.reference('spinajs/app-basic/ArticlesController_read_id')).to.throw(/outside the client model/);
    });
  });
});

function items(routes: RouteEntry[]): Manifest['controllers'][number] {
  return { id: 'x:ItemsController', className: 'ItemsController', basePath: 'items', policies: [], middlewares: [], routes, source };
}
