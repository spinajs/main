import 'mocha';

import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { AuthzConfigError } from '@spinajs/authz';

import { AUTHZ_ADMIN_SCHEMAS, AuthzAdminSchemaProvider, AuthzCommandSchemaRegistry, AuthzCommandSchemaSource, COMMAND_KINDS, commandSchemas, describeAuthzAdminDocument } from '../src/schemas/index.js';

const fakeSet = {
  type: 'object',
  description: 'Sets a value of the fake model',
  required: ['kind', 'scope', 'key', 'value'],
  properties: { kind: { type: 'string', enum: ['fake.set'] }, scope: { type: 'object' }, key: { type: 'string' }, value: { type: 'integer' } },
};

/** A third-party model's contribution. */
class FakeCommandSchemas extends AuthzCommandSchemaSource {
  schemas(): Readonly<Record<string, object>> {
    return { 'fake.set': fakeSet };
  }
}

/** Claims a kind a built-in source already describes. */
class ClashingCommandSchemas extends AuthzCommandSchemaSource {
  schemas(): Readonly<Record<string, object>> {
    return { 'scope.forget': { type: 'object', properties: { kind: { type: 'string', enum: ['scope.forget'] } } } };
  }
}

/** A schema that does not name the kind it is registered under. */
class MislabelledCommandSchemas extends AuthzCommandSchemaSource {
  schemas(): Readonly<Record<string, object>> {
    return { 'fake.get': fakeSet };
  }
}

type CommandSchema = { readonly properties: { readonly kind: { readonly enum: readonly string[] } } };
type BatchSchema = { readonly required: readonly string[]; readonly properties: { readonly commands: { readonly items: { readonly oneOf: readonly CommandSchema[] } } } };

const kindsOf = (batch: unknown): string[] => (batch as BatchSchema).properties.commands.items.oneOf.flatMap((c) => c.properties.kind.enum);

function registryWith(...sources: Class<AuthzCommandSchemaSource>[]): AuthzCommandSchemaRegistry {
  const child = DI.child();
  for (const s of sources) child.register(s).as(AuthzCommandSchemaSource);
  return new AuthzCommandSchemaRegistry(child);
}

describe('authz-http-admin command schema registry', () => {
  it('describes the built-in command kinds through the per-model sources', () => {
    const commands = registryWith().commands();
    expect(Object.keys(commands)).to.have.members([...COMMAND_KINDS]);
    expect(Object.keys(commands)).to.have.length(19);
    for (const schema of commandSchemas) {
      const kind = (schema as CommandSchema).properties.kind.enum[0];
      expect(commands[kind], kind).to.deep.equal(schema);
    }
  });

  it('adds the commands a third-party source registers', () => {
    const registry = registryWith(FakeCommandSchemas);
    expect(registry.commands()['fake.set']).to.deep.equal(fakeSet);
    expect(Object.keys(registry.commands())).to.have.length(20);

    const batch = registry.batch();
    expect(kindsOf(batch)).to.have.members([...COMMAND_KINDS, 'fake.set']);
    expect((batch as BatchSchema).required).to.deep.equal(['commands']);
    expect(Object.keys((batch as BatchSchema).properties)).to.have.members(['commands', 'reason', 'idempotencyKey', 'dryRun']);
    expect(batch).to.deep.equal({ ...AUTHZ_ADMIN_SCHEMAS.AuthzAdminBatch, properties: { ...(AUTHZ_ADMIN_SCHEMAS.AuthzAdminBatch as BatchSchema).properties, commands: { type: 'array', items: { oneOf: [...commandSchemas, fakeSet] } } } });
  });

  it('leaves the built-in schema set as it was', () => {
    registryWith(FakeCommandSchemas).batch();
    expect(kindsOf(AUTHZ_ADMIN_SCHEMAS.AuthzAdminBatch)).to.have.members([...COMMAND_KINDS]);
  });

  it('documents the registered commands in the OpenAPI batch body', () => {
    const doc = describeAuthzAdminDocument({ paths: {} } as { paths: object; components?: { schemas: Record<string, unknown> } }, { ...AUTHZ_ADMIN_SCHEMAS, AuthzAdminBatch: registryWith(FakeCommandSchemas).batch() });
    expect(kindsOf(doc.components?.schemas.AuthzAdminBatch)).to.include('fake.set');
  });

  it('refuses two sources that describe one kind', () => {
    expect(() => registryWith(ClashingCommandSchemas).commands())
      .to.throw(AuthzConfigError)
      .with.property('message')
      .that.matches(/scope\.forget/)
      .and.matches(/ClashingCommandSchemas/);
  });

  it('refuses a schema whose kind is not the kind it is registered under', () => {
    expect(() => registryWith(MislabelledCommandSchemas).commands())
      .to.throw(AuthzConfigError)
      .with.property('message')
      .that.matches(/fake\.get/);
  });

  it('serves the registered commands to http-swagger through AuthzAdminSchemaProvider', async () => {
    DI.register(FakeCommandSchemas).as(AuthzCommandSchemaSource);
    try {
      const provider = await DI.resolve(AuthzAdminSchemaProvider);
      expect(kindsOf(provider.getSchema('AuthzAdminBatch'))).to.include('fake.set');
      expect(Object.keys(provider.schemas())).to.have.members(Object.keys(AUTHZ_ADMIN_SCHEMAS));
      expect(provider.getSchema('AuthzAdminResults')).to.deep.equal(AUTHZ_ADMIN_SCHEMAS.AuthzAdminResults);
      expect(provider.getSchema('NoSuchSchema')).to.equal(undefined);
    } finally {
      DI.unregister(FakeCommandSchemas);
      DI.uncache(FakeCommandSchemas);
      DI.uncache(AuthzCommandSchemaSource);
    }
  });
});
