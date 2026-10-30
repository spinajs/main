import 'mocha';
import { expect } from 'chai';
import { createConfig, lintFromString } from '@redocly/openapi-core';
import { PROBLEM_DETAILS_SCHEMA } from '@spinajs/http';
import type { Manifest } from '@spinajs/manifest';
import { manifestToOpenApi } from '../src/index.js';
import { createComponentRegistry } from '../src/components.js';
import { validateRefs } from '../src/refs.js';
import { appBasicManifest } from './support/fixture.js';

const options = { title: 'app-basic', version: '1.0.0', errorSchema: PROBLEM_DETAILS_SCHEMA };
type Json = Record<string, unknown>;

const lint = async (document: unknown): Promise<string[]> => {
  const config = await createConfig({ extends: ['minimal'] });
  const problems = await lintFromString({ source: JSON.stringify(document), absoluteRef: 'x.openapi.json', config });
  return problems.filter((p) => p.severity === 'error').map((p) => p.message);
};

describe('manifestToOpenApi fix round 1', () => {
  let manifest: Manifest;
  const routeOf = (m: Manifest, path: string) => m.controllers.flatMap((c) => c.routes).find((r) => r.fullPath === path)!;
  const withSchemas = (schemas: Record<string, unknown>, returnId: string): Manifest => {
    const copy = structuredClone(manifest);
    Object.assign(copy.schemas, schemas);
    routeOf(copy, '/users/:id').returnType = { text: 'X', schema: returnId };
    return copy;
  };

  before(async () => {
    manifest = await appBasicManifest();
  });

  it('falls back to the built-in problem+json schema without options and equals the http one', () => {
    const out = manifestToOpenApi(manifest, { title: 't', version: '1' });
    const reference = createComponentRegistry({ 'spinajs/http/ProblemDetails': PROBLEM_DETAILS_SCHEMA });
    reference.ref('spinajs/http/ProblemDetails');
    expect(out.components!.schemas!.ProblemDetails).to.deep.equal(reference.schemas().ProblemDetails);
  });

  it('prefers the errorSchema option over the built-in schema', () => {
    const out = manifestToOpenApi(manifest, { title: 't', version: '1', errorSchema: { type: 'object', title: 'custom' } });
    expect(out.components!.schemas!.ProblemDetails).to.deep.equal({ type: 'object', title: 'custom' });
  });

  it('turns draft-07 tuples into prefixItems', async () => {
    const m = withSchemas(
      {
        'spinajs/t/Closed': { type: 'object', properties: { p: { type: 'array', items: [{ type: 'string' }, { type: 'number' }], additionalItems: false } } },
        'spinajs/t/Open': { type: 'array', items: [{ type: 'string' }], additionalItems: { type: 'number' } },
      },
      'spinajs/t/Closed',
    );
    routeOf(m, '/users/:id').params.push({ index: 5, name: 'q', kind: 'FromBody', runtimeType: { text: 'X', schema: 'spinajs/t/Open' }, required: true, wire: { in: 'body', shape: 'whole' } });
    const out = manifestToOpenApi(m, options);
    const closed = out.components!.schemas!.Closed as Json;
    expect((closed.properties as Json).p).to.deep.equal({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }], items: false });
    const text = JSON.stringify(out);
    expect(text).to.not.include('additionalItems').and.not.include('"items":[');
    expect(text).to.include('"prefixItems":[{"type":"string"}],"items":{"type":"number"}');
    expect(await lint(out)).to.deep.equal([]);
  });

  it('hoists $defs into components so local refs resolve', () => {
    const m = withSchemas({ 'spinajs/t/D': { type: 'object', properties: { a: { $ref: '#/$defs/Inner' } }, $defs: { Inner: { type: 'object', properties: { b: { type: 'string' } } } } } }, 'spinajs/t/D');
    const out = manifestToOpenApi(m, options);
    const a = ((out.components!.schemas!.D as Json).properties as Json).a as { $ref: string };
    expect(a.$ref).to.match(/^#\/components\/schemas\//);
    expect(out.components!.schemas).to.have.property(a.$ref.split('/').pop()!);
    expect(JSON.stringify(out)).to.not.include('$defs');
  });

  it('throws naming an unresolvable $ref and where it appeared', () => {
    const m = withSchemas({ 'spinajs/t/Bad': { type: 'object', properties: { a: { $ref: '#/definitions/Nope' } } } }, 'spinajs/t/Bad');
    expect(() => manifestToOpenApi(m, options)).to.throw(/#\/definitions\/Nope[\s\S]*spinajs\/t\/Bad/);
  });

  it('does not resolve $ref against prototype keys', () => {
    const m = withSchemas({ 'spinajs/t/Proto': { type: 'object', properties: { a: { $ref: 'toString' } } } }, 'spinajs/t/Proto');
    expect(() => manifestToOpenApi(m, options)).to.throw(/toString/);
  });

  it('validateRefs reports a dangling ref with its location', () => {
    const bad = { paths: { '/a': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Missing' } } } } } } } }, components: { schemas: {} } };
    expect(() => validateRefs(bad)).to.throw(/Missing[\s\S]*\/a/);
  });

  it('leaves enum, const and default values untouched', () => {
    const registry = createComponentRegistry({ 'spinajs/a/T': { type: 'object', default: { 'x-a': 1, $ref: 'y' }, properties: { e: { enum: [{ 'x-b': 1 }] } } } });
    registry.ref('spinajs/a/T');
    expect(registry.schemas()).to.deep.equal({ T: { type: 'object', default: { 'x-a': 1, $ref: 'y' }, properties: { e: { enum: [{ 'x-b': 1 }] } } } });
  });

  it('lets a route-level @Access win over an anonymous controller', () => {
    const m = structuredClone(manifest);
    const route = routeOf(m, '/users/:id');
    m.controllers.find((c) => c.routes.includes(route) || c.routes.some((r) => r.fullPath === route.fullPath))!.allowAnonymous = true;
    route.access = ['user:read'];
    delete route.allowAnonymous;
    const op = manifestToOpenApi(m, options).paths!['/users/{id}']!.get! as unknown as Json;
    expect(op['x-authz-permission']).to.deep.equal(['user:read']);
    expect(op).to.not.have.property('x-authz-anonymous');
  });

  it('still applies an anonymous controller to routes without access', () => {
    const m = structuredClone(manifest);
    const route = routeOf(m, '/users/:id');
    m.controllers.find((c) => c.routes.some((r) => r.fullPath === route.fullPath))!.allowAnonymous = true;
    delete route.access;
    delete route.allowAnonymous;
    const op = manifestToOpenApi(m, options).paths!['/users/{id}']!.get! as unknown as Json;
    expect(op['x-authz-anonymous']).to.equal(true);
  });

  it('types file responses and raw bodies as binary', () => {
    const m = structuredClone(manifest);
    const upload = routeOf(m, '/users/:id/avatar');
    const owner = m.controllers.find((c) => c.routes.some((r) => r.fullPath === upload.fullPath))!;
    const download = structuredClone(upload);
    download.method = 'file';
    download.fullPath = '/users/:id/avatar.bin';
    download.params = [];
    download.handler = 'download';
    download.returnType = { text: 'Buffer' };
    owner.routes.push(download);
    upload.params = [...upload.params.filter((p) => p.kind !== 'FromFile'), { index: 9, name: 'raw', kind: 'RawBodyRouteArgs', runtimeType: { text: 'Buffer' }, required: true, wire: { in: 'body', shape: 'whole' } }];
    const out = manifestToOpenApi(m, options);
    expect(out.paths!['/users/{id}/avatar.bin']!.get!.responses['200']).to.deep.equal({ description: 'Successful response', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } });
    const body = out.paths!['/users/{id}/avatar']!.post!.requestBody as unknown as { content: Record<string, { schema: Json }> };
    expect(body.content).to.deep.equal({ 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } });
  });

  it('rejects a file route that collides with a get on the same path', () => {
    const m = structuredClone(manifest);
    const get = routeOf(m, '/users/:id');
    const owner = m.controllers.find((c) => c.routes.some((r) => r.fullPath === get.fullPath))!;
    const clash = structuredClone(get);
    clash.method = 'file';
    clash.handler = 'clash';
    owner.routes.push(clash);
    expect(() => manifestToOpenApi(m, options)).to.throw(/GET[\s\S]*\/users\/\{id\}/);
  });

  it('declares route tags at the top level', () => {
    const m = structuredClone(manifest);
    routeOf(m, '/users/list').doc = { tags: ['extra'] };
    expect(manifestToOpenApi(m, options).tags!.map((t) => t.name)).to.include('extra');
  });
});

describe('top-level security', () => {
  let manifest: Manifest;
  const schemes = { cookieAuth: { type: 'apiKey', in: 'cookie', name: 'ssid' }, other: { type: 'http', scheme: 'bearer' } } as const;

  before(async () => {
    manifest = await appBasicManifest();
  });

  it('requires the first security scheme document-wide; anonymous operations keep security: []', () => {
    const out = manifestToOpenApi(manifest, { title: 't', version: '1', securitySchemes: { ...schemes } });
    expect(out.security).to.deep.equal([{ cookieAuth: [] }]);
    expect(out.paths!['/health/get']!.get!.security).to.deep.equal([]);
  });

  it('takes an explicit security requirement over the derived one', () => {
    const out = manifestToOpenApi(manifest, { title: 't', version: '1', securitySchemes: { ...schemes }, security: [{ other: [] }] });
    expect(out.security).to.deep.equal([{ other: [] }]);
  });

  it('emits no top-level security without schemes', () => {
    expect(manifestToOpenApi(manifest, { title: 't', version: '1' })).to.not.have.property('security');
  });
});
