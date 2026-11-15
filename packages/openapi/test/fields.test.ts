import 'mocha';
import { expect } from 'chai';
import { createConfig, lintFromString } from '@redocly/openapi-core';
import { PROBLEM_DETAILS_SCHEMA } from '@spinajs/http';
import type { Manifest } from '@spinajs/manifest';
import { manifestToOpenApi } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';

type Json = Record<string, unknown>;
const options = { title: 'app-basic', version: '1.0.0', errorSchema: PROBLEM_DETAILS_SCHEMA };
const ok = (doc: unknown, path: string): Json => ((((doc as Json).paths as Json)[path] as Json).get as { responses: Record<string, { content: Record<string, { schema: Json }> }> }).responses['200'].content['application/json'].schema;

describe('manifestToOpenApi: field-filtered responses (G16)', () => {
  let manifest: Manifest;

  before(async () => {
    manifest = structuredClone(await appBasicManifest());
    const users = manifest.controllers.find((c) => c.className === 'UsersController')!;
    for (const route of users.routes.filter((r) => r.fullPath === '/users/:id' || r.fullPath === '/users/list')) {
      route.access ??= ['user:list'];
      route.middlewares.push({ type: 'AuthzFieldsMiddleware', options: [] });
    }
  });

  it("marks every property of the record optional with x-spina-fields: '<permission>'", () => {
    expect(ok(manifestToOpenApi(manifest, options), '/users/{id}')).to.deep.equal({
      type: 'object',
      properties: { id: { type: 'number', 'x-spina-fields': 'user:read' }, email: { type: 'string', 'x-spina-fields': 'user:read' }, name: { type: 'string', 'x-spina-fields': 'user:read' } },
      additionalProperties: false,
    });
  });

  it('marks the items of a list and leaves the shared component as it is', () => {
    const doc = manifestToOpenApi(manifest, options);
    const list = ok(doc, '/users/list');
    expect(list.type).to.equal('array');
    expect((list.items as Json).required).to.equal(undefined);
    expect(((list.items as Json).properties as Record<string, Json>).email['x-spina-fields']).to.equal('user:list');
    expect((doc.components!.schemas!.UserDto as Json).required).to.deep.equal(['id', 'email']);
  });

  it('lints clean', async () => {
    const config = await createConfig({ extends: ['minimal'] });
    const problems = await lintFromString({ source: JSON.stringify(manifestToOpenApi(manifest, options)), absoluteRef: 'x.openapi.json', config });
    expect(problems.filter((p) => p.severity === 'error').map((p) => p.message)).to.deep.equal([]);
  });
});
