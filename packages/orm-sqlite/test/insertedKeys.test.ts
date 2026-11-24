import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import { Connection, InsertQueryBuilder, Model, ModelBase, Orm, Primary, ServerResponseMapper, createQuery } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import sinon from 'sinon';
import '@spinajs/log';
import { SqliteOrmDriver } from './../src/index.js';
import { ConnectionConf, db, migrations } from './common.js';
import { AssignedKeyModel } from './models/AssignedKeyModel.js';
import { UuidKeyModel } from './models/UuidKeyModel.js';

import './migrations/TestMigration_2022_02_08_01_13_00.js';

@Connection('sqlite')
@Model('ik_row')
class IkRow extends ModelBase {
  @Primary()
  public Id: number;

  public Email: string;

  public Name: string;
}

@Connection('sqlite')
@Model('ik_trig')
class IkTrig extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('sqlite')
@Model('ik_wr')
class IkWithoutRowid extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('sqlite')
@Model('ik_wr_default')
class IkWithoutRowidDefault extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('sqlite')
@Model('ik_text')
class IkText extends ModelBase {
  @Primary()
  public Id: string;

  public Name: string;
}

@Connection('sqlite')
@Model('ik_pair')
class IkPair extends ModelBase {
  @Primary()
  public A: number;

  @Primary()
  public B: number;
}

type Row = Record<string, unknown>;
type Keys = Row[] | undefined;
type Configure = (insert: InsertQueryBuilder) => unknown;

const SCHEMA = [
  'CREATE TABLE ik_row (Id INTEGER PRIMARY KEY, Email TEXT UNIQUE, Name TEXT)',
  'CREATE TABLE ik_trig (Id INTEGER PRIMARY KEY, Name TEXT)',
  'CREATE TABLE ik_log (Id INTEGER PRIMARY KEY, Note TEXT)',
  "INSERT INTO ik_log (Id, Note) VALUES (100, 'seed')",
  "CREATE TRIGGER ik_trig_ai AFTER INSERT ON ik_trig BEGIN INSERT INTO ik_log (Note) VALUES ('logged'); END",
  'CREATE TABLE ik_wr (Id INTEGER PRIMARY KEY, Name TEXT) WITHOUT ROWID',
  'CREATE TABLE ik_wr_default (Id INTEGER PRIMARY KEY DEFAULT (abs(random()) % 1000 + 5000), Name TEXT) WITHOUT ROWID',
  'CREATE TABLE ik_text (Id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))), Name TEXT)',
  'CREATE TABLE ik_pair (A INTEGER, B INTEGER, PRIMARY KEY (A, B))',
];

const packet = (RowsAffected: number, LastInsertId: number, Returning: Row[] = []) => ({ RowsAffected, LastInsertId, Returning });

function builder(model: typeof ModelBase | undefined, values: Row | Row[], configure?: Configure): InsertQueryBuilder {
  const insert = model ? createQuery(model, InsertQueryBuilder).query : db().Connections.get('sqlite')!.insert().into('ik_row');
  insert.values(values);
  configure?.(insert);
  return insert;
}

const mapperOf = (insert: InsertQueryBuilder) => insert.Container.resolve(ServerResponseMapper);

function keysOf(response: unknown, model: typeof ModelBase | undefined, values: Row | Row[], configure?: Configure): Keys {
  const insert = builder(model, values, configure);
  return mapperOf(insert).insertedKeys(response, insert);
}

/** Runs the insert on the database and asks the mapper for its keys. */
async function inserted(model: typeof ModelBase | undefined, values: Row | Row[], configure?: Configure): Promise<{ keys: Keys; response: unknown }> {
  const insert = builder(model, values, configure);
  const response: unknown = await insert;
  return { keys: mapperOf(insert).insertedKeys(response, insert), response };
}

const raw = async (table: string) => await db().Connections.get('sqlite')!.select().from(table).asRaw<Row[]>();

