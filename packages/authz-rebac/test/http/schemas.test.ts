import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { AuthzCommandSchemaRegistry, COMMAND_KINDS } from '@spinajs/authz-http-admin';

import { RebacCommandSchemas } from '../../src/http/index.js';

const expect = chai.expect;

describe('authz-rebac/http: command schemas', () => {
  it('describes tuple.write and tuple.delete with the tuple shape', () => {
    const schemas = new RebacCommandSchemas().schemas() as Record<string, { properties: Record<string, { enum?: string[]; oneOf?: unknown[] }>; required: string[] }>;
    expect(Object.keys(schemas).sort()).to.deep.equal(['tuple.delete', 'tuple.write']);
    for (const kind of ['tuple.write', 'tuple.delete']) {
      expect(schemas[kind].properties.kind.enum).to.deep.equal([kind]);
      expect(schemas[kind].required).to.include.members(['kind', 'tuple']);
    }
    const tuple = schemas['tuple.write'].properties.tuple as unknown as { required: string[]; properties: { subject: { oneOf: unknown[] } } };
    expect(tuple.required).to.have.members(['object', 'relation', 'subject']);
    expect(tuple.properties.subject.oneOf).to.have.length(2);
  });

  it('joins the registry next to the built-in sources', () => {
    const registry = DI.resolve(AuthzCommandSchemaRegistry);
    const kinds = Object.keys(registry.commands());
    expect(kinds).to.include.members([...COMMAND_KINDS, 'tuple.write', 'tuple.delete']);
    const batch = registry.batch() as { properties: { commands: { items: { oneOf: { properties: { kind: { enum: string[] } } }[] } } } };
    expect(batch.properties.commands.items.oneOf.map((s) => s.properties.kind.enum[0])).to.include('tuple.write');
  });
});
