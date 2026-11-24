import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Connection, InsertQueryBuilder, Model, ModelBase, Orm, Primary, ServerResponseMapper, createQuery, extractModelDescriptor } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import '@spinajs/log';

import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

@Connection('sqlite')
@Model('ra_desc')
class RaDesc extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('sqlite')
@Model('ra_wr')
class RaWithoutRowid extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('sqlite')
@Model('ra_wr_default')
class RaWithoutRowidDefault extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('sqlite')
@Model('ra_plain')
class RaPlain extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

const driver = () => db().Connections.get('sqlite') as SqliteOrmDriver;
const raw = (sql: string) => driver().schema().raw(sql);

/** [table, DDL, key column, AutoIncrement as measured on the bundled SQLite] */
const SHAPES: Array<[string, string, string, boolean]> = [
  ['ra_s_plain', 'CREATE TABLE ra_s_plain (Id INTEGER PRIMARY KEY, Name TEXT)', 'Id', true],
  ['ra_s_autoinc', 'CREATE TABLE ra_s_autoinc (Id INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT)', 'Id', true],
  ['ra_s_desc', 'CREATE TABLE ra_s_desc (Id INTEGER PRIMARY KEY DESC, Name TEXT)', 'Id', false],
  ['ra_s_asc', 'CREATE TABLE ra_s_asc (Id INTEGER PRIMARY KEY ASC, Name TEXT)', 'Id', true],
  ['ra_s_wr', 'CREATE TABLE ra_s_wr (Id INTEGER PRIMARY KEY, Name TEXT) WITHOUT ROWID', 'Id', false],
  ['ra_s_strict', 'CREATE TABLE ra_s_strict (Id INTEGER PRIMARY KEY, Name TEXT) STRICT', 'Id', true],
  ['ra_s_strict_wr', 'CREATE TABLE ra_s_strict_wr (Id INTEGER PRIMARY KEY, Name TEXT) STRICT, WITHOUT ROWID', 'Id', false],
  ['ra_s_quoted', 'CREATE TABLE ra_s_quoted (Id "integer" PRIMARY KEY, Name TEXT)', 'Id', true],
  ['ra_s_cased', 'CREATE TABLE ra_s_cased (Id Integer primary key, Name TEXT)', 'Id', true],
  ['ra_s_spaced', 'CREATE TABLE ra_s_spaced (Id "INTEGER " PRIMARY KEY, Name TEXT)', 'Id', false],
  ['ra_s_table_pk', 'CREATE TABLE ra_s_table_pk (Id INTEGER, Name TEXT, PRIMARY KEY (Id))', 'Id', true],
  ['ra_s_table_pk_desc', 'CREATE TABLE ra_s_table_pk_desc (Id INTEGER, Name TEXT, PRIMARY KEY (Id DESC))', 'Id', true],
  ['ra_s_int', 'CREATE TABLE ra_s_int (Id INT PRIMARY KEY, Name TEXT)', 'Id', false],
  ['ra_s_unique', 'CREATE TABLE ra_s_unique (Id INTEGER PRIMARY KEY UNIQUE, Name TEXT)', 'Id', true],
  ['ra_s_composite', 'CREATE TABLE ra_s_composite (A INTEGER, B INTEGER, PRIMARY KEY (A, B))', 'A', false],
  ['ra_s_temp_desc', 'CREATE TEMP TABLE ra_s_temp_desc (Id INTEGER PRIMARY KEY DESC, Name TEXT)', 'Id', false],
  ['ra_s_temp', 'CREATE TEMP TABLE ra_s_temp (Id INTEGER PRIMARY KEY, Name TEXT)', 'Id', true],
  ['ra_s_aux_desc', 'CREATE TABLE ra_aux.ra_s_aux_desc (Id INTEGER PRIMARY KEY DESC, Name TEXT)', 'Id', false],
  ['ra_s_aux', 'CREATE TABLE ra_aux.ra_s_aux (Id INTEGER PRIMARY KEY, Name TEXT)', 'Id', true],
  ['ra_s_view', 'CREATE VIEW ra_s_view AS SELECT Id, Name FROM ra_s_plain', 'Id', false],
];

const insertedKeys = async (model: typeof ModelBase, values: Record<string, unknown>) => {
  const insert = createQuery(model, InsertQueryBuilder).query.values(values);
  const response: unknown = await insert;
  return insert.Container.resolve(ServerResponseMapper).insertedKeys(response, insert);
};

const ids = async (table: string) => (await driver().select().from(table).asRaw<Array<{ Id: unknown }>>()).map((r) => r.Id);

