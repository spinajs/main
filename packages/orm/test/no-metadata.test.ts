import 'mocha';
import { expect } from 'chai';
import { DI, PROPERTY_TYPE_RESOLVER, ResolveException, type Class, type IPropertyTypeResolver } from '@spinajs/di';
import { Archived, Bool, CreatedAt, DateTime, HasMany, HasManyToMany, JunctionTable, ModelBase, OneToManyRelationList, ManyToManyRelationList, Primary, Relation, Set as SetColumn, SoftDelete, UpdatedAt, Virtual, extractModelDescriptor } from '../src/index.js';

// Applied by hand: TypeScript emits `design:type` only for decorators it applies itself, so these have no metadata.
const decorate = (decorator: unknown, target: object, property: string) => (decorator as PropertyDecorator)(target, property);

class Target extends ModelBase {}
decorate(Primary(), Target.prototype, 'Id');

class Stamped extends ModelBase {}
decorate(Primary(), Stamped.prototype, 'Id');
for (const [decorator, property] of [
  [CreatedAt, 'Created'],
  [UpdatedAt, 'Updated'],
  [SoftDelete, 'Deleted'],
  [Archived, 'Gone'],
  [DateTime, 'Seen'],
  [SetColumn, 'Roles'],
  [Bool, 'Active'],
] as const) {
  decorate(decorator(), Stamped.prototype, property);
}

class CustomList extends OneToManyRelationList<Target, Related> {}
class VirtualList extends OneToManyRelationList<Target, Related> {}
class Junction extends ModelBase {}

class Related extends ModelBase {}
decorate(Primary(), Related.prototype, 'Id');
decorate(HasMany(Target), Related.prototype, 'Plain');
decorate(HasMany(Target), Related.prototype, 'Custom');
decorate(HasManyToMany(Junction, Target), Related.prototype, 'Linked');
decorate(Virtual(), Related.prototype, 'Named');
decorate(JunctionTable(), Related.prototype, 'Row');

const DECLARED: Record<string, Class<unknown>> = { Plain: Relation, Custom: CustomList, Linked: Relation, Named: VirtualList, Row: Junction };

function withResolver<T>(typeOf: IPropertyTypeResolver['typeOf'], run: () => T): T {
  const resolver: IPropertyTypeResolver = { typeOf };
  DI.RootContainer.register(resolver).asValue(PROPERTY_TYPE_RESOLVER.key);
  try {
    return run();
  } finally {
    DI.RootContainer.uncache(PROPERTY_TYPE_RESOLVER.key);
  }
}

const declared: IPropertyTypeResolver['typeOf'] = (owner, property) => (owner === Related ? { type: DECLARED[property], array: false } : undefined);

const relation = (name: string) => extractModelDescriptor(Related)!.Relations.get(name)!;
const relationClass = (name: string) => (relation(name).RelationClass as () => unknown)();

describe('model decorators without decorator metadata', () => {
  it('do not fail when the class is defined, and keep what they set', () => {
    const model = extractModelDescriptor(Stamped)!;
    expect(model.Timestamps).to.include({ CreatedAt: 'Created', UpdatedAt: 'Updated' });
    expect(model.SoftDelete.DeletedAt).to.equal('Deleted');
    expect(model.Archived.ArchivedAt).to.equal('Gone');
    expect([...model.Converters.keys()]).to.include.members(['Created', 'Updated', 'Deleted', 'Gone', 'Seen', 'Roles', 'Active']);
  });

  it('take the relation class of @HasMany from what the property declares', () => {
    withResolver(declared, () => {
      expect(relationClass('Plain')).to.equal(OneToManyRelationList);
      expect(relationClass('Custom')).to.equal(CustomList);
    });
  });

  it('take the relation class of @HasManyToMany from what the property declares', () => {
    withResolver(declared, () => expect(relationClass('Linked')).to.equal(ManyToManyRelationList));
  });

  it('give @Virtual the class the property declares, as a class: the query middleware resolves it directly', () => {
    withResolver(declared, () => expect(relation('Named').RelationClass).to.equal(VirtualList));
  });

  it('give @JunctionTable the class the property declares', () => {
    withResolver(declared, () => expect(extractModelDescriptor(Related)!.JunctionModelProperties[0].Model).to.equal(Junction));
  });

  it('throw ResolveException naming the class and the property when nothing declares the type', () => {
    expect(() => relationClass('Plain')).to.throw(ResolveException, /Related\.Plain/);
    expect(() => relation('Named').RelationClass).to.throw(ResolveException, /Related\.Named/);
    expect(() => extractModelDescriptor(Related)!.JunctionModelProperties[0].Model).to.throw(ResolveException, /Related\.Row/);
  });
});
