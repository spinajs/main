import 'mocha';
import { expect } from 'chai';
import type { Manifest, RouteEntry } from '@spinajs/manifest';
import { buildClientModel, type ClientModel, type RouteModel } from '../src/index.js';
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

  it('adds the referenced schemas to the type context', () => {
    expect([...model.ctx.used].sort()).to.include.members(['spinajs/app-basic/UserDto', 'spinajs/app-basic/CreateUserDto', 'spinajs/app-basic/ListQuery']);
  });
});
