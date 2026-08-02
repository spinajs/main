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
import { ConnectionConf, FakeMysqlDriver, FakeSqliteDriver } from './misc.js';

const expect = chai.expect;

/**
 * `_hidden` names the properties a model NEVER dehydrates - `dehydrate()` and
 * `dehydrateWithRelations()` add it to `omit` unconditionally ( model.ts ), and rbac's User
 * hides `Password` and `Id` that way. The column-derived response schema advertised them
 * regardless, so the documentation described fields the ORM guarantees are absent and put a
 * `Password` property on a public response schema.
 *
 * It is a class-property initializer, so it exists only on an instance - which is why the
 * list is captured once, at model load, instead of every reader constructing a model to ask.
 *
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
   * descriptor build over it - table info, hidden list, both schemas.
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

  it('records _hidden on the descriptor and keeps it out of the response schema only', async () => {
    class HiddenColumnModel extends ModelBase {
      protected _hidden: string[] = ['Bar'];
    }

    const descriptor = await loadModel(HiddenColumnModel);

    expect(descriptor.Hidden, 'the model _hidden list was not captured at load').to.deep.equal(['Bar']);
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

  /**
   * A model whose constructor throws must not take the boot down with it: an empty list is
   * exactly what this package produced before the capture existed.
   */
  it('survives a model whose constructor throws', () => {
    class Exploding {
      constructor() {
        throw new Error('boom');
      }
    }

    const orm = Object.create(Orm.prototype) as any;
    Object.defineProperty(orm, 'Log', { value: { warn: () => undefined } });

    expect(orm.readHiddenProperties(Exploding)).to.deep.equal([]);
  });
});
