import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { ModelSchemaProvider } from '../src/schema-providers.js';

// RelationType: One = 0, Many = 1, ManyToMany = 2
class TestUser {}
class TestTag {}
class TestPost {}
class TestSecret {}
class TestLegacySecret {}

// The provider reads each model's descriptor through the static `getModelDescriptor()`
// that ORM attaches to every model, so the fakes expose one directly.
function defineDescriptor(cls: any, descriptor: any) {
  cls.getModelDescriptor = () => descriptor;
}

describe('ModelSchemaProvider', function () {
  let provider: ModelSchemaProvider;

  before(() => {
    DI.clearCache();
    DI.setESMModuleSupport();

    defineDescriptor(TestUser, {
      Schema: { type: 'object', properties: { id: { type: 'integer' }, email: { type: 'string' } }, required: ['email'] },
      Relations: new Map([['Posts', { Type: 1, TargetModel: { name: 'TestPost' } }]]), // Many → TestPost
    });
    defineDescriptor(TestTag, {
      Schema: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } },
    });
    defineDescriptor(TestPost, {
      Schema: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' } }, required: ['title'] },
      Relations: new Map<string, any>([
        ['Author', { Type: 0, TargetModel: { name: 'TestUser' } }], // One → TestUser
        ['Tags', { Type: 2, TargetModel: { name: 'TestTag' } }], // ManyToMany → TestTag
      ]),
    });

    // Model loaded through a live connection: Orm builds BOTH schemas, and the response one
    // already has the hidden columns and `required` stripped ( see buildModelJsonSchema ).
    defineDescriptor(TestSecret, {
      Schema: { type: 'object', properties: { Id: { type: 'integer' }, Login: { type: 'string' }, Password: { type: 'string' } }, required: ['Login', 'Password'] },
      ResponseSchema: { type: 'object', properties: { Login: { type: 'string' } } },
      // `Owner` is a hidden RELATION, `Visible` an ordinary one - rbac's UserMetadata hides
      // its `User` relation exactly like this.
      Relations: new Map([
        ['Owner', { Type: 0, TargetModel: { name: 'TestUser' } }],
        ['Visible', { Type: 0, TargetModel: { name: 'TestTag' } }],
      ]),
      Hidden: ['Password', 'Id', 'Owner'],
    });

    // Same model as seen before it ever got a connection: no ResponseSchema was built, so the
    // provider has to fall back to the write schema - without leaking what `@Hidden()` removes.
    defineDescriptor(TestLegacySecret, {
      Schema: { type: 'object', properties: { Id: { type: 'integer' }, Login: { type: 'string' }, Password: { type: 'string' } }, required: ['Login', 'Password'] },
      Hidden: ['Password', 'Id'],
    });

    DI.register(TestUser).as('__models__');
    DI.register(TestTag).as('__models__');
    DI.register(TestPost).as('__models__');
    DI.register(TestSecret).as('__models__');
    DI.register(TestLegacySecret).as('__models__');

    // resolve() builds the name → model map from the registered models above
    provider = new ModelSchemaProvider();
    provider.resolve();
  });

  it('resolves a model name to its column schema', () => {
    const user = provider.getSchema('TestUser') as any;

    expect(user.type).to.equal('object');
    expect(user.properties.id.type).to.equal('integer');
    expect(user.properties.email.type).to.equal('string');
    expect(user.required).to.include('email');
  });

  it('to-one relation → object ref, to-many relation → array of object refs', () => {
    const post = provider.getSchema('TestPost') as any;

    // to-one relation → single ref (expanded into $ref later by the swagger builder)
    expect(post.properties.Author).to.deep.equal({ type: 'object', description: 'TestUser' });
    // to-many relation → array of refs
    expect(post.properties.Tags.type).to.equal('array');
    expect(post.properties.Tags.items).to.deep.equal({ type: 'object', description: 'TestTag' });
  });

  it('returns undefined for names that are not registered models', () => {
    expect(provider.getSchema('NoSuchType')).to.equal(undefined);
  });

  // getSchema describes the WRITE side (what may be sent), getResponseSchema the READ side
  // (what the API returns). A response is partial by nature: dehydrateWithRelations({
  // skipUndefined: true }) omits fields that were never loaded, and `include` decides which
  // relations show up at all - so no column can be "required".
  describe('getResponseSchema', () => {
    it('drops "required" - a response never promises every column', () => {
      const user = provider.getResponseSchema('TestUser') as any;

      expect(user.type).to.equal('object');
      expect(user.properties.id.type).to.equal('integer');
      expect(user.properties.email.type).to.equal('string');
      expect(user).to.not.have.property('required');
    });

    it('keeps relations, and they are optional too', () => {
      const post = provider.getResponseSchema('TestPost') as any;

      expect(post.properties.Author).to.deep.equal({ type: 'object', description: 'TestUser' });
      expect(post.properties.Tags.type).to.equal('array');
      expect(post.properties.Tags.items).to.deep.equal({ type: 'object', description: 'TestTag' });
      expect(post).to.not.have.property('required');
    });

    it('leaves the write contract alone - getSchema still carries "required"', () => {
      expect((provider.getSchema('TestPost') as any).required).to.include('title');
      expect((provider.getSchema('TestUser') as any).required).to.include('email');
    });

    it('returns undefined for names that are not registered models', () => {
      expect(provider.getResponseSchema('NoSuchType')).to.equal(undefined);
    });

    /**
     * `dehydrate()` / `dehydrateWithRelations()` omit `@Hidden()` properties unconditionally, so those
     * columns CANNOT appear in a response - rbac's User hides `Password` and `Id`. The
     * column-derived schema advertised them anyway, which both described fields that are
     * never there and published a `Password` property on a public response schema.
     */
    it('never advertises a column the model hides from every dehydration', () => {
      const secret = provider.getResponseSchema('TestSecret') as any;

      // `Visible` is the model's one non-hidden relation - the columns are exactly `Login`
      expect(Object.keys(secret.properties), 'a hidden column leaked into the response schema').to.deep.equal(['Login', 'Visible']);
      expect(secret.properties, 'Password must never appear on a response schema').to.not.have.property('Password');
      expect(secret.properties, 'the hidden primary key leaked into the response schema').to.not.have.property('Id');
    });

    /**
     * `@Hidden()` marks a PROPERTY, and a relation is a property: `dehydrateWithRelations()`
     * omits a hidden relation exactly like a hidden column. Columns are filtered while the
     * column schema is built, but relations are appended afterwards by the provider - so
     * without filtering them there too, a hidden relation stayed in the response schema.
     */
    it('never advertises a relation the model hides', () => {
      const secret = provider.getResponseSchema('TestSecret') as any;

      expect(secret.properties, 'a hidden relation leaked into the response schema').to.not.have.property('Owner');
      // a relation nobody hid is still advertised, so the filter is targeted rather than total
      expect(secret.properties, 'every relation was dropped, not just the hidden one').to.have.property('Visible');
    });

    it('keeps a hidden relation on the write contract', () => {
      // hiding a relation from responses says nothing about whether a client may send it
      expect((provider.getSchema('TestSecret') as any).properties).to.have.property('Owner');
    });

    it('strips hidden columns even when the model never got a ResponseSchema built', () => {
      const legacy = provider.getResponseSchema('TestLegacySecret') as any;

      expect(Object.keys(legacy.properties)).to.deep.equal(['Login']);
      expect(legacy).to.not.have.property('required');
    });

    it('leaves the write contract alone - a hidden column is still writable', () => {
      const write = provider.getSchema('TestSecret') as any;

      // relations are part of the write contract too, hidden or not - see the relation tests above
      expect(Object.keys(write.properties)).to.have.members(['Id', 'Login', 'Password', 'Owner', 'Visible']);
      expect(write.required).to.include('Password');
    });
  });
});
