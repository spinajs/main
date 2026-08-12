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
  /**
   * A model whose timestamps come from @CreatedAt() / @UpdatedAt() / @Archived(). @spinajs/orm's
   * `columnToSchema` hands those over as `format: date-time` whatever the storage type is, and
   * `description` here is the column's DB COMMENT - deliberately spelled like a model name,
   * because that is the collision that used to swallow the property whole.
   */
  TestAudited: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time', description: 'TestUser' },
      archived_at: { type: 'string', format: 'date-time', nullable: true },
      birthday: { type: 'string', format: 'date' },
      history: { type: 'array', items: { type: 'string', format: 'date-time' } },
      Author: { type: 'object', description: 'TestUser' },
    },
    required: ['created_at'],
  },
};

class FakeSchemaProvider extends SchemaProvider {
  public getSchema(typeName: string): Record<string, unknown> | undefined {
    return SCHEMAS[typeName];
  }
}

// What the ORM's ModelSchemaProvider returns for a RESPONSE: columns straight from the
// database - nullable, no maxLength copied from the column width, and NO "required" (a
// response is partial). The write contract (@Schema, SCHEMAS above) stays on getSchema.
const RESPONSE_SCHEMAS: Record<string, any> = {
  TestUser: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      email: { type: 'string' },
      nick: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      Posts: { type: 'array', items: { type: 'object', description: 'TestPost' } },
    },
  },
  TestPost: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      title: { type: 'string' },
      Author: { type: 'object', description: 'TestUser' },
    },
  },
  // Same columns as the write contract, minus `required` - a response is partial.
  TestAudited: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time', description: 'TestUser' },
      archived_at: { type: 'string', format: 'date-time', nullable: true },
      birthday: { type: 'string', format: 'date' },
      history: { type: 'array', items: { type: 'string', format: 'date-time' } },
      Author: { type: 'object', description: 'TestUser' },
    },
  },
};

// Stands in for @spinajs/orm's ModelSchemaProvider - knows both flavours.
class FakeModelSchemaProvider extends SchemaProvider {
  public getSchema(typeName: string): Record<string, unknown> | undefined {
    return SCHEMAS[typeName];
  }

