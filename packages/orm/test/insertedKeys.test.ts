import './../src/bootstrap.js';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { useTestApp } from '@spinajs/testing';
import { Orm } from '../src/index.js';
import { createQuery, InsertQueryBuilder } from '../src/builders.js';
import { Connection, HasMany, Model, Primary } from '../src/decorators.js';
import { OrmException } from '../src/exceptions.js';
import { ModelBase } from '../src/model.js';
// A value import: @HasMany reads the relation class from the property's design:type.
import { Relation } from '../src/relation-objects.js';
import { MODELS } from '../src/tokens.js';
import { ServerResponseMapper } from '../src/interfaces.js';
import type { DbServerResponse, IColumnDescriptor } from '../src/interfaces.js';
import { insertedKeys as captureInsertedKeys } from '../src/capture/index.js';
import { FakeSqliteDriver, ormApp } from './misc.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

let RESPONSE: DbServerResponse = { RowsAffected: 0, LastInsertId: 0, Returning: [] };
let FIRST_ID = true;
let MAX_INSERT_ROWS: number | undefined;
let INSERTED: string[] = [];

const column = (Name: string, PrimaryKey: boolean, AutoIncrement: boolean): IColumnDescriptor => ({
  Type: PrimaryKey ? 'INT' : 'VARCHAR',
  MaxLength: 0,
  Comment: '',
  DefaultValue: null,
  NativeType: PrimaryKey ? 'INT' : 'VARCHAR',
  Unsigned: false,
  Nullable: !PrimaryKey,
  PrimaryKey,
  AutoIncrement,
  Name,
  Converter: null,
  Schema: 'sqlite',
  Unique: false,
  Uuid: false,
  Ignore: false,
  IsForeignKey: false,
  ForeignKeyDescription: null,
  Aggregate: false,
  Virtual: false,
});

const TABLES = new Map<string, IColumnDescriptor[]>([
  ['ik_auto', [column('Id', true, true), column('Bar', false, false)]],
  ['ik_plain', [column('Id', true, false), column('Bar', false, false)]],
  ['ik_pair', [column('A', true, false), column('B', true, false), column('Bar', false, false)]],
  ['ik_parent', [column('Id', true, true), column('Bar', false, false)]],
  ['ik_child', [column('Id', true, true), column('ParentId', false, false), column('Bar', false, false)]],
]);

@Connection('sqlite')
@Model('ik_auto')
class AutoKey extends ModelBase<AutoKey> {
  @Primary()
  public Id: number;

  public Bar: string;
}

@Connection('sqlite')
@Model('ik_plain')
class PlainKey extends ModelBase<PlainKey> {
  @Primary()
  public Id: number;

  public Bar: string;
}

@Connection('sqlite')
@Model('ik_pair')
class PairKey extends ModelBase<PairKey> {
  @Primary()
  public A: number;

  @Primary()
  public B: string;

  public Bar: string;
}

@Connection('sqlite')
@Model('ik_child')
class ChildRow extends ModelBase<ChildRow> {
  @Primary()
  public Id: number;

  public ParentId: number;

  public Bar: string;
}

@Connection('sqlite')
@Model('ik_parent')
class ParentRow extends ModelBase<ParentRow> {
  @Primary()
  public Id: number;

  public Bar: string;

  @HasMany(ChildRow, { foreignKey: 'ParentId', primaryKey: 'Id' })
  public Children: Relation<ChildRow, ParentRow>;
}

class KeysDriver extends FakeSqliteDriver {
  constructor(options: ConstructorParameters<typeof FakeSqliteDriver>[0]) {
    super(options);
    // MaxInsertRows is a readonly field fixed at construction; tests change the limit after the driver exists
    Object.defineProperty(this, 'MaxInsertRows', { get: () => MAX_INSERT_ROWS ?? Infinity });
  }

  public supportedFeatures() {
    return { ...super.supportedFeatures(), insertReturning: false, insertIdIsFirstOfBatch: FIRST_ID };
  }

