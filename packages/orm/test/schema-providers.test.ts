import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { ModelSchemaProvider } from '../src/schema-providers.js';

// RelationType: One = 0, Many = 1, ManyToMany = 2
class TestUser {}
class TestTag {}
class TestPost {}

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

    DI.register(TestUser).as('__models__');
    DI.register(TestTag).as('__models__');
    DI.register(TestPost).as('__models__');

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
});
