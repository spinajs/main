import 'mocha';
import * as chai from 'chai';
import _ from 'lodash';

import '@spinajs/log';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, InsertQueryBuilder, Model, ModelBase, Orm, OrmDriver, Primary, QueryContext, RawQuery, ServerResponseMapper, WriteObserver, createQuery } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, WriteStatement } from '@spinajs/orm';

import { MsSqlOrmDriver, MsSqlServerResponseMapper, toNamedParameters } from '../src/index.js';
import { mergeArrays } from './util.js';

const expect = chai.expect;

const CONNECTION = 'mssql-inserted-keys';

type ColumnRow = { COLUMN_NAME: string; DATA_TYPE: string; IS_NULLABLE: string; COLUMN_DEFAULT: string | null; IS_IDENTITY: number };

const column = (COLUMN_NAME: string, DATA_TYPE: string, IS_IDENTITY: number, COLUMN_DEFAULT: string | null = null, IS_NULLABLE = 'NO'): ColumnRow => ({ COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, IS_IDENTITY });

/** What INFORMATION_SCHEMA answers: the key of `ik_guid` is not its identity column, `Seq` is. */
const TABLES = new Map<string, ColumnRow[]>([
  ['ik_identity', [column('Id', 'int', 1), column('Name', 'nvarchar', 0), column('Code', 'nvarchar', 0, null, 'YES'), column('Amount', 'int', 0, null, 'YES')]],
  ['ik_guid', [column('Id', 'uniqueidentifier', 0, '(newid())'), column('Seq', 'int', 1, null, 'YES'), column('Name', 'nvarchar', 0)]],
  ['ik_big', [column('Id', 'bigint', 1), column('Name', 'nvarchar', 0)]],
  ['ik_pair', [column('Tenant', 'int', 0, '((7))'), column('Id', 'int', 1), column('Name', 'nvarchar', 0)]],
  ['ik_node', [column('Id', 'hierarchyid', 0), column('Name', 'nvarchar', 0)]],
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

  @Connection(CONNECTION)
  @Model('ik_big')
  class BigRow extends ModelBase<BigRow> {
    @Primary()
    public Id: number;

    public Name: string;
  }

  @Connection(CONNECTION)
  @Model('ik_pair')
  class PairRow extends ModelBase<PairRow> {
    @Primary()
    public Tenant: number;

    @Primary()
    public Id: number;

    public Name: string;
  }

  @Connection(CONNECTION)
  @Model('ik_node')
  class NodeRow extends ModelBase<NodeRow> {
    @Primary()
    public Id: string;

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

  return { IdentityRow, GuidRow, BigRow, PairRow, NodeRow, Recorder };
}

const insertResult = (RowsAffected: number, LastInsertId: unknown, InsertedKeys?: unknown[]) => ({ RowsAffected, LastInsertId, Returning: [], ...(InsertedKeys ? { InsertedKeys } : {}) });

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
    DI.unregister(models.BigRow);
    DI.unregister(models.PairRow);
    DI.unregister(models.NodeRow);
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

    it('reports the key the batch output for one row, whatever generated it', () => {
      expect(keysOf(insertOf(models.IdentityRow, [{ Name: 'a' }]), insertResult(1, 7, [{ Id: 7 }]))).to.deep.eq([{ Id: 7 }]);
      expect(keysOf(insertOf(models.GuidRow, [{ Name: 'a' }]), insertResult(1, 100, [{ Id: 'A1B2' }]))).to.deep.eq([{ Id: 'A1B2' }]);
      expect(keysOf(insertOf(models.IdentityRow, [{ Name: 'a' }]), insertResult(1, 0, [{ Id: 0 }]))).to.deep.eq([{ Id: 0 }]);
    });

    it('reports nothing without exactly one output row: a skipped orIgnore() row, a MERGE that matched several rows, no OUTPUT', () => {
      const insert = insertOf(models.IdentityRow, [{ Name: 'a' }]);

      expect(keysOf(insert, insertResult(0, 0, []))).to.eq(undefined);
      expect(keysOf(insert, insertResult(2, 7, [{ Id: 7 }, { Id: 8 }]))).to.eq(undefined);
      expect(keysOf(insert, insertResult(2, 7, [{ Id: 7 }]))).to.eq(undefined);
      expect(keysOf(insert, insertResult(1, 7))).to.eq(undefined);
      expect(keysOf(insert, [{ ID: 7 }])).to.eq(undefined);
    });

    it('reports nothing for a key value that is missing or not exact', () => {
      const insert = insertOf(models.IdentityRow, [{ Name: 'a' }]);

      for (const id of [null, undefined, 7.5, 2 ** 53]) {
        expect(keysOf(insert, insertResult(1, 0, [{ Id: id }])), String(id)).to.eq(undefined);
      }
    });

    it('reports a bigint key, which arrives as text, as a number within the safe range only', () => {
      const insert = insertOf(models.BigRow, [{ Name: 'a' }]);

      expect(keysOf(insert, insertResult(1, 0, [{ Id: '42' }]))).to.deep.eq([{ Id: 42 }]);
      expect(keysOf(insert, insertResult(1, 0, [{ Id: '9007199254740993' }]))).to.eq(undefined);
    });

    it('reports a composite key only with every part', () => {
      const insert = insertOf(models.PairRow, [{ Name: 'a' }]);

      expect(keysOf(insert, insertResult(1, 3, [{ Tenant: 7, Id: 3 }]))).to.deep.eq([{ Tenant: 7, Id: 3 }]);
      expect(keysOf(insert, insertResult(1, 3, [{ Tenant: null, Id: 3 }]))).to.eq(undefined);
    });

    it('reports nothing for several rows: SQL Server does not promise OUTPUT rows in VALUES order', () => {
      expect(keysOf(insertOf(models.IdentityRow, [{ Name: 'a' }, { Name: 'b' }]), insertResult(2, 8, [{ Id: 7 }, { Id: 8 }]))).to.eq(undefined);
    });

    it('reports nothing for an insert without a model', () => {
      const driver = DI.get(Orm)!.Connections.get(CONNECTION)!;
      const insert = driver.insert().into('ik_identity').values({ Name: 'a' });

      expect(keysOf(insert, insertResult(1, 7, [{ Id: 7 }]))).to.eq(undefined);
    });
  });

  describe('the compiled batch', () => {
    const sqlOf = (insert: InsertQueryBuilder) => insert.toDB().expression;
    const table = '[test].[ik_identity]';
    const insert = (out: string, value = '?') => `INSERT INTO ${table}  ([Name])${out} VALUES (${value})`;
    const capture = 'SELECT @spinajs_inserted = @@ROWCOUNT, @spinajs_identity = SCOPE_IDENTITY();';
    const write =
      `IF HAS_PERMS_BY_NAME(N'${table}', 'OBJECT', 'SELECT', N'Id', 'COLUMN') = 1 BEGIN ${insert(' OUTPUT inserted.[Id] INTO @spinajs_keys')}; ${capture} END ` +
      `ELSE BEGIN ${insert('', '@p0')}; ${capture} INSERT INTO @spinajs_keys ([Id]) SELECT @spinajs_identity WHERE @spinajs_identity IS NOT NULL; END;`;
    const head = 'DECLARE @spinajs_keys TABLE ([Id] sql_variant); DECLARE @spinajs_inserted INT = 0; DECLARE @spinajs_identity NUMERIC(38,0); ';
    const tail =
      'SELECT [Id] FROM @spinajs_keys; SELECT @spinajs_identity as ID, @spinajs_inserted as INSERTED, ' +
      `CASE WHEN DB_NAME() = N'test' AND OBJECTPROPERTY(OBJECT_ID(N'${table}'), 'HasInsteadOfTrigger') = 0 THEN 1 WHEN EXISTS (SELECT 1 FROM @spinajs_keys WHERE [Id] = @spinajs_identity) THEN 1 ELSE 0 END as KEYS_EXACT;`;

    it('outputs the key of a one-row model insert into a table variable, and runs it without OUTPUT for a login that cannot read the key', () => {
      const compiled = insertOf(models.IdentityRow, [{ Name: 'a' }]).toDB();

      expect(compiled.expression).to.eq(`${head}${write} ${tail}`);
      expect(compiled.bindings).to.deep.eq(['a']);
    });

    /** The statement of each form: the IF form keeps its `?`, the ELSE form names them. */
    const formsOf = (expression: string) => {
      const [, first, second] = /^.*? IF .*? BEGIN (.*?); SELECT @spinajs_inserted .*? ELSE BEGIN (.*?); SELECT @spinajs_inserted /.exec(expression) ?? [];
      return { first: first.replace(/ OUTPUT inserted\.\S+(, inserted\.\S+)* INTO @spinajs_keys/, ''), second };
    };

    it('binds the values once: the second form names the parameters the driver gives the first, in the same order', () => {
      const { expression, bindings } = insertOf(models.IdentityRow, [{ Name: 'a', Code: 'b', Amount: 3 }]).toDB();
      const { first, second } = formsOf(expression ?? '');

      expect(bindings).to.deep.eq(['a', 'b', 3]);
      expect(second).to.eq(`INSERT INTO ${table}  ([Name],[Code],[Amount]) VALUES (@p0,@p1,@p2)`);
      expect(toNamedParameters(first, 3)).to.eq(second);
    });

    it("names the same parameters in both forms of an upsert whose raw update holds a '?' literal and a placeholder of its own", () => {
      const upsert = insertOf(models.IdentityRow, [{ Name: 'a', Code: 'b' }]);
      upsert.onDuplicate('Name').update([RawQuery.create("[Code] = CONCAT([Code], N'?', ?)", ['x'])]);
      const expression = upsert.toDB().expression ?? '';
      const { first, second } = formsOf(expression);

      expect(second).to.contain("UPDATE SET [Code] = CONCAT([Code], N'?', @p1) WHEN NOT MATCHED THEN INSERT   ([Name],[Code]) VALUES (@p2,@p3)");
      expect(toNamedParameters(first, 4)).to.eq(second);
      expect(toNamedParameters(expression, 4).match(/@p\d+/g)).to.deep.eq(['@p0', '@p1', '@p2', '@p3', '@p0', '@p1', '@p2', '@p3']);
    });

    it('outputs every key column after the last WHEN clause of a MERGE, and proves no key of it by SCOPE_IDENTITY()', () => {
      const upsert = insertOf(models.PairRow, [{ Name: 'a' }]);
      upsert.onDuplicate('Name').update(['Name']);
      const sql = sqlOf(upsert);

      expect(sql).to.match(/^DECLARE @spinajs_keys TABLE \(\[Tenant\] sql_variant, \[Id\] sql_variant\); .* IF HAS_PERMS_BY_NAME\(.*N'Tenant', 'COLUMN'\) = 1 AND HAS_PERMS_BY_NAME\(.*N'Id', 'COLUMN'\) = 1 BEGIN MERGE INTO /);
      expect(sql).to.contain('WHEN NOT MATCHED THEN INSERT   ([Name]) VALUES (?) OUTPUT inserted.[Tenant], inserted.[Id] INTO @spinajs_keys; ');
      expect(sql).to.contain('SELECT [Tenant], [Id] FROM @spinajs_keys; ');
      expect(sql).to.not.contain('= @spinajs_identity');
    });

    it('keeps the orIgnore() guard around the insert', () => {
      const guarded = `BEGIN TRY ${write} END TRY BEGIN CATCH IF ERROR_NUMBER() NOT IN (2601, 2627) OR ERROR_PROCEDURE() IS NOT NULL BEGIN; THROW; END; END CATCH;`;

      expect(sqlOf(insertOf(models.IdentityRow, [{ Name: 'a' }]).orIgnore())).to.eq(`${head}${guarded} ${tail}`);
    });

    it('leaves the guard out of an upsert, which decides what a conflict does', () => {
      const upsert = insertOf(models.IdentityRow, [{ Name: 'a' }]).orIgnore();
      upsert.onDuplicate('Name').update(['Name']);

      expect(sqlOf(upsert)).to.not.contain('BEGIN TRY');
    });

    it('compiles as before without a model, for several rows and for a key of a type the batch cannot hold', () => {
      const driver = DI.get(Orm)!.Connections.get(CONNECTION)!;
      const before = '; SELECT SCOPE_IDENTITY() as ID, @@ROWCOUNT as INSERTED;';

      expect(sqlOf(driver.insert().into('ik_identity').values({ Name: 'a' }))).to.eq(`INSERT INTO [ik_identity]  ([Name]) VALUES (?)${before}`);
      expect(sqlOf(insertOf(models.IdentityRow, [{ Name: 'a' }, { Name: 'b' }]))).to.eq(`INSERT INTO [test].[ik_identity]  ([Name]) VALUES (?),(?)${before}`);
      expect(sqlOf(insertOf(models.NodeRow, [{ Id: '/1/', Name: 'a' }]))).to.eq(`INSERT INTO [test].[ik_node]  ([Id],[Name]) VALUES (?,?)${before}`);
    });
  });

  describe('callers', () => {
    it('sends the key output with the insert', async () => {
      RESULT = insertResult(1, 41, [{ Id: 41 }]);
      await new models.IdentityRow({ Name: 'a' }).insert();

      expect(SENT).to.have.lengthOf(1);
      expect(SENT[0]).to.match(/ OUTPUT inserted\.\[Id\] INTO @spinajs_keys /);
    });

    it('ModelBase.insert backfills an identity key', async () => {
      RESULT = insertResult(1, 41, [{ Id: 41 }]);
      const row = new models.IdentityRow({ Name: 'a' });
      await row.insert();

      expect(row.Id).to.eq(41);
    });

    it('ModelBase.insert backfills a key that is not the identity column', async () => {
      RESULT = insertResult(1, 41, [{ Id: 'A1B2' }]);
      const row = new models.GuidRow({ Name: 'a' });
      await row.insert();

      expect(row.Id).to.eq('A1B2');
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
        RESULT = insertResult(1, 41, [{ Id: 41 }]);
        await new models.IdentityRow({ Name: 'a' }).insert();

        expect(CAPTURED).to.have.lengthOf(1);
        expect(CAPTURED[0].unknownKeys).to.eq(false);
      });
    });
  });
});