  public async tableInfo(table: string, schema: string): Promise<IColumnDescriptor[]> {
    return TABLES.get(table) ?? (await super.tableInfo(table, schema));
  }

  public execute(builder: InsertQueryBuilder): Promise<DbServerResponse> {
    builder.toDB();
    if (builder instanceof InsertQueryBuilder) INSERTED.push(builder.Table);
    return Promise.resolve(RESPONSE);
  }
}

class PassthroughResponseMapper extends ServerResponseMapper {
  public read(response: Partial<DbServerResponse> | undefined): DbServerResponse {
    return { LastInsertId: response?.LastInsertId ?? 0, RowsAffected: response?.RowsAffected ?? 0, Returning: response?.Returning ?? [] };
  }
}

/** A connection package's composition: RETURNING rows, else its own rule (500 + index), never the legacy one. */
class ReturningThenOwnMapper extends PassthroughResponseMapper {
  public insertedKeys(response: unknown, insert: InsertQueryBuilder): Array<Record<string, unknown>> | undefined {
    return this.returnedKeys(response, insert) ?? insert.Values.map((_, k) => ({ Id: 500 + k }));
  }
}

let DRIVER_OWNED_KEYS = false;

/** With DRIVER_OWNED_KEYS, a connection package's own rule: every row gets 1000 + its index. */
class DriverOwnedKeysMapper extends PassthroughResponseMapper {
  public insertedKeys(response: unknown, insert: InsertQueryBuilder): Array<Record<string, unknown>> | undefined {
    return DRIVER_OWNED_KEYS ? insert.Values.map((_, k) => ({ Id: 1000 + k })) : super.insertedKeys(response, insert);
  }
}

function insertOf<M extends ModelBase>(model: new () => M, rows: Array<Record<string, unknown>>): InsertQueryBuilder {
  const { query } = createQuery(model, InsertQueryBuilder);
  return query.values(rows);
}

const keysOf = (insert: InsertQueryBuilder): Array<Record<string, unknown>> | undefined => insert.Container.resolve(ServerResponseMapper).insertedKeys(RESPONSE, insert);

