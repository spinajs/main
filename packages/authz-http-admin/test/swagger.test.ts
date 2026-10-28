import 'mocha';
import { resolve } from 'node:path';

import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { CONTROLLED_DESCRIPTOR_SYMBOL, Controllers } from '@spinajs/http';
import type { IControllerDescriptor } from '@spinajs/http';
import { OpenApiBuilder, SwaggerDocCache } from '@spinajs/http-swagger';
import type { IOpenApiDocument } from '@spinajs/http-swagger';

import { AuthzAdminController } from '../src/controllers/AuthzAdminController.js';
import { ASSIGNMENT_GRANT_SCHEMA, ASSIGNMENT_PATCH_SCHEMA, LINK_CREATE_SCHEMA, LINK_PATCH_SCHEMA, POLICY_BODY_SCHEMA, RULE_BODY_SCHEMA } from '../src/dto/index.js';
import { AUTHZ_ADMIN_SCHEMAS, COMMAND_KINDS, commandSchemas, describeAuthzAdminDocument } from '../src/schemas/index.js';
import { startApp, stopApp } from './support/app.js';

// The controller's JSDoc is read from the compiled declaration file (`pretest` compiles it).
const COMPILED = resolve(process.cwd(), 'lib', 'controllers', 'AuthzAdminController.js');

const descriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, AuthzAdminController.prototype) as IControllerDescriptor;
/** Every route of the controller as its document path. */
const ROUTES = [...descriptor.Routes.values()].map((r) => ({ method: r.Type as string, path: `/authz/${(r.Path ?? '').replace(/:(\w+)/g, '{$1}')}` }));

// ModelSchemaProvider (@spinajs/orm, loaded by the other tests) iterates the '__models__' registry and fails while it is empty.
class RegistryPlaceholder {}

