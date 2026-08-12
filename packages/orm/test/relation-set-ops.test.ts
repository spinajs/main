/* eslint-disable prettier/prettier */
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import '@spinajs/log';

import { FakeSqliteDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeInsertQueryCompiler, FakeUpdateQueryCompiler, ConnectionConf, FakeMysqlDriver, FakeTableQueryCompiler } from './misc.js';
import { SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, RelationType, TableQueryCompiler, IRelationDescriptor } from '../src/interfaces.js';
import { NonDbPropertyHydrator, DbPropertyHydrator, ModelHydrator, OneToOneRelationHydrator, JunctionModelPropertyHydrator, OneToManyRelationHydrator } from '../src/hydrators.js';
import { Dataset, ManyToManyRelationList, OneToManyRelationList } from '../src/relation-objects.js';
import { OrmException } from '../src/exceptions.js';
import { Orm } from '../src/orm.js';
import { Model1 } from './mocks/models/Model1.js';
import { Model4 } from './mocks/models/Model4.js';
import '../src/bootstrap.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

async function db() {
  return await DI.resolve(Orm);
}

function oneToManyDescriptor(): IRelationDescriptor {
  return {
    TargetModel: Model1 as any,
    TargetModelType: Model1,
    Name: 'Translations',
    Type: RelationType.Many,
    SourceModel: null as any,
    ForeignKey: 'IdA',
    PrimaryKey: 'Id',
    Recursive: false,
  } as IRelationDescriptor;
}

// Junction-free on purpose: the in-memory set operations never touch the junction model,
// and constructing the Model5 mock directly trips its @JunctionTable hydrator.
function manyToManyDescriptor(): IRelationDescriptor {
  return {
    TargetModel: Model1 as any,
    TargetModelType: Model1,
    Name: 'ManyOwners',
    Type: RelationType.ManyToMany,
    SourceModel: Model4 as any,
    ForeignKey: '',
    PrimaryKey: 'Id',
    Recursive: false,
  } as IRelationDescriptor;
}

function oneToMany(objects: Model1[]): OneToManyRelationList<Model1, Model1> {
  return new OneToManyRelationList(new Model1({ Id: 1 }), oneToManyDescriptor(), objects);
}

function manyToMany(objects: Model1[]): ManyToManyRelationList<Model1, Model4> {
  return new ManyToManyRelationList(new Model4({ Id: 1 }), manyToManyDescriptor(), objects);
}

