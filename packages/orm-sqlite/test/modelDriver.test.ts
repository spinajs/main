import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, ConnectionMismatch, Model, ModelBase, NotAnOrmDriver, Orm, OrmConnectionMissing, OrmDriver, Primary, TransactionRequired, deleteFrom, modelDriver, ormConnection, ormReady, requireModelConnection, requireModelTransaction } from '@spinajs/orm';
import { expect } from 'chai';
import _ from 'lodash';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { mergeArrays } from './util.js';

class TwoConnections extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: {
          targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
        db: {
          Connections: [
            { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite' },
            { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'md-other' },
          ],
          Aliases: { 'md-alias': 'sqlite' },
        },
      },
      mergeArrays,
    );
  }
}

@Connection('md-alias')
@Model('md_doc')
class MdDoc extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('md-lost')
@Model('md_lost')
class MdLost extends ModelBase {
  @Primary()
  public Id: number;
}

function driver(name: string): OrmDriver {
  return DI.get(Orm)!.Connections.get(name)!;
}

function thrown(fn: () => unknown): any {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('did not throw');
}

describe('sqlite model driver helpers', function () {
  this.timeout(10000);

  before(() => {
    DI.register(TwoConnections).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  after(() => {
    DI.unregister(TwoConnections);
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver('sqlite')
      .schema()
      .createTable('md_doc', (table) => {
        table.int('Id').primaryKey();
        table.string('Name');
      });
    await DI.get(Orm)!.reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('modelDriver and ormConnection follow the alias the model names', () => {
    expect(modelDriver(MdDoc)).to.equal(driver('sqlite'));
    expect(ormConnection('md-alias')).to.equal(driver('sqlite'));
    expect(ormConnection('md-other')).to.equal(driver('md-other'));
  });

  it('name the connection nothing answers to', () => {
    const err = thrown(() => modelDriver(MdLost));
    expect(err).to.be.instanceOf(OrmConnectionMissing);
    expect(err.message).to.eq('MdLost: no ORM connection answers to "md-lost"; add it to db.Connections or map it in db.Aliases');
    expect(err.connection).to.eq('md-lost');
    expect(() => ormConnection('nope')).to.throw(OrmConnectionMissing, /^no ORM connection answers to "nope"; add it to db.Connections or map it in db.Aliases$/);
    expect(() => deleteFrom(MdLost)).to.throw(OrmConnectionMissing);
  });

  it('ormReady returns at once when an Orm created its connections', async () => {
    await Promise.all([ormReady(), ormReady()]);
    expect(modelDriver(MdDoc)).to.equal(driver('sqlite'));
  });

  it('deleteFrom deletes the rows the caller narrows it to', async () => {
    await MdDoc.insert([
      { Id: 1, Name: 'a' },
      { Id: 2, Name: 'b' },
    ]);

    const result = await deleteFrom(MdDoc).where('Name', 'a');

    expect(result.RowsAffected).to.eq(1);
    expect((await MdDoc.all()).map((d) => d.Id)).to.deep.eq([2]);
  });

  it('requireModelTransaction returns the driver of a transaction on the model connection', async () => {
    await driver('sqlite').transaction(async (d: OrmDriver) => {
      expect(requireModelTransaction(MdDoc, d)).to.equal(driver('sqlite'));
    });
  });

  it('requireModelTransaction refuses a non-driver, a driver without a transaction and another connection, in that order', async () => {
    expect(() => requireModelTransaction(MdDoc, {})).to.throw(NotAnOrmDriver, /^MdDoc: expected the OrmDriver of an open transaction, got object$/);
    expect(() => requireModelTransaction(MdDoc, undefined)).to.throw(NotAnOrmDriver, /got undefined$/);
    expect(() => requireModelTransaction(MdDoc, null)).to.throw(NotAnOrmDriver, /got null$/);
    expect(() => requireModelTransaction(MdDoc, driver('sqlite'))).to.throw(TransactionRequired, /^MdDoc: needs a transaction open on connection "sqlite", and none is in scope$/);
    expect(() => requireModelTransaction(MdLost, driver('sqlite'))).to.throw(TransactionRequired);

    await driver('md-other').transaction(async (d: OrmDriver) => {
      const err = thrown(() => requireModelTransaction(MdDoc, d));
      expect(err).to.be.instanceOf(ConnectionMismatch);
      expect(err.message).to.eq('MdDoc: the transaction runs on connection "md-other", but md_doc is on connection "sqlite"');
      expect(err).to.deep.include({ table: 'md_doc', expected: 'sqlite', actual: 'md-other' });
      expect(() => requireModelTransaction(MdLost, d)).to.throw(OrmConnectionMissing);
    });
  });

  it('requireModelConnection checks the connection without wanting a transaction', () => {
    expect(requireModelConnection(MdDoc, driver('sqlite'))).to.equal(driver('sqlite'));
    expect(() => requireModelConnection(MdDoc, driver('md-other'))).to.throw(ConnectionMismatch, /^MdDoc: the driver runs on connection "md-other", but md_doc is on connection "sqlite"$/);
    expect(() => requireModelConnection(MdDoc, {} as OrmDriver)).to.throw(NotAnOrmDriver, /^MdDoc: expected an OrmDriver, got object$/);
  });
});
