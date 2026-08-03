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
import { ManyQueryRelationList, ManyToManyRelationList, OneToManyRelationList } from '../src/relation-objects.js';
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

// Junction-free on purpose: none of the behaviours below touch the junction model,
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

function queryRelation(objects: Model1[]): ManyQueryRelationList<Model1, Model1> {
  return new ManyQueryRelationList(new Model1({ Id: 1 }), oneToManyDescriptor(), objects);
}

describe('Relation lifecycle', () => {
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

  describe('clear / empty', () => {
    it('clear() empties the relation and resolves', async () => {
      await db();

      const list = oneToMany([new Model1({ Id: 1 }), new Model1({ Id: 2 })]);

      const result = list.clear();

      expect(result).to.be.instanceOf(Promise, 'clear() is async and returns a promise');
      await result;

      expect(list.length).to.eq(0);
    });

    it('empty() empties the relation synchronously', async () => {
      await db();

      const list = oneToMany([new Model1({ Id: 1 }), new Model1({ Id: 2 })]);

      const result = list.empty();

      expect(result).to.be.undefined;
      expect(list.length).to.eq(0);
    });

    it('empty() clears a many-to-many relation too', async () => {
      await db();

      const list = manyToMany([new Model1({ Id: 1 }), new Model1({ Id: 2 })]);

      list.empty();

      expect(list.length).to.eq(0);
    });
  });

  describe('set', () => {
    it('replaces all members when given a plain array', async () => {
      await db();

      const list = oneToMany([new Model1({ Id: 1 }), new Model1({ Id: 2 })]);
      const replacement = new Model1({ Id: 7 });

      list.set([replacement]);

      expect(list.length).to.eq(1);
      expect(list[0]).to.eq(replacement);
    });

    it('passes the current members and the primary key columns to a callback and takes its result', async () => {
      await db();

      const first = new Model1({ Id: 1 });
      const second = new Model1({ Id: 2 });
      const list = oneToMany([first, second]);

      const replacement = [new Model1({ Id: 7 }), new Model1({ Id: 8 })];
      // Holder object, so the values captured inside the callback survive type narrowing.
      const captured: { members: Model1[]; pKey: string[]; calls: number } = { members: [], pKey: [], calls: 0 };

      list.set((data, pKey) => {
        captured.members = data;
        captured.pKey = pKey;
        captured.calls += 1;
        return replacement;
      });

      expect(captured.calls).to.eq(1);
      expect(captured.members).to.have.ordered.members([first, second], 'the callback receives the members present before the replacement');
      expect(captured.pKey).to.deep.eq(['Id']);
      expect([...list]).to.have.ordered.members(replacement);
    });
  });

  describe('purity of diff / intersection', () => {
    it('diff() does not mutate the relation contents', async () => {
      await db();

      const list = oneToMany([new Model1({ Id: 1 }), new Model1({ Id: 2 })]);
      const before = [...list];

      const result = list.diff([new Model1({ Id: 2 }), new Model1({ Id: 3 })]);

      // symmetric difference: dataset members missing here first, then own members missing there
      expect(result.map((m) => m.Id)).to.deep.eq([3, 1]);
      expect(list.length).to.eq(2);
      expect([...list]).to.have.ordered.members(before);
    });

    it('intersection() does not mutate the relation contents', async () => {
      await db();

      const list = oneToMany([new Model1({ Id: 1 }), new Model1({ Id: 2 })]);
      const before = [...list];

      const result = list.intersection([new Model1({ Id: 2 }), new Model1({ Id: 3 })]);

      expect(result.map((m) => m.Id)).to.deep.eq([2]);
      expect(list.length).to.eq(2);
      expect([...list]).to.have.ordered.members(before);
    });
  });

  describe('ManyQueryRelationList guards', () => {
    it('is populated straight after construction', async () => {
      await db();

      const list = new ManyQueryRelationList(new Model1({ Id: 1 }), oneToManyDescriptor(), []);

      expect(list.Populated).to.be.true;
      expect(list.length).to.eq(0);
    });

    it('remove() throws', async () => {
      await db();

      const list = queryRelation([new Model1({ Id: 1 })]);

      expect(() => list.remove(new Model1({ Id: 1 }))).to.throw(OrmException);
    });

    it('sync() throws synchronously — it is not an async method, so no rejected promise is produced', async () => {
      await db();

      const list = queryRelation([new Model1({ Id: 1 })]);

      expect(() => list.sync()).to.throw(OrmException);
    });

    it('update() throws synchronously', async () => {
      await db();

      const list = queryRelation([new Model1({ Id: 1 })]);

      expect(() => list.update()).to.throw(OrmException);
    });

    it('intersection() throws', async () => {
      await db();

      const list = queryRelation([new Model1({ Id: 1 })]);

      expect(() => list.intersection([new Model1({ Id: 1 })])).to.throw(OrmException);
    });

    it('union() throws', async () => {
      await db();

      const list = queryRelation([new Model1({ Id: 1 })]);

      expect(() => list.union([new Model1({ Id: 2 })])).to.throw(OrmException);
    });

    it('diff() throws', async () => {
      await db();

      const list = queryRelation([new Model1({ Id: 1 })]);

      expect(() => list.diff([new Model1({ Id: 2 })])).to.throw(OrmException);
    });

    it('set() throws', async () => {
      await db();

      const list = queryRelation([new Model1({ Id: 1 })]);

      expect(() => list.set([new Model1({ Id: 2 })])).to.throw(OrmException);
    });

    it('populate() throws synchronously', async () => {
      await db();

      const list = queryRelation([new Model1({ Id: 1 })]);

      expect(() => list.populate()).to.throw(OrmException);
    });
  });

  describe('Symbol.species', () => {
    it('slice() derives a plain Array, not a relation', async () => {
      await db();

      const list = oneToMany([new Model1({ Id: 1 }), new Model1({ Id: 2 })]);

      const result = list.slice();

      expect(result).to.be.instanceOf(Array);
      expect(result).to.not.be.instanceOf(OneToManyRelationList);
      expect(result.map((m) => m.Id)).to.deep.eq([1, 2]);
    });

    it('filter() derives a plain Array, not a relation', async () => {
      await db();

      const list = oneToMany([new Model1({ Id: 1 }), new Model1({ Id: 2 })]);

      const result = list.filter(() => true);

      expect(result).to.be.instanceOf(Array);
      expect(result).to.not.be.instanceOf(OneToManyRelationList);
      expect(result.map((m) => m.Id)).to.deep.eq([1, 2]);
    });

    it('map() derives a plain Array, not a relation', async () => {
      await db();

      const list = oneToMany([new Model1({ Id: 1 }), new Model1({ Id: 2 })]);

      const result = list.map((x) => x);

      expect(result).to.be.instanceOf(Array);
      expect(result).to.not.be.instanceOf(OneToManyRelationList);
      expect(result.map((m) => m.Id)).to.deep.eq([1, 2]);
    });
  });
});
