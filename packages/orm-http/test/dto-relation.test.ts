import 'mocha';
import { expect } from 'chai';
import chaiSubset from 'chai-subset';
import * as chai from 'chai';
import { ModelBase } from '@spinajs/orm';

chai.use(chaiSubset);
import { Relation, RELATION_SYMBOL, IDtoRelations, RelationResolverHydrator } from './../src/dto-relation.js';

class FakeUser extends ModelBase {}

describe('@Relation decorator', () => {
  it('records a relation descriptor on the DTO prototype', () => {
    class Dto { @Relation(() => FakeUser, { by: 'Uuid' }) public author?: string; }

    const desc = Reflect.getMetadata(RELATION_SYMBOL, Dto.prototype) as IDtoRelations;
    expect(desc).to.be.an('object');
    const rel = desc.Relations.get('author');
    expect(rel).to.containSubset({ field: 'author', by: 'Uuid' });
    expect(rel!.target()).to.equal(FakeUser);
  });

  it('registers RelationResolverHydrator as the class arg hydrator', () => {
    class Dto { @Relation(() => FakeUser) public author?: string; }

    const h = Reflect.getMetadata('custom:arg_hydrator', Dto);
    expect(h).to.deep.equal({ hydrator: RelationResolverHydrator });
  });

  it('does not overwrite an existing arg hydrator', () => {
    class Existing {}
    class Dto {}
    Reflect.defineMetadata('custom:arg_hydrator', { hydrator: Existing }, Dto);
    // apply decorator manually to the existing class
    Relation(() => FakeUser)(Dto.prototype, 'author');

    const h = Reflect.getMetadata('custom:arg_hydrator', Dto);
    expect(h).to.deep.equal({ hydrator: Existing });
  });

  it('is inherited by a subclass that does not redeclare it', () => {
    class Base { @Relation(() => FakeUser, { by: 'Uuid' }) public author?: string; }
    class Child extends Base {}

    const desc = Reflect.getMetadata(RELATION_SYMBOL, Child.prototype) as IDtoRelations;
    expect(desc.Relations.get('author')!.by).to.equal('Uuid');
  });

  it('lets a subclass override a field without mutating the base', () => {
    class Base { @Relation(() => FakeUser, { by: 'Uuid' }) public author?: string; }
    class Child extends Base { @Relation(() => FakeUser, { by: 'Email' }) public author?: string; }

    const childDesc = Reflect.getMetadata(RELATION_SYMBOL, Child.prototype) as IDtoRelations;
    const baseDesc = Reflect.getMetadata(RELATION_SYMBOL, Base.prototype) as IDtoRelations;
    expect(childDesc.Relations.get('author')!.by).to.equal('Email');
    expect(baseDesc.Relations.get('author')!.by).to.equal('Uuid');
  });
});
