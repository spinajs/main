import 'mocha';
import * as chai from 'chai';
import _ from 'lodash';

import '@spinajs/log';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, InsertQueryBuilder, Model, ModelBase, Orm, OrmDriver, Primary, QueryContext, ServerResponseMapper, WriteObserver, createQuery } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, WriteStatement } from '@spinajs/orm';

import { MsSqlOrmDriver, MsSqlServerResponseMapper } from '../src/index.js';
import { mergeArrays } from './util.js';

const expect = chai.expect;

const CONNECTION = 'mssql-inserted-keys';

type ColumnRow = { COLUMN_NAME: string; DATA_TYPE: string; IS_NULLABLE: string; COLUMN_DEFAULT: string | null; IS_IDENTITY: number };

const column = (COLUMN_NAME: string, DATA_TYPE: string, IS_IDENTITY: number, COLUMN_DEFAULT: string | null = null, IS_NULLABLE = 'NO'): ColumnRow => ({ COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, IS_IDENTITY });

/**
 * What INFORMATION_SCHEMA answers: the key of `ik_guid` is not its identity column, `Seq` is. Its key reads as nullable
 * without a default so that the model sends it empty: the model copies a NEWID() default's text into the key.
 */
const TABLES = new Map<string, ColumnRow[]>([
  ['ik_identity', [column('Id', 'int', 1), column('Name', 'nvarchar', 0)]],
  ['ik_guid', [column('Id', 'uniqueidentifier', 0, null, 'YES'), column('Seq', 'int', 1, null, 'YES'), column('Name', 'nvarchar', 0)]],
]);

/** What `executeOnDb` resolves an insert or upsert with; the shapes `runQuery` produces. */
let RESULT: unknown;
const SENT: string[] = [];
const CAPTURED: CapturedWrite[] = [];

/** The real driver with the server taken out: reflection answers from TABLES, inserts with RESULT. */
class KeysMsSqlDriver extends MsSqlOrmDriver {
  public executeOnDb(stmt: string, params: unknown[], context: QueryContext): Promise<unknown> {
    if (stmt.includes('INFORMATION_SCHEMA.TABLE_CONSTRAINTS')) {
      return Promise.resolve(TABLES.has(String(params[0])) ? [{ COLUMN_NAME: 'Id', CONSTRAINT_TYPE: 'PRIMARY KEY' }] : []);
    }

    if (stmt.includes('INFORMATION_SCHEMA.COLUMNS')) {
      return Promise.resolve(TABLES.get(String(params[0])) ?? []);
    }

    if (context === QueryContext.Insert || context === QueryContext.Upsert) {
      SENT.push(stmt);
      return Promise.resolve(RESULT);
    }

    return Promise.resolve([]);
  }

  public ping(): Promise<boolean> {
    return Promise.resolve(true);
  }

  public connect(): Promise<OrmDriver> {
    return Promise.resolve(this);
  }

  public disconnect(): Promise<OrmDriver> {
    return Promise.resolve(this);
  }
}

class KeysConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        db: { Connections: [{ Driver: 'orm-driver-mssql-keys-fake', Name: CONNECTION, Database: 'test' }] },
      },
      mergeArrays,
    );
  }
}

function defineModels() {
  @Connection(CONNECTION)
  @Model('ik_identity')
  class IdentityRow extends ModelBase<IdentityRow> {
    @Primary()
    public Id: number;

    public Name: string;
  }

  @Connection(CONNECTION)
  @Model('ik_guid')
  class GuidRow extends ModelBase<GuidRow> {
    @Primary()
    public Id: string;

    public Seq: number;

    public Name: string;
  }

  class Recorder extends WriteObserver {
    interest({ model }: WriteStatement): CaptureInterest | undefined {
      return model === IdentityRow ? { columns: ['Name'], transactional: false } : undefined;
    }

    observe(write: CapturedWrite): Promise<void> {
      CAPTURED.push(write);
      return Promise.resolve();
    }
  }

  return { IdentityRow, GuidRow, Recorder };
}

const insertResult = (RowsAffected: number, LastInsertId: unknown) => ({ RowsAffected, LastInsertId, Returning: [] });

