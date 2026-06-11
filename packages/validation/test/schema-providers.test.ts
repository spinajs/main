import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Schema, DtoSchemaProvider } from '../src/index.js';

const REF_ID = 'http://test/ref.schema.json';

// `@Schema(object)` stores the schema object in the '__schemas__' map by class name.
@Schema({
  type: 'object',
  properties: { page: { type: 'integer' }, size: { type: 'integer' } },
  required: ['page'],
})
class TestPaginationDto {}

// `@Schema(string)` stores a `{ $ref }` that is resolved through the validator.
@Schema(REF_ID)
class TestRefDto {}

describe('DtoSchemaProvider', function () {
  let provider: DtoSchemaProvider;

  // Stub for the autoinjected DataValidator so the $ref lookup needs no AJV bootstrap.
  const fakeValidator = {
    getSchema: (id: string) =>
      id === REF_ID ? { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } : undefined,
  };

  before(() => {
    // NOTE: don't clearCache here — `@Schema` populates the '__schemas__' map in the
    // container cache at import time, and clearing it would wipe those registrations.
    DI.setESMModuleSupport();

    provider = new DtoSchemaProvider();
    (provider as any).Validator = fakeValidator;
  });

  it('@Schema registers the DTO under the __schemas__ map keyed by class name', () => {
    const map = DI.get<Map<string, any>>('__schemas__');
    expect(map?.get(TestPaginationDto.name)).to.be.an('object');
  });

  it('resolves an inline @Schema(object) by class name', () => {
    const schema = provider.getSchema(TestPaginationDto.name) as any;

    expect(schema.type).to.equal('object');
    expect(schema.properties.page.type).to.equal('integer');
    expect(schema.properties.size.type).to.equal('integer');
    expect(schema.required).to.include('page');
  });

  it('resolves a @Schema(string) $ref through the validator', () => {
    const schema = provider.getSchema(TestRefDto.name) as any;

    expect(schema.type).to.equal('object');
    expect(schema.properties.ok.type).to.equal('boolean');
  });

  it('returns undefined for names it does not recognise', () => {
    expect(provider.getSchema('NoSuchType')).to.equal(undefined);
  });
});
