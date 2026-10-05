import 'mocha';
import { resolve } from 'node:path';

import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Controllers } from '@spinajs/http';
import { OpenApiBuilder, SwaggerDocCache } from '@spinajs/http-swagger';
import type { IOpenApiDocument } from '@spinajs/http-swagger';

import { AuthzAdminController } from '../src/controllers/index.js';
import { AUTHZ_ADMIN_ROUTES, AUTHZ_ADMIN_SCHEMAS, COMMAND_KINDS, commandSchemas, describeAuthzAdminDocument } from '../src/schemas/index.js';
import { startApp, stopApp } from './support/app.js';

// The controller's JSDoc is read from the compiled declaration file (`pretest` compiles it).
const COMPILED = resolve(process.cwd(), 'lib', 'mjs', 'controllers', 'AuthzAdminController.js');

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
    for (const r of AUTHZ_ADMIN_ROUTES) {
      const op = doc.paths[r.path]?.[r.method];
      expect(op, `${r.method} ${r.path}`).to.not.eq(undefined);
      expect(op.tags, `${r.method} ${r.path}`).to.deep.eq(['Authz admin']);
      expect(op.summary, `${r.method} ${r.path}`).to.be.a('string').that.is.not.empty;
    }
    expect(Object.values(doc.paths).flatMap((p: any) => Object.keys(p))).to.have.length(AUTHZ_ADMIN_ROUTES.length);
  });

  it('explains on the tag that the routes check authentication only', () => {
    const tag = doc.tags.find((t: any) => t.name === 'Authz admin');
    expect(tag.description).to.match(/authentication only/);
    expect(tag.description).to.match(/AuthzAdmin/);
  });

  it('documents 401 and 403 on every route, and 404 and 409 on every write', () => {
    for (const r of AUTHZ_ADMIN_ROUTES) {
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

  it('documents the per-route bodies', () => {
    const bodyOf = (path: string, method: string) => doc.paths[path][method].requestBody?.content['application/json'].schema.$ref;
    expect(bodyOf('/authz/assignments', 'post')).to.eq('#/components/schemas/AuthzAssignmentGrant');
    expect(bodyOf('/authz/assignments/{id}', 'patch')).to.eq('#/components/schemas/AuthzAssignmentPatch');
    expect(bodyOf('/authz/rules/{id}', 'put')).to.eq('#/components/schemas/AuthzRuleBody');
    expect(bodyOf('/authz/policies/{id}', 'put')).to.eq('#/components/schemas/AuthzPolicyBody');
    expect(bodyOf('/authz/scopes/{type}/{id}/attributes', 'patch')).to.eq('#/components/schemas/AuthzAttributesPatch');
    expect(bodyOf('/authz/scopes/{type}/{id}/attributes', 'put')).to.eq('#/components/schemas/AuthzAttributesBody');
    expect(bodyOf('/authz/assignments/{id}', 'delete')).to.eq(undefined);
    for (const name of Object.keys(AUTHZ_ADMIN_SCHEMAS)) expect(doc.components.schemas, name).to.have.property(name);
  });

  it('documents the query parameters with their encodings', () => {
    const query = (path: string, method: string) => Object.fromEntries(doc.paths[path][method].parameters.filter((p: any) => p.in === 'query').map((p: any) => [p.name, p]));
    expect(Object.keys(query('/authz/assignments', 'get'))).to.have.members(['scope', 'subject', 'role', 'includeExpired', 'limit', 'offset']);
    expect(query('/authz/assignments', 'get').scope.description).to.match(/<type>:<id>/);
    expect(query('/authz/assignments', 'get').subject.description).to.match(/set:<role>@<type>:<id>/);
    expect(Object.keys(query('/authz/rules/{id}', 'put'))).to.have.members(['reason', 'idempotencyKey', 'dryRun']);
    expect(query('/authz/rules/{id}', 'put').dryRun.schema.type).to.eq('boolean');
  });

  it('describes the path parameters', () => {
    const params = doc.paths['/authz/scopes/{type}/{id}/attributes'].get.parameters.filter((p: any) => p.in === 'path');
    expect(params.map((p: any) => p.name)).to.have.members(['type', 'id']);
    for (const p of params) expect(p.description, p.name).to.be.a('string').that.is.not.empty;
  });
});
