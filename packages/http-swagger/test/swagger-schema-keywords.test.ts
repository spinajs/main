import 'mocha';
import { expect } from 'chai';
import { DtoSchemaProvider, Schema, SchemaProvider } from '@spinajs/validation';
import { IOpenApiDocument, IOpenApiSchema, ISwaggerConfig, OpenApiBuilder } from '../src/index.js';

/** The private members these tests drive, as the builder has them. */
interface BuilderInternals {
  document: IOpenApiDocument;
  SchemaProviders: SchemaProvider[];
  expandNamedSchemas(schema: IOpenApiSchema, kind?: 'request' | 'response'): IOpenApiSchema;
  convertJsonSchema(schema: object): IOpenApiSchema;
}

type Schemas = Record<string, IOpenApiSchema & { properties: Record<string, IOpenApiSchema> }>;

const FILE_SCHEMAS: Record<string, object> = {
  'files.Address': { $id: 'files.Address', type: 'object', properties: { city: { type: 'string' } } },
  'urn:files/Street#v1': { $id: 'urn:files/Street#v1', type: 'string', description: 'street' },
  'files/Zip': { $id: 'files/Zip', type: 'integer' },
  files_Zip: { $id: 'files_Zip', type: 'string', pattern: '^[0-9]{5}$' },
};

/**
 * Keywords of an ajv schema that OpenAPI 3.0 spells differently or not at all: `$data`, a `$ref`
 * to another schema's `$id`, and `default`, as a `@Schema` DTO carries them.
 */
describe('Swagger schema keywords of @Schema DTOs', function () {
  let builder: BuilderInternals;

  const schemas = () => (builder.document.components?.schemas ?? {}) as Schemas;
  const response = (name: string) => builder.expandNamedSchemas({ type: 'object', description: name }, 'response');

  // Declared here, not at import: another suite's DI.clearCache() empties the '__schemas__' map the decorator fills.
  before(() => {
    Schema({
      type: 'object',
      properties: {
        from: { type: 'integer' },
        to: { type: 'integer', minimum: { $data: '1/from' }, maximum: 100 },
        tags: { type: 'array', items: { type: 'string', enum: { $data: '/allowed' } } },
      },
    })(class KeywordsRangeDto {});

    Schema({
      $id: 'keywords.LogEntry',
      type: 'object',
      required: ['at'],
      properties: { at: { type: 'string', format: 'date-time' }, text: { type: 'string' } },
    })(class KeywordsLogEntryDto {});

    Schema({
      type: 'object',
      properties: {
        items: { type: 'array', items: { $ref: 'keywords.LogEntry' } },
        latest: { $ref: 'keywords.LogEntry' },
      },
    })(class KeywordsLogResponseDto {});

    Schema({
      type: 'object',
      properties: {
        page: { type: 'integer', minimum: 1, default: 1 },
        order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
        live: { type: 'boolean', default: false },
      },
    })(class KeywordsLogQueryDto {});
  });

  beforeEach(() => {
    const config: ISwaggerConfig = { enabled: true, title: 'Test', version: '1.0.0' };
    builder = new OpenApiBuilder(config) as unknown as BuilderInternals;
    builder.SchemaProviders = [new DtoSchemaProvider()];
    // What DataValidator.getSchema answers for schemas loaded from files.
    Object.defineProperty(builder, 'Validator', { value: { getSchema: (id: string) => (Object.hasOwn(FILE_SCHEMAS, id) ? structuredClone(FILE_SCHEMAS[id]) : undefined) } });
  });

  const convert = (schema: object) => builder.expandNamedSchemas(builder.convertJsonSchema(schema));
  const KEY = /^[a-zA-Z0-9.\-_]+$/;

  it('does not emit $data', () => {
    response('KeywordsRangeDto');

    const range = schemas().KeywordsRangeDto;
    expect(JSON.stringify(range)).to.not.contain('$data');
    expect(range.properties.to).to.deep.equal({ type: 'integer', maximum: 100 });
    expect(range.properties.tags.items).to.deep.equal({ type: 'string' });
  });

  it('resolves a $ref by $id to the component of the class that declares that $id', () => {
    response('KeywordsLogResponseDto');

    const list = schemas().KeywordsLogResponseDto;
    expect(list.properties.items).to.deep.equal({ type: 'array', items: { $ref: '#/components/schemas/KeywordsLogEntryDto' } });
    expect(list.properties.latest).to.deep.equal({ $ref: '#/components/schemas/KeywordsLogEntryDto' });
    expect(schemas().KeywordsLogEntryDto).to.deep.equal({
      type: 'object',
      required: ['at'],
      properties: { at: { type: 'string', format: 'date-time' }, text: { type: 'string' } },
    });
  });

  it('resolves a $ref by $id that only the validator knows, under a component named by the $id', () => {
    const out = convert({ type: 'object', properties: { home: { $ref: 'files.Address' } } });

    expect(out.properties?.home).to.deep.equal({ $ref: '#/components/schemas/files.Address' });
    expect(schemas()['files.Address']).to.deep.equal({ type: 'object', properties: { city: { type: 'string' } } });
  });

  it('names the component of an $id with /, : and # by a valid key the $ref points to', () => {
    const out = convert({ $ref: 'urn:files/Street#v1' });

    const key = Object.keys(schemas()).find((k) => k.startsWith('urn_files_Street_v1'));
    expect(key).to.be.a('string');
    if (typeof key !== 'string') return;
    expect(key).to.match(KEY);
    expect(key).to.not.equal('urn_files_Street_v1');
    expect(key).to.match(/^urn_files_Street_v1-[0-9a-f]{8}$/);
    expect(out).to.deep.equal({ $ref: `#/components/schemas/${key}` });
    expect(schemas()[key]).to.deep.equal({ type: 'string', description: 'street' });
  });

  it('gives two $ids that differ only in characters a key cannot hold a component each', () => {
    const slash = convert({ $ref: 'files/Zip' });
    const underscore = convert({ $ref: 'files_Zip' });

    expect(slash.$ref).to.not.equal(underscore.$ref);
    expect(underscore).to.deep.equal({ $ref: '#/components/schemas/files_Zip' });
    expect(schemas().files_Zip).to.deep.equal({ type: 'string', pattern: '^[0-9]{5}$' });
    const slashKey = slash.$ref?.split('/').pop();
    expect(slashKey).to.be.a('string');
    if (typeof slashKey !== 'string') return;
    expect(schemas()[slashKey]).to.deep.equal({ type: 'integer' });
  });

  it('keeps the sibling keywords of a $ref nothing knows', () => {
    expect(convert({ $ref: 'nobody.Knows', type: 'object', description: 'opaque' })).to.deep.equal({ type: 'object', description: 'opaque' });
  });

  it('keeps a default or example that only looks like a $data reference', () => {
    const out = convert({ type: 'object', default: { $data: 'not/a/pointer' }, example: { $data: 'literal' }, minLength: { $data: '1/min' } });

    expect(out).to.deep.equal({ type: 'object', default: { $data: 'not/a/pointer' }, example: { $data: 'literal' } });
  });

  it('keeps default in a component', () => {
    response('KeywordsLogQueryDto');

    const query = schemas().KeywordsLogQueryDto;
    expect(query.properties.page).to.deep.equal({ type: 'integer', minimum: 1, default: 1 });
    expect(query.properties.order.default).to.equal('desc');
    expect(query.properties.live.default).to.equal(false);
  });
});