describe('Relation set operations', () => {
  beforeEach(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    DI.register(FakeMysqlDriver).as('mysql');

    DI.register(FakeSelectQueryCompiler).as(SelectQueryCompiler);
    DI.register(FakeDeleteQueryCompiler).as(DeleteQueryCompiler);
    DI.register(FakeUpdateQueryCompiler).as(UpdateQueryCompiler);
    DI.register(FakeInsertQueryCompiler).as(InsertQueryCompiler);
    DI.register(FakeTableQueryCompiler).as(TableQueryCompiler);

    DI.register(DbPropertyHydrator).as(ModelHydrator);
    DI.register(NonDbPropertyHydrator).as(ModelHydrator);
    DI.register(OneToOneRelationHydrator).as(ModelHydrator);
    DI.register(JunctionModelPropertyHydrator).as(ModelHydrator);
    DI.register(OneToManyRelationHydrator).as(ModelHydrator);

    DI.removeAllListeners('di.resolved.Configuration');
  });

  beforeEach(async () => {
    const bootstrappers = DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }
  });

  afterEach(async () => {
    DI.clearCache();
    sinon.restore();
  });

  describe('remove', () => {
    it('removes a member matched by primary key, not by object identity', async () => {
      await db();

      const member = new Model1({ Id: 2 });
      const list = oneToMany([new Model1({ Id: 1 }), member]);

      const removed = list.remove(new Model1({ Id: 2 }));

      expect(list.length).to.eq(1);
      expect(list[0].Id).to.eq(1);
      expect(removed).to.have.length(1);
      expect(removed[0]).to.eq(member);
    });

    it('removes an array of members by primary key and returns only the members actually removed', async () => {
      await db();

      const list = oneToMany([new Model1({ Id: 1 }), new Model1({ Id: 2 }), new Model1({ Id: 3 })]);

      const removed = list.remove([new Model1({ Id: 2 }), new Model1({ Id: 99 })]);

      expect(list.map((m) => m.Id)).to.deep.eq([1, 3]);
      expect(removed).to.have.length(1);
      expect(removed[0].Id).to.eq(2);
    });

    it('removes an unsaved member only by reference, never by its undefined key', async () => {
      await db();

      const fresh = new Model1();
      const otherFresh = new Model1();
      const list = oneToMany([fresh, otherFresh]);

      const removed = list.remove(fresh);

      expect(list.length).to.eq(1);
      expect(list[0]).to.eq(otherFresh);
      expect(removed).to.deep.eq([fresh]);
    });

    it('still removes by predicate', async () => {
      await db();

      const list = oneToMany([new Model1({ Id: 1 }), new Model1({ Id: 2 })]);

      const removed = list.remove((m: Model1) => m.Id === 1);

      expect(list.map((m) => m.Id)).to.deep.eq([2]);
      expect(removed.map((m) => m.Id)).to.deep.eq([1]);
    });

    it('removes by primary key on many-to-many lists too', async () => {
      await db();

      const list = manyToMany([new Model1({ Id: 1 }), new Model1({ Id: 2 })]);

      const removed = list.remove(new Model1({ Id: 1 }));

      expect(list.map((m) => m.Id)).to.deep.eq([2]);
      expect(removed.map((m) => m.Id)).to.deep.eq([1]);
    });
  });

  describe('union', () => {
    it('does not duplicate members already present, compared by primary key', async () => {
      await db();

      const kept = new Model1({ Id: 2 });
      const list = oneToMany([new Model1({ Id: 1 }), kept]);

      list.union([new Model1({ Id: 2 }), new Model1({ Id: 3 })]);

      expect(list.map((m) => m.Id)).to.deep.eq([1, 2, 3]);
      expect(list[1]).to.eq(kept, 'the instance already in the relation wins over the incoming duplicate');
    });

    it('does not duplicate members within the added dataset itself', async () => {
      await db();

      const list = oneToMany([new Model1({ Id: 1 })]);

      list.union([new Model1({ Id: 2 }), new Model1({ Id: 2 })]);

      expect(list.map((m) => m.Id)).to.deep.eq([1, 2]);
    });

    it('always appends unsaved models — an undefined key is not a duplicate of another undefined key', async () => {
      await db();

      const list = oneToMany([new Model1()]);

      list.union([new Model1(), new Model1()]);

      expect(list.length).to.eq(3);
    });

    it('dedupes on many-to-many lists too', async () => {
      await db();

      const list = manyToMany([new Model1({ Id: 1 })]);

      list.union([new Model1({ Id: 1 }), new Model1({ Id: 2 })]);

      expect(list.map((m) => m.Id)).to.deep.eq([1, 2]);
    });
  });

  describe('Dataset.union', () => {
    it('composes with set() like diff and intersection do', async () => {
      await db();

      const list = oneToMany([new Model1({ Id: 1 }), new Model1({ Id: 2 })]);

      list.set((Dataset as any).union([new Model1({ Id: 2 }), new Model1({ Id: 3 })]));

      expect(list.map((m) => m.Id)).to.deep.eq([1, 2, 3]);
    });

    it('honours a custom comparator', async () => {
      await db();

      const list = oneToMany([new Model1({ Id: 1, Property1: 'a' } as any), new Model1({ Id: 2, Property1: 'b' } as any)]);

      list.set((Dataset as any).union([new Model1({ Id: 9, Property1: 'b' } as any), new Model1({ Id: 10, Property1: 'c' } as any)], (a: any, b: any) => a.Property1 === b.Property1));

      expect(list.map((m: any) => m.Property1)).to.deep.eq(['a', 'b', 'c']);
    });
  });

  describe('unsaved models in diff / intersection', () => {
    it('treats two distinct unsaved models as different members in diff', async () => {
      await db();

      const freshA = new Model1();
      const freshB = new Model1();

      const result = Dataset.diff([freshA])([freshB], ['Id']);

      expect(result).to.have.length(2);
    });

    it('intersection matches an unsaved model only by reference', async () => {
      await db();

      const fresh = new Model1();

      expect(Dataset.intersection([fresh])([fresh], ['Id'])).to.deep.eq([fresh]);
      expect(Dataset.intersection([new Model1()])([new Model1()], ['Id'])).to.have.length(0);
    });
  });

  describe('empty primary key guard', () => {
    it('diff without a comparator throws when the model has no primary key columns', async () => {
      await db();

      expect(() => Dataset.diff([new Model1({ Id: 1 })])([new Model1({ Id: 2 })], [])).to.throw(OrmException);
    });

    it('intersection without a comparator throws when the model has no primary key columns', async () => {
      await db();

      expect(() => Dataset.intersection([new Model1({ Id: 1 })])([new Model1({ Id: 2 })], [])).to.throw(OrmException);
    });

    it('a custom comparator lifts the requirement for a primary key', async () => {
      await db();

      const result = Dataset.diff([new Model1({ Id: 1 })], (a, b) => a.Id === b.Id)([new Model1({ Id: 1 })], []);

      expect(result).to.have.length(0);
    });
  });
});