describe('Sqlite - inserted keys', function () {
  this.timeout(15000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }

    await DI.resolve(Orm);
    await (await migrations()).up();
    for (const sql of SCHEMA) {
      await db().Connections.get('sqlite')!.schema().raw(sql);
    }
    await db().reloadTableInfo();
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  describe('the mapper', () => {
    it('takes the keys of RETURNING rows first', () => {
      expect(keysOf(packet(2, 0, [{ Id: 4, Name: 'a' }, { Id: 5, Name: 'b' }]), IkRow, [{ Name: 'a' }, { Name: 'b' }])).to.deep.eq([{ Id: 4 }, { Id: 5 }]);
      expect(keysOf(packet(1, 3, [{ Id: 9 }]), IkRow, { Name: 'a' })).to.deep.eq([{ Id: 9 }]);
      expect(keysOf(packet(2, 0, [{ Id: 'k1' }, { Id: 'k2' }]), IkText, [{ Name: 'a' }, { Name: 'b' }])).to.deep.eq([{ Id: 'k1' }, { Id: 'k2' }]);
    });

    it('reads lastID for one row the statement wrote through the rowid alias', () => {
      expect(keysOf(packet(1, 7), IkRow, { Name: 'a' })).to.deep.eq([{ Id: 7 }]);
      expect(keysOf(packet(1, 7), IkRow, { Name: 'a' }, (q) => q.orIgnore())).to.deep.eq([{ Id: 7 }]);
      expect(keysOf(packet(1, 7), IkRow, { Name: 'a' }, (q) => q.orReplace())).to.deep.eq([{ Id: 7 }]);
    });

    it('reports no key for an insert that wrote no row', () => {
      expect(keysOf({ LastInsertId: 7, RowsAffected: 0 }, IkRow, { Name: 'a' })).to.eq(undefined);
      expect(keysOf(packet(0, 7), IkRow, { Name: 'a' }, (q) => q.orIgnore())).to.eq(undefined);
    });

    it('reports no key for a lastID that is not a positive safe integer', () => {
      for (const id of [0, -3, 2 ** 53, 1.5, Number.NaN]) {
        expect(keysOf(packet(1, id), IkRow, { Name: 'a' }), String(id)).to.eq(undefined);
      }
    });

    it('reports no keys for several rows without RETURNING rows', () => {
      expect(keysOf(packet(2, 8), IkRow, [{ Name: 'a' }, { Name: 'b' }])).to.eq(undefined);
      expect(keysOf(packet(2, 8, [{ Id: 8 }]), IkRow, [{ Name: 'a' }, { Name: 'b' }])).to.eq(undefined);
    });

    it('reports no key for an upsert without its RETURNING rows', () => {
      expect(keysOf(packet(1, 7), IkRow, { Email: 'a', Name: 'a' }, (q) => q.onDuplicate('Email').update(['Name']))).to.eq(undefined);
    });

    it('reports no key for a key that is not the rowid alias', () => {
      expect(keysOf(packet(1, 7), IkText, { Name: 'a' })).to.eq(undefined);
      expect(keysOf(packet(1, 7), UuidKeyModel, { Name: 'a' })).to.eq(undefined);
      expect(keysOf(packet(1, 7), AssignedKeyModel, { Name: 'a' })).to.eq(undefined);
      expect(keysOf(packet(1, 7), IkPair, { A: 1, B: 2 })).to.eq(undefined);
    });

    it('reports no key for an insert without a model', () => {
      expect(keysOf(packet(1, 7), undefined, { Name: 'a' })).to.eq(undefined);
    });

    it('reports a supplied key only when lastID names it', () => {
      expect(keysOf(packet(1, 7), IkRow, { Id: 7, Name: 'a' })).to.deep.eq([{ Id: 7 }]);
      expect(keysOf(packet(1, 3), IkWithoutRowid, { Id: 7, Name: 'a' })).to.eq(undefined);
      expect(keysOf(packet(1, 7), IkRow, { Id: '7', Name: 'a' })).to.eq(undefined);
    });

    it('reports no key for a key the column default fills', () => {
      expect(keysOf(packet(1, 3), IkWithoutRowidDefault, { Name: 'a' })).to.eq(undefined);
    });
  });

  describe('on the database', () => {
    it('reports the key of a plain insert and of an OR IGNORE insert that inserted', async () => {
      expect((await inserted(IkRow, { Email: 'a', Name: 'one' })).keys).to.deep.eq([{ Id: 1 }]);
      expect((await inserted(IkRow, { Email: 'b', Name: 'two' }, (q) => q.orIgnore())).keys).to.deep.eq([{ Id: 2 }]);
    });

    it('reports no key for an OR IGNORE insert that skipped its row after an earlier insert on the connection', async () => {
      await inserted(IkRow, { Email: 'a', Name: 'one' });
      await inserted(IkRow, { Email: 'b', Name: 'two' });

      const skipped = await inserted(IkRow, { Email: 'a', Name: 'dup' }, (q) => q.orIgnore());

      expect(skipped.response).to.deep.eq(packet(0, 2));
      expect(skipped.keys).to.eq(undefined);
    });

    it('reports the new row of an OR REPLACE that replaced an existing row and of one that inserted', async () => {
      await inserted(IkRow, { Email: 'a', Name: 'one' });
      await inserted(IkRow, { Email: 'b', Name: 'two' });

      expect((await inserted(IkRow, { Email: 'a', Name: 'replaced' }, (q) => q.orReplace())).keys).to.deep.eq([{ Id: 3 }]);
      expect((await inserted(IkRow, { Email: 'c', Name: 'new' }, (q) => q.orReplace())).keys).to.deep.eq([{ Id: 4 }]);
      expect((await raw('ik_row')).map((r) => [r.Id, r.Email])).to.deep.eq([
        [2, 'b'],
        [3, 'a'],
        [4, 'c'],
      ]);
    });

    it("reports the statement's row, not the row its AFTER INSERT trigger inserted elsewhere", async () => {
      expect((await inserted(IkTrig, { Name: 'a' })).keys).to.deep.eq([{ Id: 1 }]);
      expect((await raw('ik_log')).map((r) => r.Id)).to.deep.eq([100, 101]);
    });

    it('reports no key for a WITHOUT ROWID table, whose INTEGER PRIMARY KEY lastID does not name', async () => {
      await inserted(IkRow, { Email: 'a', Name: 'one' });

      const supplied = await inserted(IkWithoutRowid, { Id: 5, Name: 'x' });
      const filled = await inserted(IkWithoutRowidDefault, { Name: 'y' });

      expect([supplied.response, filled.response]).to.deep.eq([packet(1, 1), packet(1, 1)]);
      expect([supplied.keys, filled.keys]).to.deep.eq([undefined, undefined]);
      expect((await raw('ik_wr_default'))[0].Id).to.be.within(5000, 5999);
    });

    it('reports no key for a text key the database fills, though lastID names the rowid', async () => {
      const filled = await inserted(IkText, { Name: 'a' });

      expect(filled.response).to.deep.eq(packet(1, 1));
      expect(filled.keys).to.eq(undefined);
    });

    it('reports no keys for a multi-row insert without RETURNING, and every key with it', async () => {
      expect((await inserted(IkRow, [{ Name: 'a' }, { Name: 'b' }])).keys).to.eq(undefined);
      expect((await inserted(IkRow, [{ Name: 'c' }, { Name: 'd' }], (q) => q.returning(['Id']))).keys).to.deep.eq([{ Id: 3 }, { Id: 4 }]);
    });

    it('does not reach the core rule', async () => {
      sinon.stub(ServerResponseMapper.prototype, 'insertedKeys').throws(new Error('core insertedKeys called'));

      expect((await inserted(IkRow, { Email: 'a', Name: 'one' })).keys).to.deep.eq([{ Id: 1 }]);
      expect((await inserted(IkRow, { Email: 'a', Name: 'dup' }, (q) => q.orIgnore())).keys).to.eq(undefined);

      const model = new IkRow({ Email: 'b', Name: 'two' });
      await model.insert();
      expect(model.Id).to.eq(2);
    });
  });
});
