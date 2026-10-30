import 'mocha';
import { expect } from 'chai';
import { PROBLEM_DETAILS_SCHEMA, buildRoutePath, CONTROLLED_DESCRIPTOR_SYMBOL } from '@spinajs/http';
import type { IControllerDescriptor } from '@spinajs/http';
import { controllerMountPath, routeFullPath, servedPath } from '@spinajs/manifest';
import type { Manifest, ParamEntry, RouteEntry } from '@spinajs/manifest';
import { manifestToOpenApi } from '../src/index.js';
import { openApiPath } from '../src/paths.js';
import { HealthController } from '../../compiler/test/fixtures/app-basic/src/controllers/HealthController.js';
import { UsersController } from '../../compiler/test/fixtures/app-basic/src/controllers/users.js';
import { appBasicManifest } from './support/fixture.js';

const options = { title: 'app-basic', version: '1.0.0', errorSchema: PROBLEM_DETAILS_SCHEMA };
type Json = Record<string, unknown>;
type Operation = { parameters: Json[]; requestBody?: { required: boolean; content: Record<string, Json> } };

describe('manifestToOpenApi wire bindings', () => {
  let manifest: Manifest;
  const routeOf = (m: Manifest, path: string): RouteEntry => m.controllers.flatMap((c) => c.routes).find((r) => r.fullPath === path)!;
  const param = (index: number, name: string, kind: string, wire: ParamEntry['wire'], schema?: string, required = true): ParamEntry => ({ index, name, kind, runtimeType: { text: 'T', ...(schema ? { schema } : {}) }, required, wire });
  const operationFor = (m: Manifest, path: string, method: 'get' | 'post'): Operation => manifestToOpenApi(m, options).paths![path]![method] as unknown as Operation;
  const withParams = (path: string, params: ParamEntry[], schemas: Record<string, unknown> = {}): Manifest => {
    const copy = structuredClone(manifest);
    Object.assign(copy.schemas, schemas);
    routeOf(copy, path).params = params;
    return copy;
  };

  before(async () => {
    manifest = await appBasicManifest();
  });

  it('value: a plain parameter with the derived schema', () => {
    const m = withParams('/users/list', [param(0, 'page', 'FromQuery', { in: 'query', name: 'page', shape: 'value' }, 'spinajs/t/Page', false)], { 'spinajs/t/Page': { type: 'number' } });
    expect(operationFor(m, '/users/list', 'get').parameters).to.deep.equal([{ name: 'page', in: 'query', required: false, schema: { type: 'number' } }]);
  });

  it('json: one parameter under the wire name with application/json content', () => {
    const list = operationFor(manifest, '/users/list', 'get');
    expect(list.parameters).to.deep.equal([{ name: 'query', in: 'query', required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ListQuery' } } } }]);

    const m = withParams('/users/list', [param(0, 'filter', 'FromHeader', { in: 'header', name: 'x-filter', shape: 'json' }, 'spinajs/app-basic/ListQuery')]);
    expect(operationFor(m, '/users/list', 'get').parameters).to.deep.equal([{ name: 'x-filter', in: 'header', required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ListQuery' } } } }]);
  });

  it('whole query: the DTO properties exploded as form parameters', () => {
    const m = withParams('/users/list', [param(0, 'q', 'QueryFieldRouteArgs', { in: 'query', shape: 'whole' }, 'spinajs/t/Q')], {
      'spinajs/t/Q': { type: 'object', properties: { a: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['a'] },
    });
    expect(operationFor(m, '/users/list', 'get').parameters).to.deep.equal([
      { name: 'a', in: 'query', required: true, schema: { type: 'string' }, style: 'form', explode: true },
      { name: 'tags', in: 'query', required: false, schema: { type: 'array', items: { type: 'string' } }, style: 'form', explode: true },
    ]);
  });

  it('whole body: the request body is the DTO schema in the media type of the argument', () => {
    expect(operationFor(manifest, '/users/create', 'post').requestBody).to.deep.equal({ required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateUserDto' } } } });

    const fields = withParams('/users/create', [param(0, 'body', 'BodyFieldRouteArgs', { in: 'body', shape: 'whole' }, 'spinajs/app-basic/CreateUserDto', false)]);
    expect(operationFor(fields, '/users/create', 'post').requestBody).to.deep.equal({ required: false, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateUserDto' } } } });

    const xml = withParams('/users/create', [param(0, 'doc', 'FromXmlRouteArgs', { in: 'body', shape: 'whole' }, 'spinajs/app-basic/CreateUserDto')]);
    expect(Object.keys(operationFor(xml, '/users/create', 'post').requestBody!.content)).to.deep.equal(['application/xml']);
  });

  it('field: several body arguments become one object body keyed by their names', () => {
    const m = withParams(
      '/users/create',
      [
        param(0, 'user', 'FromBody', { in: 'body', name: 'user', shape: 'field' }, 'spinajs/app-basic/CreateUserDto'),
        param(1, 'note', 'FromBody', { in: 'body', name: 'note', shape: 'field' }, 'spinajs/t/Note', false),
      ],
      { 'spinajs/t/Note': { type: 'string' } },
    );
    expect(operationFor(m, '/users/create', 'post').requestBody).to.deep.equal({
      required: true,
      content: { 'application/json': { schema: { type: 'object', properties: { user: { $ref: '#/components/schemas/CreateUserDto' }, note: { type: 'string' } }, required: ['user'] } } },
    });
  });

  it('multiple: repeated file parts are an array of binaries', () => {
    const m = withParams('/users/:id/avatar', [param(0, 'id', 'FromParams', { in: 'path', name: 'id', shape: 'value' }), param(1, 'files', 'FromFile', { in: 'multipart', name: 'files', shape: 'value', multiple: true })]);
    const body = operationFor(m, '/users/{id}/avatar', 'post').requestBody!;
    expect(body.content['multipart/form-data']).to.deep.equal({ schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string', format: 'binary' } } }, required: ['files'] } });
  });

  it('documents a JSON form field with its part encoding', () => {
    const m = withParams('/users/create', [param(0, 'meta', 'FromFormField', { in: 'multipart', name: 'meta', shape: 'json' }, 'spinajs/app-basic/CreateUserDto')]);
    expect(operationFor(m, '/users/create', 'post').requestBody!.content['multipart/form-data']).to.deep.equal({
      schema: { type: 'object', properties: { meta: { $ref: '#/components/schemas/CreateUserDto' } }, required: ['meta'] },
      encoding: { meta: { contentType: 'application/json' } },
    });
  });

  it('leaves injected arguments out of the operation', () => {
    const m = withParams('/users/list', [param(0, 'req', 'ArgAsRequest', { in: 'none', shape: 'whole' }), param(1, 'svc', 'FromDi', { in: 'none', shape: 'whole' })]);
    const op = operationFor(m, '/users/list', 'get');
    expect(op.parameters).to.deep.equal([]);
    expect(op).to.not.have.property('requestBody');
  });

  it('rejects a parameter without a wire binding', () => {
    const m = withParams('/users/list', [{ index: 0, name: 'legacy', kind: 'SomethingNew', runtimeType: { text: 'string' }, required: true }]);
    expect(() => manifestToOpenApi(m, options)).to.throw(/Users_list[\s\S]*legacy[\s\S]*SomethingNew/);
  });

  it('gives two bare @Get() routes of one controller their own served paths', () => {
    const m = structuredClone(manifest);
    const users = m.controllers.find((c) => c.className === 'UsersController')!;
    const count = structuredClone(routeOf(m, '/users/list'));
    count.handler = 'count';
    count.fullPath = servedPath(routeFullPath(users.mountPath!, count.path, count.handler));
    users.routes.push(count);
    const paths = manifestToOpenApi(m, options).paths!;
    expect(paths['/users/count']!.get!.operationId).to.equal('Users_count');
    expect(paths['/users/list']!.get!.operationId).to.equal('Users_list');
  });

  it('applies the route prefix as the router does', () => {
    expect(openApiPath('/users/:id', '', 'api')).to.equal('/api/users/{id}');
    expect(openApiPath('/', '', 'api')).to.equal('/api');
    expect(Object.keys(manifestToOpenApi(manifest, { ...options, routePrefix: 'v1' }).paths!)).to.include('/v1/users/list');
  });

  it('documents the paths and argument kinds the http router registers for the fixture controllers', () => {
    const doc = manifestToOpenApi(manifest, options);
    for (const ctor of [HealthController, UsersController]) {
      const descriptor = Reflect.getOwnMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, ctor.prototype) as IControllerDescriptor;
      const entry = manifest.controllers.find((c) => c.className === ctor.name)!;
      expect(entry.mountPath).to.equal(controllerMountPath(descriptor.BasePath, ctor.name));
      expect(descriptor.Routes.size).to.equal(entry.routes.length);
      for (const [, route] of descriptor.Routes) {
        const served = openApiPath(servedPath(buildRoutePath(controllerMountPath(descriptor.BasePath, ctor.name), route)));
        const op = doc.paths![served]?.[route.InternalType as 'get' | 'post'];
        expect(op?.operationId, `${String(route.Method)} at ${served}`).to.equal(`${ctor.name.replace(/Controller$/, '')}_${String(route.Method)}`);
        const kinds = [...route.Parameters.values()].sort((a, b) => a.Index - b.Index).map((p) => p.Type);
        expect(entry.routes.find((r) => r.handler === route.Method)!.params.map((p) => p.kind)).to.deep.equal(kinds);
      }
    }
  });
});