  public getResponseSchema(typeName: string): Record<string, unknown> | undefined {
    return RESPONSE_SCHEMAS[typeName];
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

// An ORM model carries TWO contracts: @Schema describes what may be SENT, while the
// database columns describe what the API HANDS BACK. Until now the component was always
// built from @Schema, so responses documented the write contract - no nullable, none of the
// database-generated columns, maxLength copied from the column width, and required fields
// that a response does not contain. So the response path asks for getResponseSchema first.
describe('Swagger schema generation - response vs request flavour', function () {
  let builder: any;

  beforeEach(() => {
    builder = new OpenApiBuilder({ title: 'Test', version: '1.0.0' } as any);
    builder.SchemaProviders = [new FakeModelSchemaProvider()];
  });

  const schemas = () => builder.document.components?.schemas ?? {};

  it('response flavour → the model column schema, not the @Schema write contract', () => {
    const out = builder.expandNamedSchemas({ type: 'object', description: 'TestUser' }, 'response');

    expect(out).to.deep.equal({ $ref: '#/components/schemas/TestUser' });

    const user = schemas().TestUser;
    expect(user.properties.nick).to.deep.equal({ type: 'string', nullable: true });
    // columns the write contract knows nothing about
    expect(user.properties).to.have.property('created_at');
    // a response is partial - no response component carries "required"
    expect(user).to.not.have.property('required');
  });

  it('relations survive into the response component as optional $refs', () => {
    builder.expandNamedSchemas({ type: 'array', items: { type: 'object', description: 'TestPost' } }, 'response');

    const post = schemas().TestPost;
    expect(post.properties.Author).to.deep.equal({ $ref: '#/components/schemas/TestUser' });
    expect(post).to.not.have.property('required');

    // the post → user → post cycle ends in a $ref, not in a loop
    expect(schemas().TestUser.properties.Posts.items).to.deep.equal({ $ref: '#/components/schemas/TestPost' });
  });

  it('request flavour is untouched - still the @Schema write contract', () => {
    builder.expandNamedSchemas({ type: 'object', description: 'TestUser' }, 'request');

    // the two contracts differ, so the write half lives under TestUserRequest
    const user = schemas().TestUserRequest;
    expect(user.required).to.include('email');
    expect(user.properties).to.not.have.property('created_at');
  });

  it('default flavour (no argument) stays "request"', () => {
    builder.expandNamedSchemas({ type: 'object', description: 'TestUser' });
    expect(schemas().TestUserRequest.required).to.include('email');
  });

  it('a type used both ways gets two components, never one overwriting the other', () => {
    builder.expandNamedSchemas({ type: 'object', description: 'TestUser' }, 'request');
    const out = builder.expandNamedSchemas({ type: 'object', description: 'TestUser' }, 'response');

    expect(out).to.deep.equal({ $ref: '#/components/schemas/TestUser' });
    expect(schemas().TestUserRequest.required).to.include('email');
    expect(schemas().TestUser).to.not.have.property('required');
  });

  /**
   * Which flavour keeps the plain `<Name>` must be a property of the FLAVOUR, not of who
   * got there first: controllers are discovered in filesystem order, so a first-arrival rule
   * let an unrelated new controller rename `TestUser` to `TestUserRequest` in every generated
   * client, with nothing in the diff pointing at it.
   */
  it('names components by flavour, not by which one the traversal reached first', () => {
    const requestFirst = new OpenApiBuilder({ title: 'Test', version: '1.0.0' } as any) as any;
    requestFirst.SchemaProviders = [new FakeModelSchemaProvider()];
    requestFirst.expandNamedSchemas({ type: 'object', description: 'TestUser' }, 'request');
    requestFirst.expandNamedSchemas({ type: 'object', description: 'TestUser' }, 'response');

    const responseFirst = new OpenApiBuilder({ title: 'Test', version: '1.0.0' } as any) as any;
    responseFirst.SchemaProviders = [new FakeModelSchemaProvider()];
    responseFirst.expandNamedSchemas({ type: 'object', description: 'TestUser' }, 'response');
    responseFirst.expandNamedSchemas({ type: 'object', description: 'TestUser' }, 'request');

    const names = (b: any) => Object.keys(b.document.components?.schemas ?? {}).sort();

    expect(names(requestFirst), 'component names changed with traversal order').to.deep.equal(names(responseFirst));
    // and the response is the half that keeps the plain name
    expect(requestFirst.document.components.schemas.TestUser).to.not.have.property('required');
    expect(requestFirst.document.components.schemas.TestUserRequest.required).to.include('email');
  });

  it('a type whose flavours agree stays one component under its plain name', () => {
    builder.expandNamedSchemas({ type: 'object', description: 'TestPaginationDto' }, 'request');
    builder.expandNamedSchemas({ type: 'object', description: 'TestPaginationDto' }, 'response');

    expect(Object.keys(schemas())).to.deep.equal(['TestPaginationDto']);
  });

  it('DTO without a response flavour falls back to getSchema, exactly as before', () => {
    const out = builder.expandNamedSchemas({ type: 'object', description: 'TestPaginationDto' }, 'response');

    expect(out).to.deep.equal({ $ref: '#/components/schemas/TestPaginationDto' });
    expect(schemas().TestPaginationDto.required).to.include('page');
  });

  it('buildResponses asks for the response flavour', () => {
    const responses = builder.buildResponses({ returns: { type: 'TestUser', description: 'User' } });

    expect(responses['200'].content['application/json'].schema).to.deep.equal({ $ref: '#/components/schemas/TestUser' });
    expect(schemas().TestUser).to.not.have.property('required');
    expect(schemas().TestUser.properties).to.have.property('created_at');
  });

  /**
   * `format: date-time` is the whole contract for a timestamp. Everything downstream keys off
   * it and nothing else: kubb's plugin-oas turns it into the `datetime` keyword, from which the
   * hydrate plugin generates the Luxon `DateTime.fromISO` conversion, and plugin-zod the
   * `z.iso.datetime()` validator. A property that reaches the document as a bare `string` is
   * read as text by every generated client, with no error anywhere to say so.
   */
  it('carries format: date-time into the component, on both flavours', () => {
    builder.expandNamedSchemas({ type: 'object', description: 'TestAudited' }, 'response');
    builder.expandNamedSchemas({ type: 'object', description: 'TestAudited' }, 'request');

    for (const name of ['TestAudited', 'TestAuditedRequest']) {
      const audited = schemas()[name];
      expect(audited, `${name} was never registered`).to.exist;
      expect(audited.properties.created_at, name).to.deep.equal({ type: 'string', format: 'date-time' });
      expect(audited.properties.archived_at, name).to.deep.equal({ type: 'string', format: 'date-time', nullable: true });
      expect(audited.properties.birthday, name).to.deep.equal({ type: 'string', format: 'date' });
      // an array of timestamps keeps the format on its ITEMS, which is where kubb reads it
      expect(audited.properties.history.items, name).to.deep.equal({ type: 'string', format: 'date-time' });
    }
  });

  /**
   * A column's DB `Comment` travels as `description`, and `description` is also how a
   * named-type placeholder is spelled. A comment reading "TestUser" used to replace the whole
   * property with `$ref: TestUser` - the timestamp became an object and its `format` was
   * dropped. A node that describes itself is not a type tag.
   */
  it('does not mistake a described scalar for a named-type tag', () => {
    builder.expandNamedSchemas({ type: 'object', description: 'TestAudited' }, 'response');

    const audited = schemas().TestAudited;
    expect(audited.properties.updated_at).to.deep.equal({ type: 'string', format: 'date-time', description: 'TestUser' });
    // ... while a genuine tag - object, no shape of its own - still becomes a $ref
    expect(audited.properties.Author).to.deep.equal({ $ref: '#/components/schemas/TestUser' });
  });

  it('buildRequestBody asks for the write flavour', () => {
    class TestUser {}
    const body = builder.buildRequestBody([{ param: { Name: 'model', Type: 'FromBody', Index: 0, RuntimeType: TestUser } }], {} as any);

    // TestUser reads and writes differently, so the write half is TestUserRequest - and it is
    // that name whether or not any response has been built yet.
    expect(body.content['application/json'].schema).to.deep.equal({ $ref: '#/components/schemas/TestUserRequest' });
    expect(schemas().TestUserRequest.required).to.include('email');
  });
});
