import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Schema } from '@spinajs/validation';
import { OpenApiBuilder, ModelSchemaProvider, DtoSchemaProvider, resolveTypeSchema } from '../src/index.js';

const MODEL_DESCRIPTOR_SYMBOL = Symbol.for('MODEL_DESCRIPTOR');

// RelationType: One = 0, Many = 1, ManyToMany = 2
class TestUser {}
class TestTag {}
class TestPost {}

function defineDescriptor(cls: any, name: string, descriptor: any) {
  Reflect.defineMetadata(MODEL_DESCRIPTOR_SYMBOL, { [name]: descriptor }, cls);
}

// A `@Schema` DTO — self-registers under '__schemas__' at import.
@Schema({
  type: 'object',
  properties: { page: { type: 'integer' }, size: { type: 'integer' } },
  required: ['page'],
})
class TestPaginationDto {}

describe('Swagger schema generation', function () {
  let builder: any;

  before(() => {
    DI.clearCache();
    DI.setESMModuleSupport();

    defineDescriptor(TestUser, 'TestUser', {
      Schema: { type: 'object', properties: { id: { type: 'integer' }, email: { type: 'string' } }, required: ['email'] },
      Relations: new Map([['Posts', { Type: 1, TargetModel: { name: 'TestPost' } }]]), // Many → TestPost (cycle)
    });
    defineDescriptor(TestTag, 'TestTag', {
      Schema: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } },
    });
    defineDescriptor(TestPost, 'TestPost', {
      Schema: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' } }, required: ['title'] },
      Relations: new Map<string, any>([
        ['Author', { Type: 0, TargetModel: { name: 'TestUser' } }], // One → TestUser
        ['Tags', { Type: 2, TargetModel: { name: 'TestTag' } }], // ManyToMany → TestTag
      ]),
    });

    DI.register(TestUser).as('__models__');
    DI.register(TestTag).as('__models__');
    DI.register(TestPost).as('__models__');
  });

  beforeEach(() => {
    builder = new OpenApiBuilder({ title: 'Test', version: '1.0.0' } as any);
  });

  const expand = (s: any) => builder.expandNamedSchemas(s);
  const schemas = () => builder.document.components?.schemas ?? {};

  it('plain inline object → expanded as-is, no component registered', () => {
    const out = expand({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } });
    expect(out.type).to.equal('object');
    expect(out.properties.a.type).to.equal('string');
    expect(out.properties.b.type).to.equal('number');
    expect(out.$ref).to.equal(undefined);
    expect(schemas()).to.deep.equal({});
  });

  it('model name → component with its columns', () => {
    const out = expand({ type: 'object', description: 'TestUser' });

    expect(out).to.deep.equal({ $ref: '#/components/schemas/TestUser' });

    const user = schemas().TestUser;
    expect(user.type).to.equal('object');
    expect(user.properties.id.type).to.equal('integer');
    expect(user.properties.email.type).to.equal('string');
    expect(user.required).to.include('email');
  });

  it('model with relations → one = $ref, many = array of $ref, nested components registered', () => {
    const out = expand({ type: 'array', items: { type: 'object', description: 'TestPost' } });

    expect(out.type).to.equal('array');
    expect(out.items).to.deep.equal({ $ref: '#/components/schemas/TestPost' });

    const post = schemas().TestPost;
    expect(post.properties.title.type).to.equal('string');
    // to-one relation → single $ref
    expect(post.properties.Author).to.deep.equal({ $ref: '#/components/schemas/TestUser' });
    // to-many relation → array of $ref
    expect(post.properties.Tags.type).to.equal('array');
    expect(post.properties.Tags.items).to.deep.equal({ $ref: '#/components/schemas/TestTag' });
    // related models registered as their own components
    expect(Object.keys(schemas())).to.have.members(['TestPost', 'TestUser', 'TestTag']);
  });

  it('cyclic relations (post → user → post) collapse to a $ref, no infinite recursion', () => {
    expand({ type: 'object', description: 'TestPost' });

    const user = schemas().TestUser;
    expect(user.properties.Posts.type).to.equal('array');
    expect(user.properties.Posts.items).to.deep.equal({ $ref: '#/components/schemas/TestPost' });
  });

  it('@Schema registers the DTO class under __schemas__', () => {
    expect(DI.getRegisteredTypes('__schemas__')).to.include(TestPaginationDto);
  });

  it('@Schema DTO name → component built from its @Schema', () => {
    const out = expand({ type: 'object', description: 'TestPaginationDto' });

    expect(out).to.deep.equal({ $ref: '#/components/schemas/TestPaginationDto' });

    const dto = schemas().TestPaginationDto;
    expect(dto.type).to.equal('object');
    expect(dto.properties.page.type).to.equal('integer');
    expect(dto.properties.size.type).to.equal('integer');
    expect(dto.required).to.include('page');
  });

  it('resolveTypeSchema resolves models and DTOs, undefined for unknown names', () => {
    expect(resolveTypeSchema('TestUser')).to.be.an('object');
    expect(resolveTypeSchema('TestPaginationDto')).to.be.an('object');
    expect(resolveTypeSchema('NoSuchType')).to.equal(undefined);
  });

  it('providers resolve their own kind and ignore the other', () => {
    const model = new ModelSchemaProvider();
    const dto = new DtoSchemaProvider();

    expect(model.resolve('TestUser')).to.be.an('object');
    expect(model.resolve('TestPaginationDto')).to.equal(undefined);

    expect(dto.resolve('TestPaginationDto')).to.be.an('object');
    expect(dto.resolve('TestUser')).to.equal(undefined);
  });
});
