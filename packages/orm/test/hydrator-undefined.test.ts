/* eslint-disable prettier/prettier */
import './../src/bootstrap.js';
import '@spinajs/log';
import { DbPropertyHydrator, NonDbPropertyHydrator, OneToOneRelationHydrator, ModelHydrator } from './../src/hydrators.js';
import { Model1 } from './mocks/models/Model1.js';
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import { Orm } from '../src/index.js';
import { ConnectionConf, FakeSqliteDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeUpdateQueryCompiler, FakeInsertQueryCompiler, FakeTableQueryCompiler, FakeConverter, FakeServerResponseMapper, FakeMysqlDriver } from './misc.js';
import { SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, TableQueryCompiler, DatetimeValueConverter, ServerResponseMapper } from '../src/interfaces.js';
import * as chai from 'chai';
import 'mocha';

const expect = chai.expect;

/**
 * `undefined` means "this payload says nothing about the property", `null` means "set it to
 * nothing". Hydration must honour the difference: a partial payload ( a PATCH body, a merge of
 * DTO fields where the client omitted some ) is the normal shape callers pass, and a hydrator
 * that assigned `undefined` would blank a stored value the caller never mentioned.
 */
describe('Hydrator undefined handling', () => {
  before(() => {
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
    DI.register(FakeConverter).as(DatetimeValueConverter);
    DI.register(FakeServerResponseMapper).as(ServerResponseMapper);
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) { await b.bootstrap(); }
    await DI.resolve(Orm); // populates model descriptors' Columns from table info
  });

  afterEach(() => { DI.clearCache(); });

  describe('db columns', () => {
    it('leaves a stored value untouched when the payload carries undefined', () => {
      const m = new Model1();
      m.Bar = 'stored';

      m.hydrate({ Bar: undefined } as any);

      expect(m.Bar).to.equal('stored');
    });

    it('clears the value when the payload carries null', () => {
      const m = new Model1();
      m.Bar = 'stored';

      m.hydrate({ Bar: null } as any);

      expect(m.Bar).to.be.null;
    });
  });

  describe('non-db properties', () => {
    it('leaves a stored value untouched when the payload carries undefined', () => {
      const m = new Model1() as any;
      m.NotAColumn = 'stored';

      m.hydrate({ NotAColumn: undefined });

      expect(m.NotAColumn).to.equal('stored');
    });

    it('does not create the property at all from an undefined value', () => {
      const m = new Model1() as any;

      m.hydrate({ NotAColumn: undefined });

      expect('NotAColumn' in m, 'undefined must not materialize a property').to.be.false;
    });

    it('sets the property when the payload carries null', () => {
      const m = new Model1() as any;
      m.NotAColumn = 'stored';

      m.hydrate({ NotAColumn: null });

      expect(m.NotAColumn).to.be.null;
    });

    it('still assigns a real value', () => {
      const m = new Model1() as any;

      m.hydrate({ NotAColumn: 'value' });

      expect(m.NotAColumn).to.equal('value');
    });
  });
});
