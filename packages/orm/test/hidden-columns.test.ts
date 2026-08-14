/* eslint-disable prettier/prettier */
import './../src/bootstrap.js';
import 'mocha';
import * as chai from 'chai';
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import '@spinajs/log';
import { Orm } from '../src/index.js';
import { ModelBase, updateModelDescriptor } from './../src/model.js';
import { extractModelDescriptor } from './../src/descriptor.js';
import { BelongsTo, Hidden, Primary } from './../src/decorators.js';
import { SingleRelation } from './../src/relation-objects.js';
import { ConnectionConf, FakeMysqlDriver, FakeSqliteDriver } from './misc.js';
import { Model4 } from './mocks/models/Model4.js';

const expect = chai.expect;

/**
 * `@Hidden()` names the properties a model NEVER dehydrates - `dehydrate()` and
 * `dehydrateWithRelations()` add `descriptor.Hidden` to `omit` unconditionally ( model.ts ),
 * and rbac's User hides `Password` and `Id` that way. The column-derived response schema
 * advertised them regardless, so the documentation described fields the ORM guarantees are
 * absent and put a `Password` property on a public response schema.
 *
 * The list is written by a decorator, so it is on the descriptor at class-definition time -
 * before, and without, any database connection. That is what lets `@spinajs/http-swagger` keep
 * `Password` out of a generated response schema without booting an Orm first.
 */
describe('@Hidden() property decorator', () => {
  /**
   * The whole point of the decorator. Nothing in this block resolves an Orm, opens a
   * connection or registers a model - the descriptor is complete as soon as the class body
   * has been evaluated.
   */
  it('records hidden properties at class-definition time, with no Orm and no database', () => {
    class NeverRegisteredModel extends ModelBase {
      @Primary()
      @Hidden()
      public Id: number;

      @Hidden()
      public Password: string;

      public Login: string;
    }

    const descriptor = extractModelDescriptor(NeverRegisteredModel)!;

    expect(descriptor.Hidden, 'the decorator did not reach the descriptor').to.deep.equal(['Id', 'Password']);

    // Two decorators on one property both took effect - rbac's User hides its @Primary() `Id`
    expect(descriptor.PrimaryKey).to.deep.equal(['Id']);

    // ...and this model has never seen a database: no driver, no table, no columns. Every
    // assertion above therefore holds on nothing but the class declaration.
    expect(descriptor.Driver, 'a driver was attached - this model was resolved after all').to.be.null;
    expect(descriptor.TableName).to.equal('');
    expect(descriptor.Columns, 'columns were loaded - table info ran, so a connection existed').to.deep.equal([]);
  });

  it('hides a relation property, not only a column', () => {
    class HiddenRelationDescriptorModel extends ModelBase {
      @Hidden()
      @BelongsTo(Model4, 'OwnerId')
      public Owner: SingleRelation<Model4>;
    }

    const descriptor = extractModelDescriptor(HiddenRelationDescriptorModel)!;

    expect(descriptor.Hidden).to.deep.equal(['Owner']);
    expect(descriptor.Relations.has('Owner'), 'the relation itself was lost').to.be.true;
  });

  it('records the same property once, however many times it is decorated', () => {
    class HiddenParentTwice extends ModelBase {
      @Hidden()
      public Password: string;
    }

    // A subclass re-declaring what its parent already hides must not double the entry
    class HiddenChildTwice extends HiddenParentTwice {
      @Hidden()
      public Password: string;
    }

    expect(extractModelDescriptor(HiddenChildTwice)!.Hidden).to.deep.equal(['Password']);
  });

  /**
   * The reason a decorator was chosen over a static field: a static is one object shared by the
   * whole inheritance chain, so a subclass adding to it rewrites its parent. A descriptor is
   * collapsed per class ( `getInheritedDescriptor`, @spinajs/di ), which gives the child its own
   * array pre-filled with everything it inherited.
   */
  it('gives a subclass the parent hidden properties plus its own, without mutating the parent', () => {
    class HiddenBaseModel extends ModelBase {
      @Hidden()
      public Password: string;
    }

    class HiddenDerivedModel extends HiddenBaseModel {
      @Hidden()
      public Secret: string;
    }

    expect(extractModelDescriptor(HiddenDerivedModel)!.Hidden).to.deep.equal(['Password', 'Secret']);
    expect(extractModelDescriptor(HiddenBaseModel)!.Hidden, 'the child wrote into the parent list').to.deep.equal(['Password']);

    // ...and they are genuinely different arrays, not the same one read twice
    expect(extractModelDescriptor(HiddenDerivedModel)!.Hidden).to.not.equal(extractModelDescriptor(HiddenBaseModel)!.Hidden);
  });
});