describe('mssql inserted keys', function () {
  this.timeout(15000);

  let models: ReturnType<typeof defineModels>;

  const insertOf = (model: typeof ModelBase, rows: Array<Record<string, unknown>>): InsertQueryBuilder => createQuery(model, InsertQueryBuilder).query.values(rows);
  const keysOf = (insert: InsertQueryBuilder, response: unknown) => insert.Container.resolve(ServerResponseMapper).insertedKeys(response, insert);

  before(() => {
    models = defineModels();
  });

  after(() => {
    DI.unregister(models.IdentityRow);
    DI.unregister(models.GuidRow);
    DI.unregister(KeysConf);
    DI.clearCache();
  });

  beforeEach(async () => {
    DI.clearCache();
    SENT.length = 0;
    CAPTURED.length = 0;
    RESULT = undefined;
    DI.register(KeysConf).as(Configuration);
    DI.register(KeysMsSqlDriver).as('orm-driver-mssql-keys-fake');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  describe('the mapper rule', () => {
    it('is the driver mapper', () => {
      expect(insertOf(models.IdentityRow, [{ Name: 'a' }]).Container.resolve(ServerResponseMapper)).to.be.instanceOf(MsSqlServerResponseMapper);
    });

    it('reports the SCOPE_IDENTITY() value of one row whose key is the identity column', () => {
      expect(keysOf(insertOf(models.IdentityRow, [{ Name: 'a' }]), insertResult(1, 7))).to.deep.eq([{ Id: 7 }]);
    });

    it('reports nothing when the key is not the identity column', () => {
      expect(keysOf(insertOf(models.GuidRow, [{ Name: 'a' }]), insertResult(1, 7))).to.eq(undefined);
    });

    it('reports nothing for an id that is not a positive safe integer', () => {
      const insert = insertOf(models.IdentityRow, [{ Name: 'a' }]);

      for (const id of [0, -3, 7.5, 2 ** 53, Number.NaN, '7', null]) {
        expect(keysOf(insert, insertResult(1, id)), String(id)).to.eq(undefined);
      }
    });

    it('reads the key of a plain insert without checking its row count', () => {
      expect(keysOf(insertOf(models.IdentityRow, [{ Name: 'a' }]), insertResult(2, 7))).to.deep.eq([{ Id: 7 }]);
    });

    it('takes no key from RETURNING rows, which SQL Server never sends', () => {
      expect(keysOf(insertOf(models.IdentityRow, [{ Name: 'a' }]), { RowsAffected: 1, LastInsertId: 0, Returning: [{ Id: 5 }] })).to.eq(undefined);
    });

    it('reports the key of an orIgnore() row that was inserted, and nothing for one that was skipped', () => {
      const insert = insertOf(models.IdentityRow, [{ Name: 'a' }]).orIgnore();

      expect(keysOf(insert, insertResult(1, 7))).to.deep.eq([{ Id: 7 }]);
      expect(keysOf(insert, insertResult(0, 0))).to.eq(undefined);
      expect(keysOf(insert, insertResult(0, 7))).to.eq(undefined);
    });

    it('reports nothing for an upsert, whether MERGE inserted or updated', () => {
      const insert = insertOf(models.IdentityRow, [{ Name: 'a' }]);
      insert.onDuplicate('Name').update(['Name']);

      expect(keysOf(insert, [{ ID: 9 }])).to.eq(undefined);
      expect(keysOf(insert, [{ ID: null }])).to.eq(undefined);
    });

    it('reports nothing for several rows: SCOPE_IDENTITY() is the last identity only', () => {
      expect(keysOf(insertOf(models.IdentityRow, [{ Name: 'a' }, { Name: 'b' }]), insertResult(2, 8))).to.eq(undefined);
    });

    it('reports nothing for an insert without a model', () => {
      const driver = DI.get(Orm)!.Connections.get(CONNECTION)!;
      const insert = driver.insert().into('ik_identity').values({ Name: 'a' });

      expect(keysOf(insert, insertResult(1, 7))).to.eq(undefined);
    });
  });

  describe('callers', () => {
    it('sends the identity read with the insert', async () => {
      RESULT = insertResult(1, 41);
      await new models.IdentityRow({ Name: 'a' }).insert();

      expect(SENT).to.have.lengthOf(1);
      expect(SENT[0]).to.match(/; SELECT SCOPE_IDENTITY\(\) as ID, @@ROWCOUNT as INSERTED;$/);
    });

    it('ModelBase.insert backfills an identity key', async () => {
      RESULT = insertResult(1, 41);
      const row = new models.IdentityRow({ Name: 'a' });
      await row.insert();

      expect(row.Id).to.eq(41);
    });

    it('ModelBase.insert leaves a key that is not the identity column empty', async () => {
      RESULT = insertResult(1, 41);
      const row = new models.GuidRow({ Name: 'a' });
      await row.insert();

      expect(row.Id ?? null).to.eq(null);
    });

    it('the static insert leaves the keys of several rows empty', async () => {
      RESULT = insertResult(2, 42);
      const rows = [new models.IdentityRow({ Name: 'a' }), new models.IdentityRow({ Name: 'b' })];
      await models.IdentityRow.insert(rows);

      expect(rows.map((r) => r.Id ?? null)).to.deep.eq([null, null]);
    });

    describe('write capture', () => {
      beforeEach(() => {
        DI.register(models.Recorder).as(WriteObserver);
      });

      afterEach(() => {
        DI.unregister(models.Recorder);
      });

      it('reports the keys of a multi-row insert as unknown', async () => {
        RESULT = insertResult(2, 42);
        await models.IdentityRow.insert([new models.IdentityRow({ Name: 'a' }), new models.IdentityRow({ Name: 'b' })]);

        expect(CAPTURED).to.have.lengthOf(1);
        expect(CAPTURED[0].unknownKeys).to.eq(true);
        expect(CAPTURED[0].rows).to.deep.eq([]);
      });

      it('knows the key of a single-row insert', async () => {
        RESULT = insertResult(1, 41);
        await new models.IdentityRow({ Name: 'a' }).insert();

        expect(CAPTURED).to.have.lengthOf(1);
        expect(CAPTURED[0].unknownKeys).to.eq(false);
      });
    });
  });
});
