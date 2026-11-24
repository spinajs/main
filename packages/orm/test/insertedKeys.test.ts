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
import { WriteObserver, insertedKeys as captureInsertedKeys } from '../src/capture/index.js';
import type { CaptureInterest, CapturedWrite, WriteStatement } from '../src/capture/index.js';
import { FakeSqliteDriver, ormApp } from './misc.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

let RESPONSE: DbServerResponse = { RowsAffected: 0, LastInsertId: 0, Returning: [] };
let INSERTED: string[] = [];
let OBSERVED: CapturedWrite[] | undefined;

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

class RecordingObserver extends WriteObserver {
  interest(statement: WriteStatement): CaptureInterest | undefined {
    return OBSERVED && statement.model === AutoKey ? { columns: '*', transactional: false } : undefined;
  }

  observe(write: CapturedWrite): Promise<void> {
    OBSERVED?.push(write);
    return Promise.resolve();
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
    DRIVER_OWNED_KEYS = false;
    INSERTED = [];
    OBSERVED = undefined;
  });

  useTestApp(() =>
    ormApp({
      register: (c) => {
        c.register(KeysDriver).as('sqlite');
        c.register(DriverOwnedKeysMapper).as(ServerResponseMapper);
        c.register(RecordingObserver).as(WriteObserver);
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

  describe('ServerResponseMapper.insertedKeys by default, without RETURNING rows', () => {
    beforeEach(() => {
      RESPONSE = { RowsAffected: 1, LastInsertId: 7, Returning: [] };
    });

    it('gives no keys for one row, whatever LastInsertId says', () => {
      expect(keysOf(insertOf(AutoKey, [{ Bar: 'a' }]))).to.equal(undefined);
    });

    it('gives no keys for several rows', () => {
      RESPONSE = { RowsAffected: 3, LastInsertId: 10, Returning: [] };
      expect(keysOf(insertOf(AutoKey, [{ Bar: 'a' }, { Bar: 'b' }, { Bar: 'c' }]))).to.equal(undefined);
    });

    it('keeps the key unset after insert()', async () => {
      const model = new AutoKey({ Bar: 'a' });
      await model.insert();
      expect(model.Id).to.equal(null);
    });

    it('keeps the key unset after the static insert', async () => {
      const model = new AutoKey({ Bar: 'a' });
      await AutoKey.insert(model);
      expect(model.Id).to.equal(null);
    });

    it('fails a unit-of-work save', async () => {
      await expect(new AutoKey({ Bar: 'a' }).save()).to.be.rejectedWith(OrmException, /returned no generated key and the model set none itself/);
    });

    it('reaches write observers with unknownKeys', async () => {
      OBSERVED = [];
      await new AutoKey({ Bar: 'a' }).insert();
      expect(OBSERVED.map((w) => [w.kind, w.unknownKeys, w.rows.length])).to.deep.equal([['insert', true, 0]]);
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
      RESPONSE = { RowsAffected: 1, LastInsertId: 7, Returning: [] };
      const parent = new ParentRow({ Bar: 'p' });
      parent.Children.push(new ChildRow({ Bar: 'c' }));
      await expect(parent.save()).to.be.rejectedWith(OrmException, /returned no generated key and the model set none itself/);
      expect(INSERTED).to.deep.equal(['ik_parent']);
    });

    it('writes the reported key onto the children', async () => {
      RESPONSE = { RowsAffected: 1, LastInsertId: 0, Returning: [{ Id: 7 }] };
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

    it('takes its own rule otherwise', () => {
      RESPONSE = { RowsAffected: 1, LastInsertId: 55, Returning: [] };
      expect(keys(insertOf(AutoKey, [{ Bar: 'a' }]))).to.deep.equal([{ Id: 500 }]);
    });
  });
});
