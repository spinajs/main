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

  /**
   * hydrate() is fed whole DTOs and rows. A body-supplied primary key re-keying a fetched model
   * would redirect its next UPDATE at another row, so a model the database has answered for -
   * marked by its Snapshot baseline - never has its pkey hydrated over. A snapshot-less model
   * still keys freely: that is the SELECT hydration path itself, and constructors may pre-fill
   * defaults into the pkey slot, so the VALUE cannot be the marker.
   */
  describe('primary key protection', () => {
    it('does not re-key a model the database has answered for', () => {
      const m = new Model1();
      (m as any).Id = 7;
      m.takeSnapshot();

      m.hydrate({ Id: 12, Bar: 'moved' } as any);

      expect(m.PrimaryKeyValue).to.equal(7);
      expect(m.Bar).to.equal('moved');
    });

    it('still keys a fresh model, even over a pre-filled default', () => {
      const m = new Model1();
      (m as any).Id = 0;

      m.hydrate({ Id: 12 } as any);

      expect(m.PrimaryKeyValue).to.equal(12);
    });

    it('null never clears an existing key', () => {
      const m = new Model1();
      (m as any).Id = 7;
      m.takeSnapshot();

      m.hydrate({ Id: null } as any);

      expect(m.PrimaryKeyValue).to.equal(7);
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