describe('Sqlite - only the rowid alias is AutoIncrement', function () {
  this.timeout(15000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await raw("ATTACH ':memory:' AS ra_aux");
    for (const [, ddl] of SHAPES) await raw(ddl);
    await raw('CREATE TABLE ra_desc (Id INTEGER PRIMARY KEY DESC, Name TEXT)');
    await raw('CREATE TABLE ra_wr (Id INTEGER PRIMARY KEY, Name TEXT) WITHOUT ROWID');
    await raw('CREATE TABLE ra_wr_default (Id INTEGER PRIMARY KEY DEFAULT (abs(random()) % 1000 + 5000), Name TEXT) WITHOUT ROWID');
    await raw('CREATE TABLE ra_plain (Id INTEGER PRIMARY KEY DEFAULT 42, Name TEXT)');
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('flags the key column of each table shape as SQLite treats it', async () => {
    const flags: Array<[string, boolean | undefined]> = [];
    for (const [table, , key] of SHAPES) {
      flags.push([table, (await driver().tableInfo(table)).find((c) => c.Name === key)?.AutoIncrement]);
    }

    expect(flags).to.deep.eq(SHAPES.map(([table, , , flag]) => [table, flag]));
  });

  it('flags no column of a table without a primary key or of a composite key', async () => {
    await raw('CREATE TABLE ra_nopk (Id INTEGER, Name TEXT)');

    expect((await driver().tableInfo('ra_nopk')).map((c) => c.AutoIncrement)).to.deep.eq([false, false]);
    expect((await driver().tableInfo('ra_s_composite')).map((c) => c.AutoIncrement)).to.deep.eq([false, false]);
  });

  describe('INTEGER PRIMARY KEY DESC, which SQLite does not make a rowid alias', () => {
    it('reports no key for an insert without one, whose row SQLite stores with a NULL key', async () => {
      expect(await insertedKeys(RaDesc, { Name: 'a' })).to.eq(undefined);
      expect(await ids('ra_desc')).to.deep.eq([null]);
    });

    it('leaves the key of a model insert without one null, as the row stores it', async () => {
      const model = new RaDesc({ Name: 'a' });
      await model.insert();

      expect(model.Id).to.eq(null);
      expect(await ids('ra_desc')).to.deep.eq([null]);
    });

    it('stores and reports a supplied key', async () => {
      const model = new RaDesc({ Id: 7, Name: 'a' });
      await model.insert();

      expect(model.Id).to.eq(7);
      expect(await ids('ra_desc')).to.deep.eq([7]);
    });
  });

  describe('WITHOUT ROWID, which has no rowid', () => {
    it('reports no key and keeps the supplied one', async () => {
      const model = new RaWithoutRowid({ Id: 5, Name: 'a' });
      await model.insert();

      expect(model.Id).to.eq(5);
      expect(await insertedKeys(RaWithoutRowid, { Id: 6, Name: 'b' })).to.eq(undefined);
      expect(await ids('ra_wr')).to.deep.eq([5, 6]);
    });

    it('fails before SQLite on an insert without a key', async () => {
      await expect(createQuery(RaWithoutRowid, InsertQueryBuilder).query.values({ Id: null, Name: 'a' })).to.be.rejectedWith(InvalidArgument, 'value column Id cannot be null');
      await expect(new RaWithoutRowid({ Name: 'b' }).insert()).to.be.rejectedWith(InvalidArgument, 'value column Id cannot be null');
      await expect(createQuery(RaWithoutRowidDefault, InsertQueryBuilder).query.values({ Id: null, Name: 'c' })).to.be.rejectedWith(InvalidArgument, 'value column Id cannot be null');
      expect(await ids('ra_wr')).to.deep.eq([]);
      expect(await ids('ra_wr_default')).to.deep.eq([]);
    });

    it('gives a model the key its column default fills', async () => {
      const model = new RaWithoutRowidDefault({ Name: 'a' });
      await model.insert();

      expect(await ids('ra_wr_default')).to.deep.eq([model.Id]);
      expect(model.Id).to.be.within(5000, 5999);
    });

    it('requires the key in the request schema and keeps it in getOrNew()', async () => {
      expect(extractModelDescriptor(RaWithoutRowid)!.Schema).to.have.property('required').that.includes('Id');
      expect((await RaWithoutRowid.getOrNew({ Id: 9, Name: 'a' })).Id).to.eq(9);
    });
  });

  describe('a rowid alias', () => {
    // SQLite ignores the default of a rowid alias; the mapper still reports no key for a column with one.
    it('stores the rowid SQLite fills, not the column default', async () => {
      expect(await insertedKeys(RaPlain, { Name: 'a' })).to.eq(undefined);
      expect(await ids('ra_plain')).to.deep.eq([1]);
      expect((await driver().tableInfo('ra_plain')).find((c) => c.Name === 'Id')!.AutoIncrement).to.eq(true);
    });
  });
});