/**
 * The models below are wired by hand rather than with `@Model` / `@Connection`: those
 * decorators register the class in the global `'__models__'` registry, and model.test.ts
 * asserts on how many models that registry holds.
 */
describe('Model hidden columns', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    DI.register(FakeMysqlDriver).as('mysql');
    DI.removeAllListeners('di.resolve.Configuration');

    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }
  });

  afterEach(() => {
    DI.clearCache();
  });

  /**
   * Boots an Orm whose only extra model is `model`, so `reloadTableInfo` runs the whole
   * descriptor build over it - table info, both schemas - and `wireRelations` resolves its
   * relation targets.
   *
   * @param model - model class to load
   */
  async function loadModel(model: any) {
    updateModelDescriptor(model, (d) => {
      d.Connection = 'sqlite';
      d.TableName = 'TestTable1';
    });

    class FakeOrm extends Orm {
      constructor() {
        super();
        (this as any).registerModel(model);
      }
    }

    const container = DI.child();
    container.register(ConnectionConf).as(Configuration);
    container.register(FakeSqliteDriver).as('sqlite');
    container.register(FakeMysqlDriver).as('mysql');
    container.register(FakeOrm).as(Orm);

    await container.resolve(Orm);

    return extractModelDescriptor(model)!;
  }

  it('keeps a hidden column out of the response schema only', async () => {
    class HiddenColumnModel extends ModelBase {
      @Hidden()
      public Bar: string;
    }

    const descriptor = await loadModel(HiddenColumnModel);

    expect(descriptor.Hidden, 'the model hidden list was not captured').to.deep.equal(['Bar']);
    expect(Object.keys(descriptor.ResponseSchema.properties), 'a hidden column reached the response schema').to.not.include('Bar');
    // `Id` proves the response schema was built at all, rather than left empty
    expect(Object.keys(descriptor.ResponseSchema.properties)).to.include('Id');
    // the write contract is untouched - a hidden column is still writable
    expect(Object.keys(descriptor.Schema.properties)).to.include('Bar');
  });

  it('a model that hides nothing gets both schemas with the same columns', async () => {
    class PlainModel extends ModelBase {}

    const descriptor = await loadModel(PlainModel);

    expect(descriptor.Hidden).to.deep.equal([]);
    expect(Object.keys(descriptor.ResponseSchema.properties)).to.deep.equal(Object.keys(descriptor.Schema.properties));
    // ...but a response still promises nothing
    expect(descriptor.ResponseSchema).to.not.have.property('required');
  });

  it('dehydrate() omits a hidden column and keeps the rest', async () => {
    class DehydrateHiddenColumnModel extends ModelBase {
      @Primary()
      public Id: number;

      @Hidden()
      public Bar: string;

      public OwnerId: number;
    }

    await loadModel(DehydrateHiddenColumnModel);

    const model = new DehydrateHiddenColumnModel();
    model.Bar = 'secret';
    model.OwnerId = 7;

    const data = model.dehydrate();

    expect(data, 'a hidden column was dehydrated').to.not.have.property('Bar');
    expect(data).to.have.property('OwnerId', 7);
    expect(data).to.have.property('Id');
  });

  it('dehydrateWithRelations() omits a hidden column and a hidden relation', async () => {
    class DehydrateHiddenRelationModel extends ModelBase {
      @Primary()
      public Id: number;

      @Hidden()
      public Bar: string;

      @Hidden()
      @BelongsTo(Model4, 'OwnerId')
      public Owner: SingleRelation<Model4>;

      @BelongsTo(Model4, 'RelId2')
      public Visible: SingleRelation<Model4>;
    }

    await loadModel(DehydrateHiddenRelationModel);

    const model = new DehydrateHiddenRelationModel();
    model.Bar = 'secret';

    // BOTH relations are populated, deliberately. An unpopulated relation is absent from the
    // payload whether or not anyone hid it ( the foreign key column carries the link instead ),
    // so leaving them empty would let this pass for the wrong reason - `Owner` missing because
    // nothing populated it, rather than because `@Hidden()` dropped it.
    model.Owner.attach(new Model4({ Id: 10 }));
    model.Visible.attach(new Model4({ Id: 11 }));

    const data = model.dehydrateWithRelations() as Record<string, unknown>;

    expect(data, 'a hidden column was dehydrated').to.not.have.property('Bar');
    expect(data, 'a hidden relation was dehydrated').to.not.have.property('Owner');
    // a relation nobody hid is still there, so the omission is targeted rather than total
    expect(data, 'every relation was dropped, not just the hidden one').to.have.property('Visible');
  });
});
