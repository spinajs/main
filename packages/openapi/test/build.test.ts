import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createConfig, lintFromString } from '@redocly/openapi-core';
import { PROBLEM_DETAILS_SCHEMA } from '@spinajs/http';
import type { Manifest } from '@spinajs/manifest';
import type { OpenAPIV3_1 } from 'openapi-types';
import { manifestToOpenApi } from '../src/index.js';
import { createComponentRegistry, slugify } from '../src/components.js';
import { openApiPath } from '../src/paths.js';
import { appBasicManifest } from './support/fixture.js';

const snapshotPath = fileURLToPath(new URL('./__snapshots__/app-basic.openapi.json', import.meta.url));
const options = { title: 'app-basic', version: '1.0.0', servers: [{ url: 'http://localhost:4557' }], errorSchema: PROBLEM_DETAILS_SCHEMA };

type Json = Record<string, unknown>;
const schemaOf = (response: unknown, type: string): Json => (response as { content: Record<string, { schema: Json }> }).content[type].schema;

describe('manifestToOpenApi', () => {
  let manifest: Manifest;
  let doc: OpenAPIV3_1.Document;

  before(async () => {
    manifest = await appBasicManifest();
    doc = manifestToOpenApi(manifest, options);
  });

  it('matches the committed snapshot', () => {
    const rendered = JSON.stringify(doc, null, 2);
    if (!existsSync(snapshotPath)) writeFileSync(snapshotPath, rendered);
    expect(rendered).to.equal(readFileSync(snapshotPath, 'utf8'));
  });

  it('is byte-equal across runs', () => {
    expect(JSON.stringify(manifestToOpenApi(manifest, options))).to.equal(JSON.stringify(doc));
  });

  it('is OpenAPI 3.1 and lints clean', async () => {
    expect(doc.openapi).to.equal('3.1.0');
    const config = await createConfig({ extends: ['minimal'] });
    const problems = await lintFromString({ source: JSON.stringify(doc), absoluteRef: 'app-basic.openapi.json', config });
    expect(problems.filter((p) => p.severity === 'error').map((p) => p.message)).to.deep.equal([]);
  });

  it('uses {id} path style and the ControllerName_handler operationId', () => {
    expect(openApiPath('/users/:id', '')).to.equal('/users/{id}');
    expect(openApiPath('/users/:id', '/api')).to.equal('/api/users/{id}');
    expect(doc.paths!['/users/{id}']!.get!.operationId).to.equal('Users_get');
    const idParam = doc.paths!['/users/{id}']!.get!.parameters!.find((p) => (p as { name: string }).name === 'id') as { in: string; required: boolean; schema: { type: string } };
    expect(idParam.in).to.equal('path');
    expect(idParam.required).to.equal(true);
    expect(idParam.schema.type).to.equal('number');
  });

  it('prefixes every path with basePath', () => {
    const prefixed = manifestToOpenApi(manifest, { ...options, basePath: '/api' });
    expect(Object.keys(prefixed.paths!)).to.deep.equal(['/api/health', '/api/users', '/api/users/{id}', '/api/users/{id}/avatar']);
  });

  it('turns a union return type into a union of component refs', () => {
    const schema = schemaOf(doc.paths!['/users']!.post!.responses['200'], 'application/json');
    expect((schema.anyOf as { $ref: string }[]).map((s) => s.$ref)).to.deep.equal(['#/components/schemas/UserDto', '#/components/schemas/ValidationProblem']);
  });

  it('keeps an array return inline over a component item', () => {
    const schema = schemaOf(doc.paths!['/users']!.get!.responses['200'], 'application/json');
    expect(schema).to.deep.equal({ type: 'array', items: { $ref: '#/components/schemas/UserDto' } });
  });

  it('copies @Access permissions into x-authz-permission and adds 401/403', () => {
    const op = doc.paths!['/users/{id}']!.get! as unknown as Json;
    expect(op['x-authz-permission']).to.deep.equal(['user:read']);
    expect(op['x-authz-resource']).to.deep.equal({ type: 'user' });
    expect(Object.keys(doc.paths!['/users/{id}']!.get!.responses)).to.include.members(['200', '401', '403']);
  });

  it('marks anonymous routes and leaves them without 401/403', () => {
    const op = doc.paths!['/health']!.get! as unknown as Json;
    expect(op['x-authz-anonymous']).to.equal(true);
    expect(op.security).to.deep.equal([]);
    expect(Object.keys(doc.paths!['/health']!.get!.responses)).to.deep.equal(['200']);
  });

  it('documents a file upload as multipart/form-data', () => {
    const body = doc.paths!['/users/{id}/avatar']!.post!.requestBody as { content: Record<string, { schema: { properties: Record<string, { format: string }> } }> };
    expect(Object.keys(body.content)).to.deep.equal(['multipart/form-data']);
    expect(body.content['multipart/form-data'].schema.properties.file.format).to.equal('binary');
    expect(Object.keys(doc.paths!['/users/{id}/avatar']!.post!.responses)).to.include('204');
  });

  it('documents a body parameter as application/json', () => {
    const body = doc.paths!['/users']!.post!.requestBody as { required: boolean; content: Record<string, { schema: Json }> };
    expect(body.required).to.equal(true);
    expect(body.content['application/json'].schema).to.deep.equal({ $ref: '#/components/schemas/CreateUserDto' });
  });

  it('maps the controller exception map to a problem+json response', () => {
    const resp = doc.paths!['/users/{id}']!.get!.responses['404'];
    expect(schemaOf(resp, 'application/problem+json')).to.deep.equal({ $ref: '#/components/schemas/ProblemDetails' });
    expect(doc.paths!['/health']!.get!.responses).to.not.have.property('404');
  });

  it('serialises query DTO properties as individual query parameters', () => {
    const params = doc.paths!['/users']!.get!.parameters as { name: string; in: string; required: boolean }[];
    expect(params.map((p) => [p.name, p.in, p.required])).to.deep.equal([
      ['page', 'query', false],
      ['perPage', 'query', false],
    ]);
  });

  it('slugifies manifest ids and disambiguates collisions', () => {
    expect(slugify('spinajs/app-basic/UserDto')).to.equal('UserDto');
    expect(doc.components!.schemas).to.have.keys(['CreateUserDto', 'HealthController_get_Response', 'ProblemDetails', 'UserDto', 'ValidationProblem']);

    const registry = createComponentRegistry({ 'spinajs/a/Item': { type: 'object' }, 'spinajs/b/Item': { type: 'object' } });
    expect(registry.ref('spinajs/a/Item')).to.equal('#/components/schemas/Item');
    expect(registry.ref('spinajs/b/Item')).to.equal('#/components/schemas/b_Item');
  });

  it('strips x-* keywords, $id and $schema from emitted schemas', () => {
    const registry = createComponentRegistry({ 'spinajs/a/T': { $id: 'spinajs/a/T', 'x-derived': true, type: 'object', properties: { p: { 'x-explicit': 'partial', type: 'string' } } } });
    registry.ref('spinajs/a/T');
    expect(registry.schemas()).to.deep.equal({ T: { type: 'object', properties: { p: { type: 'string' } } } });
  });

  it('keeps a property named like an x- keyword', () => {
    const registry = createComponentRegistry({ 'spinajs/a/T': { type: 'object', properties: { 'x-trace': { type: 'string' } } } });
    registry.ref('spinajs/a/T');
    expect(registry.schemas()).to.deep.equal({ T: { type: 'object', properties: { 'x-trace': { type: 'string' } } } });
  });

  it('resolves recursive refs once', () => {
    const registry = createComponentRegistry({ 'spinajs/a/Node': { type: 'object', properties: { next: { $ref: 'spinajs/a/Node' } } } });
    registry.ref('spinajs/a/Node');
    expect(registry.schemas()).to.deep.equal({ Node: { type: 'object', properties: { next: { $ref: '#/components/schemas/Node' } } } });
  });

  it('emits a response without content for a bare wrapper return', () => {
    const copy = structuredClone(manifest);
    copy.controllers[0].routes[0].returnType = { text: 'Ok' };
    const out = manifestToOpenApi(copy, options);
    expect(out.paths!['/health']!.get!.responses['200']).to.deep.equal({ description: 'Successful response' });
  });

  it('uses the manifest ProblemDetails schema over the option fallback', () => {
    const copy = structuredClone(manifest);
    copy.schemas['spinajs/http/ProblemDetails'] = { type: 'object', title: 'from manifest' };
    const out = manifestToOpenApi(copy, { ...options, errorSchema: undefined });
    expect(out.components!.schemas!.ProblemDetails).to.deep.equal({ type: 'object', title: 'from manifest' });
  });

  it('fails clearly when the error schema is unavailable', () => {
    expect(() => manifestToOpenApi(manifest, { ...options, errorSchema: undefined })).to.throw(/ProblemDetails/);
  });

  it('rejects a path parameter without a placeholder', () => {
    const copy = structuredClone(manifest);
    copy.controllers[1].routes[0].params.push({ index: 1, name: 'ghost', kind: 'FromParams', runtimeType: { text: 'string' }, required: true });
    expect(() => manifestToOpenApi(copy, options)).to.throw(/ghost/);
  });

  it('keeps the shape of the shared problem schema', () => {
    const problem = doc.components!.schemas!.ProblemDetails as Json;
    expect(problem.required).to.deep.equal(['type', 'title', 'status']);
    expect(problem).to.not.have.property('$id');
  });
});
