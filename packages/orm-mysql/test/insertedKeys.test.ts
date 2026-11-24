import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { extractModelDescriptor, InsertQueryBuilder, Model, ModelBase, Primary, ServerResponseMapper } from '@spinajs/orm';
import type { IColumnDescriptor, ISupportedFeature } from '@spinajs/orm';

import { MySqlOrmDriver } from '../src/index.js';
import { reportedAutoIncrementStep } from '../src/inserted-keys.js';

const column = (Name: string, PrimaryKey: boolean, AutoIncrement: boolean): IColumnDescriptor => ({
  Type: PrimaryKey ? 'int' : 'varchar',
  MaxLength: -1,
  Comment: '',
  DefaultValue: null,
  NativeType: PrimaryKey ? 'int' : 'varchar',
  Unsigned: false,
  Nullable: !PrimaryKey,
  PrimaryKey,
  AutoIncrement,
  Name,
  Converter: null,
  Schema: 'test',
  Unique: false,
  Uuid: false,
  Ignore: false,
  IsForeignKey: false,
  ForeignKeyDescription: null,
  Aggregate: false,
  Virtual: false,
});

@Model('ik_auto')
class AutoKey extends ModelBase<AutoKey> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Model('ik_counter')
class CounterKey extends ModelBase<CounterKey> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Model('ik_assigned')
class AssignedKey extends ModelBase<AssignedKey> {
  @Primary({ generated: 'assigned' })
  public Id: number;

  public Name: string;
}

@Model('ik_pair')
class PairKey extends ModelBase<PairKey> {
  @Primary()
  public A: number;

  @Primary()
  public B: number;

  public Name: string;
}

extractModelDescriptor(AutoKey)!.Columns = [column('Id', true, true), column('Name', false, false)];
extractModelDescriptor(CounterKey)!.Columns = [column('Id', true, false), column('Name', false, false)];
extractModelDescriptor(AssignedKey)!.Columns = [column('Id', true, true), column('Name', false, false)];
extractModelDescriptor(PairKey)!.Columns = [column('A', true, true), column('B', true, false), column('Name', false, false)];

class TwoRowMySqlDriver extends MySqlOrmDriver {
  public readonly MaxInsertRows: number = 2;
}

class NoFirstOfBatchMySqlDriver extends MySqlOrmDriver {
  public supportedFeatures(): ISupportedFeature {
    return { ...super.supportedFeatures(), insertIdIsFirstOfBatch: false };
  }
}

type Driver = typeof MySqlOrmDriver;
type Row = Record<string, unknown>;

const packet = (RowsAffected: number, LastInsertId: number, AutoIncrementStep?: number) => ({ RowsAffected, LastInsertId, Returning: [], ...(AutoIncrementStep === undefined ? {} : { AutoIncrementStep }) });
const rows = (count: number, row: (k: number) => Row = () => ({ Name: 'n' })) => Array.from({ length: count }, (_, k) => row(k));

