import 'mocha';
import { expect } from 'chai';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseFnParamNames } from '@spinajs/http';
import type { BaseController } from '@spinajs/http';
import { OpenApiBuilder } from '@spinajs/http-swagger';
import { DtoSchemaProvider } from '@spinajs/validation';

import { Security, UserMetadataController, Users } from '../../src/index.js';

const SNAPSHOT = resolve(process.cwd(), 'test', '__snapshots__', 'openapi-bodies.json');

/** The routes that take a DTO body, the DTO's required fields and one of its properties. */
const BODIES: Record<string, { required?: string[]; has: string }> = {
  Users_addUser: { required: ['Login', 'Email', 'Role'], has: 'Metadata' },
  Users_updateUser: { has: 'reauthPassword' },
  Security_banUser: { has: 'duration' },
  UserMetadataController_addMetadata: { required: ['Key', 'Type'], has: 'Value' },
  UserMetadataController_updateMetadata: { required: ['Key', 'Type'], has: 'Value' },
};

/**
 * The request bodies http-swagger documents for the users-http routes that take a `@Body()` DTO, built from the
 * controllers' route descriptors (no JSDoc needed). Rewrite the snapshot with `UPDATE_SNAPSHOTS=1`.
 */
describe('OpenAPI request bodies of the users-http DTO routes', () => {
  const operations = new Map<string, { path: string; method: string; op: any }>();

  before(() => {
    const builder = new OpenApiBuilder({ enabled: true, title: 'users-http', version: '1.0.0' } as never);
    (builder as unknown as { SchemaProviders: unknown[] }).SchemaProviders = [new DtoSchemaProvider()];
    for (const c of [Users, Security, UserMetadataController]) {
      const instance = new c() as BaseController;
      // What the Controllers scan does from the source; the runtime names are the same for these handlers.
      for (const [name, route] of instance.Descriptor.Routes) {
        const names = parseFnParamNames((instance as unknown as Record<string, (...args: unknown[]) => unknown>)[name as string]);
        for (const [index, param] of route.Parameters) if (names[index]) param.Name = names[index];
      }
      builder.addController({ name: c.name, instance } as never, { className: c.name, methods: {} } as never);
    }
    const doc = builder.build() as { paths: Record<string, Record<string, any>> };
    for (const [path, item] of Object.entries(doc.paths)) for (const [method, op] of Object.entries(item)) operations.set(op.operationId, { path, method, op });
  });

  it('keeps the operationId <Class>_<method>', () => {
    for (const id of Object.keys(BODIES)) expect(operations.has(id), id).to.eq(true);
    for (const id of operations.keys()) expect(id).to.match(/^(Users|Security|UserMetadataController)_[A-Za-z]+$/);
  });

  it('documents the DTO of every route that takes one as its JSON body', () => {
    for (const [id, want] of Object.entries(BODIES)) {
      const schema = operations.get(id)!.op.requestBody?.content?.['application/json']?.schema;
      expect(schema?.properties, id).to.have.property(want.has);
      if (want.required) expect(schema.required, id).to.deep.eq(want.required);
    }
  });

  it('matches the committed snapshot', () => {
    // Through JSON, as the document is served: keys whose value is undefined drop out.
    const actual = JSON.parse(JSON.stringify(Object.fromEntries(
      [...operations.entries()]
        .filter(([, o]) => o.op.requestBody)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, o]) => [id, { route: `${o.method.toUpperCase()} ${o.path}`, requestBody: o.op.requestBody }]),
    ))) as unknown;
    if (process.env.UPDATE_SNAPSHOTS) {
      mkdirSync(dirname(SNAPSHOT), { recursive: true });
      writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(existsSync(SNAPSHOT), 'snapshot file is missing; run with UPDATE_SNAPSHOTS=1').to.eq(true);
    expect(actual).to.deep.eq(JSON.parse(readFileSync(SNAPSHOT, 'utf8')));
  });
});