describe('authz-http-admin swagger', function () {
  this.timeout(60000);

  let doc: any;

  before(async () => {
    DI.register(RegistryPlaceholder).as('__models__');
    await startApp({ controllers: [AuthzAdminController] });
    const listed = await (await DI.resolve(Controllers)).Controllers;
    const info = listed.find((c) => c.name === 'AuthzAdminController');
    expect(info, 'AuthzAdminController is registered').to.not.eq(undefined);

    const docs = await (await DI.resolve(SwaggerDocCache)).getCache({ ...info!, file: COMPILED });
    const builder = await DI.resolve(OpenApiBuilder, [{ enabled: true, title: 'test', version: '1' }]);
    builder.addController({ ...info!, file: COMPILED }, docs);
    doc = describeAuthzAdminDocument(builder.build() as IOpenApiDocument);
  });

  after(async () => {
    await stopApp();
    DI.unregister(RegistryPlaceholder);
    DI.uncache('__models__');
  });

  it('documents every route under the Authz admin tag, with a summary', () => {
    for (const r of ROUTES) {
      const op = doc.paths[r.path]?.[r.method];
      expect(op, `${r.method} ${r.path}`).to.not.eq(undefined);
      expect(op.tags, `${r.method} ${r.path}`).to.deep.eq(['Authz admin']);
      expect(op.summary, `${r.method} ${r.path}`).to.be.a('string').that.is.not.empty;
    }
    expect(Object.values(doc.paths).flatMap((p: any) => Object.keys(p))).to.have.length(ROUTES.length);
  });

  it('explains on the tag that the routes check authentication only', () => {
    const tag = doc.tags.find((t: any) => t.name === 'Authz admin');
    expect(tag.description).to.match(/authentication only/);
    expect(tag.description).to.match(/AuthzAdmin/);
  });

  it('documents 401 and 403 on every route, and 404 and 409 on every write', () => {
    for (const r of ROUTES) {
      const op = doc.paths[r.path][r.method];
      expect(op.responses, `${r.method} ${r.path}`).to.include.keys(['200', '400', '401', '403']);
      if (r.method !== 'get') expect(op.responses, `${r.method} ${r.path}`).to.include.keys(['404', '409']);
    }
    expect(doc.paths['/authz/commands'].post.responses['403'].content['application/json'].schema.$ref).to.eq('#/components/schemas/AuthzAdminError');
  });

  it('answers a write with { results } and a list with { items, total }', () => {
    expect(doc.paths['/authz/commands'].post.responses['200'].content['application/json'].schema.$ref).to.eq('#/components/schemas/AuthzAdminResults');
    expect(doc.paths['/authz/rules'].get.responses['200'].content['application/json'].schema.$ref).to.eq('#/components/schemas/AuthzAdminPage');
    const attributes = doc.paths['/authz/scopes/{type}/{id}/attributes'].get.responses;
    expect(attributes['200'].content['application/json'].schema.$ref).to.eq('#/components/schemas/AuthzAdminPage');
    expect(attributes, 'an unknown scope answers 200 with empty attributes').to.not.have.property('404');
    expect(doc.components.schemas.AuthzAdminResults.required).to.deep.eq(['results']);
    expect(doc.components.schemas.AuthzAdminPage.required).to.deep.eq(['items', 'total']);
    expect(doc.components.schemas.AuthzAdminError.properties.error.required).to.deep.eq(['code', 'message']);
  });

  it('lists all command kinds in the batch body', () => {
    const body = doc.paths['/authz/commands'].post.requestBody.content['application/json'].schema;
    expect(body.$ref).to.eq('#/components/schemas/AuthzAdminBatch');

    const batch = doc.components.schemas.AuthzAdminBatch;
    expect(batch.required).to.deep.eq(['commands']);
    expect(Object.keys(batch.properties)).to.include.members(['commands', 'reason', 'idempotencyKey', 'dryRun']);

    const kinds = batch.properties.commands.items.oneOf.flatMap((c: any) => c.properties.kind.enum);
    expect(kinds).to.have.members([...COMMAND_KINDS]);
    expect(kinds).to.have.length(19);
    expect(commandSchemas).to.have.length(19);
  });

  it('writes expiry dates as date-time strings', () => {
    const grant = doc.components.schemas.AuthzAdminBatch.properties.commands.items.oneOf.find((c: any) => c.properties.kind.enum[0] === 'assignment.grant');
    expect(grant.properties.expiresAt).to.include({ type: 'string', format: 'date-time' });
  });

  it('documents each request body as the DTO the route validates it against', () => {
    const bodyOf = (path: string, method: string) => doc.paths[path][method].requestBody?.content['application/json'].schema;
    for (const [path, method, dto] of [
      ['/authz/assignments', 'post', ASSIGNMENT_GRANT_SCHEMA],
      ['/authz/assignments/{id}', 'patch', ASSIGNMENT_PATCH_SCHEMA],
      ['/authz/links', 'post', LINK_CREATE_SCHEMA],
      ['/authz/links/{id}', 'patch', LINK_PATCH_SCHEMA],
      ['/authz/rules/{id}', 'put', RULE_BODY_SCHEMA],
      ['/authz/policies/{id}', 'put', POLICY_BODY_SCHEMA],
    ] as const) {
      const body = bodyOf(path, method);
      const expected = dto as unknown as { properties: object; required: string[]; description: string };
      expect(body, `${method} ${path}`).to.not.eq(undefined);
      expect(Object.keys(body.properties), `${method} ${path}`).to.have.members(Object.keys(expected.properties));
      expect(body.required ?? [], `${method} ${path}`).to.deep.eq(expected.required);
      expect(body.additionalProperties, `${method} ${path}`).to.eq(false);
      expect(body.description, `${method} ${path}`).to.eq(expected.description);
    }
    expect(bodyOf('/authz/scopes/{type}/{id}/attributes', 'patch')).to.deep.include({ type: 'object' });
    expect(bodyOf('/authz/scopes/{type}/{id}/attributes', 'patch').description).to.match(/deep merge/);
    expect(bodyOf('/authz/scopes/{type}/{id}/attributes', 'put').description).to.match(/replaces all/);
    expect(bodyOf('/authz/scopes/{type}/{id}/attributes', 'put')).to.not.have.property('$id');
    expect(bodyOf('/authz/assignments/{id}', 'delete')).to.eq(undefined);
    expect(bodyOf('/authz/assignments', 'get')).to.eq(undefined);
  });

  it('keeps the answer schemas as components and refers every answer to one of them', () => {
    for (const [name, schema] of Object.entries(AUTHZ_ADMIN_SCHEMAS)) expect(doc.components.schemas[name], name).to.deep.eq(schema);
    for (const r of ROUTES) {
      for (const [code, response] of Object.entries<any>(doc.paths[r.path][r.method].responses)) {
        const ref: string | undefined = response.content?.['application/json']?.schema?.$ref;
        if (ref !== undefined) expect(Object.keys(AUTHZ_ADMIN_SCHEMAS), `${r.method} ${r.path} ${code}`).to.include(ref.replace('#/components/schemas/', ''));
      }
    }
  });

  it('documents the query parameters with their encodings', () => {
    const query = (path: string, method: string) => Object.fromEntries(doc.paths[path][method].parameters.filter((p: any) => p.in === 'query').map((p: any) => [p.name, p]));
    expect(Object.keys(query('/authz/assignments', 'get'))).to.have.members(['scope', 'subject', 'role', 'includeExpired', 'limit', 'offset', 'after']);
    expect(query('/authz/assignments', 'get').scope.description).to.match(/<type>:<id>/);
    expect(query('/authz/assignments', 'get').subject.description).to.match(/set:<role>@<type>:<id>/);
    expect(Object.keys(query('/authz/rules/{id}', 'put'))).to.have.members(['reason', 'idempotencyKey', 'dryRun']);
    expect(query('/authz/rules/{id}', 'put').dryRun.schema.type).to.eq('boolean');
    const holders = query('/authz/holders', 'get');
    expect([holders.scope.required, holders.permission.required, holders.expandSets.required]).to.deep.eq([true, true, false]);
  });

  it('documents the after cursor on the keyset-paged lists and next in the page schema', () => {
    interface Described {
      readonly paths: Record<string, { get: { parameters: readonly { in: string; name: string }[] } }>;
      readonly components: { schemas: Record<string, { properties: Record<string, { type: string }>; required: readonly string[] }> };
    }
    const described = doc as Described;
    const query = (path: string) => described.paths[path].get.parameters.filter((p) => p.in === 'query').map((p) => p.name);
    for (const path of ['/authz/assignments', '/authz/holders', '/authz/links', '/authz/rules']) expect(query(path), path).to.include('after');
    expect(query('/authz/policies')).to.not.include('after');
    expect(described.components.schemas.AuthzAdminPage.properties.next.type).to.eq('string');
    expect(described.components.schemas.AuthzAdminPage.required).to.deep.eq(['items', 'total']);
  });

  it('documents a request body exactly on the routes that take one', () => {
    const withBody = ROUTES.filter((r) => doc.paths[r.path][r.method].requestBody !== undefined).map((r) => `${r.method} ${r.path}`);
    expect(withBody).to.have.members(['post /authz/commands', 'post /authz/assignments', 'patch /authz/assignments/{id}', 'post /authz/links', 'patch /authz/links/{id}', 'put /authz/rules/{id}', 'put /authz/policies/{id}', 'patch /authz/scopes/{type}/{id}/attributes', 'put /authz/scopes/{type}/{id}/attributes']);
  });

  it('documents the query and path parameters with the caps the routes enforce', () => {
    const query = (path: string, method: string) => Object.fromEntries(doc.paths[path][method].parameters.filter((p: any) => p.in === 'query').map((p: any) => [p.name, p]));
    const options = query('/authz/links', 'post');
    expect(options.reason.schema.maxLength).to.eq(512);
    expect(options.idempotencyKey.schema.maxLength).to.eq(128);
    expect(query('/authz/assignments', 'get').limit.schema).to.include({ type: 'integer', minimum: 0, maximum: 500 });
    expect(doc.paths['/authz/assignments/{id}'].delete.parameters.find((p: any) => p.in === 'path').schema.maxLength).to.eq(160);
  });

  it('documents the link routes: bodies, query, and the token shown once with no-store', () => {
    const bodyOf = (path: string, method: string) => doc.paths[path][method].requestBody?.content['application/json'].schema;
    const query = (path: string, method: string) => doc.paths[path][method].parameters.filter((p: any) => p.in === 'query').map((p: any) => p.name);
    expect(bodyOf('/authz/links', 'post').required).to.deep.eq(['scope', 'role']);
    expect(Object.keys(bodyOf('/authz/links/{id}', 'patch').properties)).to.have.members(['id', 'expiresAt', 'attributes', 'role', 'tags']);
    expect(bodyOf('/authz/links/{id}', 'delete')).to.eq(undefined);
    expect(query('/authz/links', 'get')).to.have.members(['scope', 'limit', 'offset', 'after']);
    for (const [path, method] of [
      ['/authz/links', 'post'],
      ['/authz/links/{id}', 'patch'],
      ['/authz/links/{id}', 'delete'],
    ])
      expect(query(path, method), `${method} ${path}`).to.have.members(['reason', 'idempotencyKey', 'dryRun']);
    expect(doc.paths['/authz/links'].get.responses['200'].content['application/json'].schema.$ref).to.eq('#/components/schemas/AuthzAdminPage');

    for (const [path, method] of [
      ['/authz/links', 'post'],
      ['/authz/commands', 'post'],
    ]) {
      const op = doc.paths[path][method];
      const text = `${op.summary} ${op.description}`;
      expect(text, `${method} ${path}`).to.match(/no-store/);
      expect(text, `${method} ${path}`).to.match(/shown once/);
    }
    expect(doc.paths['/authz/links'].get.description).to.match(/never (carries|holds) (a|the) token/);
  });

  it('names the 400 codes each route can answer', () => {
    const bad = (path: string, method: string): string => doc.paths[path][method].responses['400'].description;
    for (const r of ROUTES) {
      const text = bad(r.path, r.method);
      if (r.method === 'get') {
        expect(text, `${r.method} ${r.path}`).to.match(/invalid_query/);
        expect(text, `${r.method} ${r.path}`).to.not.match(/invalid_request/);
      } else if (r.path === '/authz/commands') {
        expect(text)
          .to.match(/invalid_request/)
          .and.to.match(/invalid_batch/);
        expect(text).to.not.match(/invalid_query/);
      } else {
        expect(text, `${r.method} ${r.path}`).to.match(/invalid_query/);
        expect(text, `${r.method} ${r.path}`).to.match(/invalid_batch/);
      }
    }
    const codes = doc.components.schemas.AuthzAdminError.description;
    for (const code of ['invalid_batch', 'invalid_command', 'invalid_query', 'invalid_request']) expect(codes).to.include(code);
  });

  it('describes the path parameters', () => {
    const params = doc.paths['/authz/scopes/{type}/{id}/attributes'].get.parameters.filter((p: any) => p.in === 'path');
    expect(params.map((p: any) => p.name)).to.have.members(['type', 'id']);
    for (const p of params) expect(p.description, p.name).to.be.a('string').that.is.not.empty;
  });
});
