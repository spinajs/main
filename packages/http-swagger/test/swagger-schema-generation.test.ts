import 'mocha';
import { expect } from 'chai';
import { SchemaProvider } from '@spinajs/validation';
import { OpenApiBuilder } from '../src/index.js';

// RelationType: One = 0, Many = 1, ManyToMany = 2
//
// A fake provider stands in for the real `ModelSchemaProvider` (@spinajs/orm) and
// `DtoSchemaProvider` (@spinajs/validation) so these builder tests stay decoupled
// from those packages. It returns the raw schema shape providers produce: relations
// are emitted as `{ type: 'object', description }` refs that the builder later
// expands into `$ref` components.
const SCHEMAS: Record<string, any> = {
  TestUser: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      email: { type: 'string' },
      Posts: { type: 'array', items: { type: 'object', description: 'TestPost' } }, // Many → TestPost (cycle)
    },
    required: ['email'],
  },
  TestTag: {
    type: 'object',
    properties: { id: { type: 'integer' }, name: { type: 'string' } },
  },
  TestPost: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      title: { type: 'string' },
      Author: { type: 'object', description: 'TestUser' }, // One → TestUser
      Tags: { type: 'array', items: { type: 'object', description: 'TestTag' } }, // ManyToMany → TestTag
    },
    required: ['title'],
  },
  TestPaginationDto: {
    type: 'object',
    properties: { page: { type: 'integer' }, size: { type: 'integer' } },
    required: ['page'],
  },
};

class FakeSchemaProvider extends SchemaProvider {
  public getSchema(typeName: string): Record<string, unknown> | undefined {
    return SCHEMAS[typeName];
  }
}

describe('Swagger schema generation', function () {
  let builder: any;

  beforeEach(() => {
    builder = new OpenApiBuilder({ title: 'Test', version: '1.0.0' } as any);
    // The builder discovers providers through the `@Autoinject(SchemaProvider)`
    // `SchemaProviders` field; inject the fake directly since we construct it by hand.
    builder.SchemaProviders = [new FakeSchemaProvider()];
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

  it('named DTO schema → component', () => {
    const out = expand({ type: 'object', description: 'TestPaginationDto' });

    expect(out).to.deep.equal({ $ref: '#/components/schemas/TestPaginationDto' });

    const dto = schemas().TestPaginationDto;
    expect(dto.type).to.equal('object');
    expect(dto.properties.page.type).to.equal('integer');
    expect(dto.properties.size.type).to.equal('integer');
    expect(dto.required).to.include('page');
  });
});