describe('inserted keys', () => {
  beforeEach(() => {
    RESPONSE = { RowsAffected: 0, LastInsertId: 0, Returning: [] };
    FIRST_ID = true;
    MAX_INSERT_ROWS = undefined;
    DRIVER_OWNED_KEYS = false;
    INSERTED = [];
  });

  useTestApp(() =>
    ormApp({
      register: (c) => {
        c.register(KeysDriver).as('sqlite');
        c.register(DriverOwnedKeysMapper).as(ServerResponseMapper);
      },
      resolve: [Orm],
    }),
  );

  after(() => {
    for (const model of [AutoKey, PlainKey, PairKey, ParentRow, ChildRow]) DI.unregister(MODELS.key, model);
  });

  describe('ServerResponseMapper.insertedKeys by default, from RETURNING rows', () => {
    it('projects a single-column key', () => {
      RESPONSE = { RowsAffected: 2, LastInsertId: 0, Returning: [{ Id: 7, Bar: 'a' }, { Id: 9, Bar: 'b' }] };
      expect(keysOf(insertOf(PlainKey, [{ Bar: 'a' }, { Bar: 'b' }]))).to.deep.equal([{ Id: 7 }, { Id: 9 }]);
    });

    it('projects a composite key', () => {
      RESPONSE = { RowsAffected: 2, LastInsertId: 0, Returning: [{ A: 1, B: 'x', Bar: 'a' }, { A: 2, B: 'y' }] };
      expect(keysOf(insertOf(PairKey, [{ Bar: 'a' }, { Bar: 'b' }]))).to.deep.equal([{ A: 1, B: 'x' }, { A: 2, B: 'y' }]);
    });

    it('a row with a null key part gives no keys', () => {
      RESPONSE = { RowsAffected: 2, LastInsertId: 0, Returning: [{ A: 1, B: 'x' }, { A: 2, B: null }] };
      expect(keysOf(insertOf(PairKey, [{ Bar: 'a' }, { Bar: 'b' }]))).to.equal(undefined);
    });

    it('a row count that differs from the insert gives no keys', () => {
      RESPONSE = { RowsAffected: 2, LastInsertId: 0, Returning: [{ A: 1, B: 'x' }] };
      expect(keysOf(insertOf(PairKey, [{ Bar: 'a' }, { Bar: 'b' }]))).to.equal(undefined);
    });

    it('an insert without a model has no known keys', () => {
      RESPONSE = { RowsAffected: 1, LastInsertId: 3, Returning: [{ Id: 3 }] };
      const insert = DI.get(Orm)!.Connections.get('sqlite')!.insert().into('ik_auto').values({ Bar: 'a' });
      expect(keysOf(insert)).to.equal(undefined);
    });
  });

  describe('ServerResponseMapper.insertedKeys by default, from LastInsertId', () => {
    it('one row of an auto-increment key is the reported id', () => {
      RESPONSE = { RowsAffected: 1, LastInsertId: 55, Returning: [] };
      expect(keysOf(insertOf(AutoKey, [{ Bar: 'a' }]))).to.deep.equal([{ Id: 55 }]);
    });

    it('a key column that is not auto-increment gets nothing from the reported id', () => {
      RESPONSE = { RowsAffected: 1, LastInsertId: 55, Returning: [] };
      expect(keysOf(insertOf(PlainKey, [{ Bar: 'a' }]))).to.equal(undefined);
    });

    it('no reported id gives no keys', () => {
      RESPONSE = { RowsAffected: 1, LastInsertId: 0, Returning: [] };
      expect(keysOf(insertOf(AutoKey, [{ Bar: 'a' }]))).to.equal(undefined);
    });

    it('several rows walk from the first id on a dialect that reports it', () => {
      RESPONSE = { RowsAffected: 3, LastInsertId: 10, Returning: [] };
      expect(keysOf(insertOf(AutoKey, [{ Bar: 'a' }, { Bar: 'b' }, { Bar: 'c' }]))).to.deep.equal([{ Id: 10 }, { Id: 11 }, { Id: 12 }]);
    });

    it('several rows get nothing on a dialect whose id is the last of the batch', () => {
      FIRST_ID = false;
      RESPONSE = { RowsAffected: 3, LastInsertId: 12, Returning: [] };
      expect(keysOf(insertOf(AutoKey, [{ Bar: 'a' }, { Bar: 'b' }, { Bar: 'c' }]))).to.equal(undefined);
    });

    it('several rows of a key that is not auto-increment get nothing', () => {
      RESPONSE = { RowsAffected: 2, LastInsertId: 10, Returning: [] };
      expect(keysOf(insertOf(PlainKey, [{ Bar: 'a' }, { Bar: 'b' }]))).to.equal(undefined);
    });

    it('several rows get nothing when one of them supplied its key', () => {
      RESPONSE = { RowsAffected: 2, LastInsertId: 10, Returning: [] };
      expect(keysOf(insertOf(AutoKey, [{ Id: null, Bar: 'a' }, { Id: 4, Bar: 'b' }]))).to.equal(undefined);
    });

    it('several rows get nothing from INSERT IGNORE', () => {
      RESPONSE = { RowsAffected: 2, LastInsertId: 10, Returning: [] };
      expect(keysOf(insertOf(AutoKey, [{ Bar: 'a' }, { Bar: 'b' }]).orIgnore())).to.equal(undefined);
    });

    it('several rows get nothing when the insert is split into several statements', () => {
      MAX_INSERT_ROWS = 2;
      RESPONSE = { RowsAffected: 3, LastInsertId: 10, Returning: [] };
      expect(keysOf(insertOf(AutoKey, [{ Bar: 'a' }, { Bar: 'b' }, { Bar: 'c' }]))).to.equal(undefined);
    });

    it('several rows get nothing when the server inserted a different number of rows', () => {
      RESPONSE = { RowsAffected: 2, LastInsertId: 10, Returning: [] };
      expect(keysOf(insertOf(AutoKey, [{ Bar: 'a' }, { Bar: 'b' }, { Bar: 'c' }]))).to.equal(undefined);
    });

    it('a composite key gets nothing from the reported id', () => {
      RESPONSE = { RowsAffected: 1, LastInsertId: 10, Returning: [] };
      expect(keysOf(insertOf(PairKey, [{ Bar: 'a' }]))).to.equal(undefined);
    });
  });

  describe('a key column that is not auto-increment, on a dialect without RETURNING', () => {
    beforeEach(() => {
      RESPONSE = { RowsAffected: 1, LastInsertId: 7, Returning: [] };
    });

    it('keeps its key unset after insert()', async () => {
      const model = new PlainKey({ Bar: 'a' });
      await model.insert();
      expect(model.Id).to.equal(null);
    });

    it('keeps its key unset after the static insert', async () => {
      const model = new PlainKey({ Bar: 'a' });
      await PlainKey.insert(model);
      expect(model.Id).to.equal(null);
    });
  });

  describe('a mapper that overrides insertedKeys decides the key', () => {
    beforeEach(() => {
      DRIVER_OWNED_KEYS = true;
      RESPONSE = { RowsAffected: 2, LastInsertId: 55, Returning: [{ Id: 55 }, { Id: 56 }] };
    });

    it('of ModelBase.insert()', async () => {
      const model = new AutoKey({ Bar: 'a' });
      await model.insert();
      expect(model.Id).to.equal(1000);
    });

    it('of the static insert', async () => {
      const models = [new AutoKey({ Bar: 'a' }), new AutoKey({ Bar: 'b' })];
      await AutoKey.insert(models);
      expect(models.map((m) => m.Id)).to.deep.equal([1000, 1001]);
    });

    it('of a unit-of-work save', async () => {
      const model = new AutoKey({ Bar: 'a' });
      await model.save();
      expect(model.Id).to.equal(1000);
    });

    it('of the write capture', () => {
      expect(captureInsertedKeys(insertOf(AutoKey, [{ Bar: 'a' }, { Bar: 'b' }]), RESPONSE, 'Id')).to.deep.equal(['1000', '1001']);
    });
  });
  describe('a unit-of-work save', () => {
    it('fails when the connection reports no key for an auto key, and inserts no child', async () => {
      RESPONSE = { RowsAffected: 1, LastInsertId: 0, Returning: [] };
      const parent = new ParentRow({ Bar: 'p' });
      parent.Children.push(new ChildRow({ Bar: 'c' }));
      await expect(parent.save()).to.be.rejectedWith(OrmException, /returned no generated key and the model set none itself/);
      expect(INSERTED).to.deep.equal(['ik_parent']);
    });

    it('writes the reported key onto the children', async () => {
      RESPONSE = { RowsAffected: 1, LastInsertId: 7, Returning: [] };
      const parent = new ParentRow({ Bar: 'p' });
      const child = new ChildRow({ Bar: 'c' });
      parent.Children.push(child);
      await parent.save();
      expect(INSERTED).to.deep.equal(['ik_parent', 'ik_child']);
      expect(parent.Id).to.equal(7);
      expect(child.ParentId).to.equal(7);
    });
  });

  describe('an override composed from returnedKeys()', () => {
    const keys = (insert: InsertQueryBuilder) => new ReturningThenOwnMapper().insertedKeys(RESPONSE, insert);

    it('takes the RETURNING keys when there are some', () => {
      RESPONSE = { RowsAffected: 2, LastInsertId: 55, Returning: [{ Id: 7 }, { Id: 8 }] };
      expect(keys(insertOf(AutoKey, [{ Bar: 'a' }, { Bar: 'b' }]))).to.deep.equal([{ Id: 7 }, { Id: 8 }]);
    });

    it('takes its own rule otherwise, never the LastInsertId one', () => {
      RESPONSE = { RowsAffected: 1, LastInsertId: 55, Returning: [] };
      expect(keys(insertOf(AutoKey, [{ Bar: 'a' }]))).to.deep.equal([{ Id: 500 }]);
    });
  });
});
