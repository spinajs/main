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
  // NOTE: DataValidator.getSchema() returns the unwrapped schema object directly
  // (it internally unwraps ajv's `{ schema }` wrapper), so the fake must do the same.
  const fakeValidator = {
    getSchema: (id: string) =>
      id === REF_ID ? { type: 'object', properties: { ok: { type: 'boolean' } } } : undefined,
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

  /**
   * Runs last on purpose: it empties the container cache, which the tests above read from.
   *
   * `asMapValue` keeps its map in that cache, and the decorator that fills it runs exactly
   * once - when the module is first imported. Nothing re-imports a module, so before this was
   * fixed the FIRST `DI.clearCache()` after start-up destroyed the name → schema map for the
   * rest of the process and every lookup returned undefined from then on. Silently: a DTO
   * simply stopped resolving, and http-swagger degraded the reference to it into a bare
   * `{ type: 'object' }` with nothing anywhere reporting a problem.
   *
   * It bit for real. Two `swagger-responses` assertions in http-swagger passed when their
   * suite ran alone and failed in a full run - not because of anything either suite did, but
   * because whichever suite booted the controllers first was the only one that ever saw the
   * map, and adding an unrelated suite was enough to change which one that was.
   */
  describe('after DI.clearCache()', () => {
    before(() => {
      DI.clearCache();
    });

    it('still resolves an inline @Schema(object) - a decorator is not a cached service', () => {
      const schema = provider.getSchema(TestPaginationDto.name) as any;

      expect(schema, 'the DTO stopped resolving once the container cache was cleared').to.be.an('object');
      expect(schema.properties.page.type).to.equal('integer');
    });

    it('still resolves a @Schema(string) $ref', () => {
      const schema = provider.getSchema(TestRefDto.name) as any;

      expect(schema).to.be.an('object');
      expect(schema.properties.ok.type).to.equal('boolean');
    });

    it('still knows nothing about a name that was never decorated', () => {
      expect(provider.getSchema('NoSuchType')).to.equal(undefined);
    });
  });
});