describe('mysql inserted keys', function () {
  this.timeout(15000);

  afterEach(() => {
    DI.clearCache();
  });

  // a builder is thenable: returned from an async function it would be awaited, and run
  async function insertOf(model: typeof ModelBase | undefined, values: Row[], type: Driver = MySqlOrmDriver): Promise<{ insert: InsertQueryBuilder }> {
    const driver = await DI.resolve(type, [{ Name: 'mysql-keys-test', Driver: 'orm-driver-mysql' }]);
    return { insert: driver.Container.resolve(InsertQueryBuilder, [driver, model]).into('t').values(values) };
  }

  async function keysOf(response: unknown, model: typeof ModelBase | undefined, values: Row[], configure?: (insert: InsertQueryBuilder) => unknown, type: Driver = MySqlOrmDriver) {
    const { insert } = await insertOf(model, values, type);
    configure?.(insert);
    return insert.Container.resolve(ServerResponseMapper).insertedKeys(response, insert);
  }

  describe('one row', () => {
    it('is the insert id of a plain insert that wrote one row', async () => {
      expect(await keysOf(packet(1, 7), AutoKey, rows(1))).to.deep.eq([{ Id: 7 }]);
    });

    it('is unknown for a key that is not auto-increment, not generated, or not a single column', async () => {
      expect(await keysOf(packet(1, 7), CounterKey, rows(1))).to.eq(undefined);
      expect(await keysOf(packet(1, 7), AssignedKey, rows(1))).to.eq(undefined);
      expect(await keysOf(packet(1, 7), PairKey, rows(1))).to.eq(undefined);
    });

    it('is unknown without a model', async () => {
      expect(await keysOf(packet(1, 7), undefined, rows(1))).to.eq(undefined);
    });

    it('is unknown when the insert id is not a positive safe integer', async () => {
      expect(await keysOf(packet(1, 0), AutoKey, rows(1))).to.eq(undefined);
      expect(await keysOf(packet(1, -3), AutoKey, rows(1))).to.eq(undefined);
      expect(await keysOf(packet(1, 2 ** 53), AutoKey, rows(1))).to.eq(undefined);
      expect(await keysOf({ RowsAffected: 1, LastInsertId: '9007199254740993' }, AutoKey, rows(1))).to.eq(undefined);
      expect(await keysOf(undefined, AutoKey, rows(1))).to.eq(undefined);
    });

    it('is unknown when a plain insert reports another row count', async () => {
      expect(await keysOf(packet(0, 7), AutoKey, rows(1))).to.eq(undefined);
      expect(await keysOf(packet(2, 7), AutoKey, rows(1))).to.eq(undefined);
    });

    it('is the insert id of an INSERT IGNORE that inserted, unknown for one that skipped the row', async () => {
      expect(await keysOf(packet(1, 7), AutoKey, rows(1), (i) => i.orIgnore())).to.deep.eq([{ Id: 7 }]);
      expect(await keysOf(packet(0, 0), AutoKey, rows(1), (i) => i.orIgnore())).to.eq(undefined);
    });

    it('is the insert id of the row a REPLACE wrote, whether it deleted rows or not', async () => {
      expect(await keysOf(packet(1, 7), AutoKey, rows(1), (i) => i.orReplace())).to.deep.eq([{ Id: 7 }]);
      expect(await keysOf(packet(2, 8), AutoKey, rows(1), (i) => i.orReplace())).to.deep.eq([{ Id: 8 }]);
      expect(await keysOf(packet(3, 9), AutoKey, rows(1), (i) => i.orReplace())).to.deep.eq([{ Id: 9 }]);
      expect(await keysOf(packet(0, 0), AutoKey, rows(1), (i) => i.orReplace())).to.eq(undefined);
    });

    it('is the key of the row ON DUPLICATE KEY UPDATE inserted or updated, unknown for one it left unchanged', async () => {
      expect(await keysOf(packet(1, 7), AutoKey, rows(1), (i) => i.onDuplicate().update(['Name']))).to.deep.eq([{ Id: 7 }]);
      expect(await keysOf(packet(2, 3), AutoKey, rows(1), (i) => i.onDuplicate().update(['Name']))).to.deep.eq([{ Id: 3 }]);
      // unchanged: 1 with mysql2's default FOUND_ROWS flag, 0 without it; the insert id is 0 either way
      expect(await keysOf(packet(1, 0), AutoKey, rows(1), (i) => i.onDuplicate().update(['Name']))).to.eq(undefined);
      expect(await keysOf(packet(0, 0), AutoKey, rows(1), (i) => i.onDuplicate().update(['Name']))).to.eq(undefined);
    });

    it('is unknown for INSERT IGNORE ... ON DUPLICATE KEY UPDATE', async () => {
      expect(
        await keysOf(packet(1, 7), AutoKey, rows(1), (i) => {
          i.orIgnore();
          i.onDuplicate().update(['Name']);
        }),
      ).to.eq(undefined);
    });

    it('needs no step', async () => {
      expect(await keysOf(packet(1, 7), AutoKey, rows(1))).to.deep.eq([{ Id: 7 }]);
    });
  });

  describe('several rows', () => {
    it('walks the block from the first id by the step of the connection', async () => {
      expect(await keysOf(packet(3, 10, 1), AutoKey, rows(3))).to.deep.eq([{ Id: 10 }, { Id: 11 }, { Id: 12 }]);
      expect(await keysOf(packet(3, 22, 3), AutoKey, rows(3))).to.deep.eq([{ Id: 22 }, { Id: 25 }, { Id: 28 }]);
    });

    it('is unknown when the step of the connection is not known', async () => {
      expect(await keysOf(packet(3, 10), AutoKey, rows(3))).to.eq(undefined);
      expect(await keysOf({ ...packet(3, 10), AutoIncrementStep: 0 }, AutoKey, rows(3))).to.eq(undefined);
      expect(await keysOf({ ...packet(3, 10), AutoIncrementStep: '2' }, AutoKey, rows(3))).to.eq(undefined);
    });

    it('is unknown for a key that is not auto-increment', async () => {
      expect(await keysOf(packet(3, 10, 1), CounterKey, rows(3))).to.eq(undefined);
      expect(await keysOf(packet(3, 10, 1), AssignedKey, rows(3))).to.eq(undefined);
      expect(await keysOf(packet(3, 10, 1), PairKey, rows(3))).to.eq(undefined);
    });

    it('is unknown when a row supplied its key', async () => {
      expect(await keysOf(packet(3, 10, 1), AutoKey, rows(3, (k) => ({ Id: k === 1 ? 500 : null, Name: 'n' })))).to.eq(undefined);
    });

    it('is unknown when the affected rows are not the rows sent', async () => {
      expect(await keysOf(packet(2, 10, 1), AutoKey, rows(3))).to.eq(undefined);
      expect(await keysOf(packet(4, 10, 1), AutoKey, rows(3))).to.eq(undefined);
    });

    it('is unknown for INSERT IGNORE, REPLACE and ON DUPLICATE KEY UPDATE', async () => {
      expect(await keysOf(packet(3, 10, 1), AutoKey, rows(3), (i) => i.orIgnore())).to.eq(undefined);
      expect(await keysOf(packet(3, 10, 1), AutoKey, rows(3), (i) => i.orReplace())).to.eq(undefined);
      expect(await keysOf(packet(3, 10, 1), AutoKey, rows(3), (i) => i.onDuplicate().update(['Name']))).to.eq(undefined);
    });

    it('is unknown for an insert split into several statements', async () => {
      const { insert } = await insertOf(AutoKey, rows(3), TwoRowMySqlDriver);
      expect(insert.splitByDriverLimits()).to.have.length(2);

      expect(insert.Container.resolve(ServerResponseMapper).insertedKeys(packet(3, 10, 1), insert)).to.eq(undefined);
    });

    it('is unknown when the last key of the walk is not a safe integer', async () => {
      expect(await keysOf(packet(3, 2 ** 53 - 2, 1), AutoKey, rows(3))).to.eq(undefined);
    });
  });

  it('does not depend on the insertIdIsFirstOfBatch flag', async () => {
    const cases: Array<[unknown, Row[]]> = [
      [packet(1, 7), rows(1)],
      [packet(3, 10, 1), rows(3)],
      [packet(3, 22, 3), rows(3)],
      [packet(3, 10), rows(3)],
      [packet(2, 10, 1), rows(3)],
    ];

    for (const [response, values] of cases) {
      expect(await keysOf(response, AutoKey, values, undefined, NoFirstOfBatchMySqlDriver)).to.deep.eq(await keysOf(response, AutoKey, values));
    }
    expect(await keysOf(packet(3, 10, 1), AutoKey, rows(3), undefined, NoFirstOfBatchMySqlDriver)).to.deep.eq([{ Id: 10 }, { Id: 11 }, { Id: 12 }]);
  });

  describe('the step a statement reports', () => {
    const ok = (systemVariables: Record<string, string> | undefined) => ({ affectedRows: 0, insertId: 0, ...(systemVariables ? { stateChanges: { systemVariables, schema: null, gtids: [], trackStateChange: null } } : {}) });

    it('reads auto_increment_increment from the session state of an OK packet', () => {
      expect(reportedAutoIncrementStep(ok({ auto_increment_increment: '3' }))).to.eq(3);
      expect(reportedAutoIncrementStep([[{ a: 1 }], ok({ auto_increment_increment: '2', statement_id: '9' })])).to.eq(2);
    });

    it('is undefined when the statement reports no step, null when it reports one that is unusable', () => {
      expect(reportedAutoIncrementStep(ok(undefined))).to.eq(undefined);
      expect(reportedAutoIncrementStep(ok({ time_zone: '+00:00' }))).to.eq(undefined);
      expect(reportedAutoIncrementStep([{ Id: 1 }])).to.eq(undefined);
      expect(reportedAutoIncrementStep(undefined)).to.eq(undefined);
      expect(reportedAutoIncrementStep(ok({ auto_increment_increment: 'x' }))).to.eq(null);
      expect(reportedAutoIncrementStep(ok({ auto_increment_increment: '0' }))).to.eq(null);
    });
  });
});
