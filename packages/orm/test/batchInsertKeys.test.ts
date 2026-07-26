/* eslint-disable prettier/prettier */
import './../src/bootstrap.js';
import { NonDbPropertyHydrator, DbPropertyHydrator, ModelHydrator } from './../src/hydrators.js';
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import '@spinajs/log';
import { Orm } from '../src/index.js';
import { FakeSqliteDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeInsertQueryCompiler, FakeUpdateQueryCompiler, ConnectionConf, FakeMysqlDriver, FakeConverter, FakeTableQueryCompiler } from './misc.js';
import { DbServerResponse, SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, DatetimeValueConverter, TableQueryCompiler, ServerResponseMapper, InsertBehaviour } from '../src/interfaces.js';
import { Model1 } from './mocks/models/Model1.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

/** What the fake server "replies" with. Each test sets this before inserting. */
let RESPONSE: any = { RowsAffected: 0, LastInsertId: 0, Returning: [] };

/**
 * Whether the fake dialect's LastInsertId is the FIRST id of a multi-row statement ( MySQL ) or
 * the last one ( MSSQL's SCOPE_IDENTITY(), sqlite3's `lastID` ).
 */
let FIRST_ID = true;

/**
 * Returns whatever the driver resolved with, so a test can express "the server said it inserted
 * 3 rows starting at id 10" without going near a real database.
 */
class PassthroughResponseMapper extends ServerResponseMapper {
  public read(response: any): DbServerResponse {
    return {
      LastInsertId: response?.LastInsertId ?? 0,
      RowsAffected: response?.RowsAffected ?? 0,
      Returning: response?.Returning ?? [],
    };
  }
}

class BatchInsertDriver extends FakeSqliteDriver {
  public supportedFeatures() {
    return { ...super.supportedFeatures(), insertReturning: false, insertIdIsFirstOfBatch: FIRST_ID };
  }

  public async execute(builder: any): Promise<any> {
    builder.toDB();
    return RESPONSE;
  }
}

describe('batch insert key backfill', () => {
  beforeEach(async () => {
    RESPONSE = { RowsAffected: 0, LastInsertId: 0, Returning: [] };
    FIRST_ID = true;

    DI.register(ConnectionConf).as(Configuration);
    DI.register(BatchInsertDriver).as('sqlite');
    DI.register(FakeMysqlDriver).as('mysql');

    DI.register(FakeSelectQueryCompiler).as(SelectQueryCompiler);
    DI.register(FakeDeleteQueryCompiler).as(DeleteQueryCompiler);
    DI.register(FakeUpdateQueryCompiler).as(UpdateQueryCompiler);
    DI.register(FakeInsertQueryCompiler).as(InsertQueryCompiler);
    DI.register(FakeTableQueryCompiler).as(TableQueryCompiler);

    DI.register(DbPropertyHydrator).as(ModelHydrator);
    DI.register(NonDbPropertyHydrator).as(ModelHydrator);
    DI.register(FakeConverter).as(DatetimeValueConverter);
    DI.register(PassthroughResponseMapper).as(ServerResponseMapper);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
    sinon.restore();
  });

  it('a multi-row VALUES insert backfills LastInsertId + index on a first-id dialect', async () => {
    RESPONSE = { RowsAffected: 3, LastInsertId: 10, Returning: [] };

    const models = [new Model1(), new Model1(), new Model1()];
    await Model1.insert(models);

    expect(models.map((m) => m.Id)).to.deep.equal([10, 11, 12]);
  });

  it('does not backfill on a dialect whose insert id is the last of the batch', async () => {
    FIRST_ID = false;
    RESPONSE = { RowsAffected: 3, LastInsertId: 12, Returning: [] };

    const models = [new Model1(), new Model1(), new Model1()];
    await Model1.insert(models);

    expect(models.map((m) => m.Id)).to.deep.equal([null, null, null]);
  });

  it('does not backfill when the server inserted fewer rows than were sent', async () => {
    RESPONSE = { RowsAffected: 2, LastInsertId: 10, Returning: [] };

    const models = [new Model1(), new Model1(), new Model1()];
    await Model1.insert(models);

    expect(models.map((m) => m.Id)).to.deep.equal([null, null, null]);
  });

  it('does not backfill when any row already carries a key ( mixed-mode insert )', async () => {
    RESPONSE = { RowsAffected: 3, LastInsertId: 10, Returning: [] };

    const models = [new Model1(), new Model1(), new Model1()];
    models[1].Id = 99;
    await Model1.insert(models);

    expect(models.map((m) => m.Id)).to.deep.equal([null, 99, null]);
  });

  it('does not backfill when the dialect reported no identity value', async () => {
    RESPONSE = { RowsAffected: 3, LastInsertId: 0, Returning: [] };

    const models = [new Model1(), new Model1(), new Model1()];
    await Model1.insert(models);

    expect(models.map((m) => m.Id)).to.deep.equal([null, null, null]);
  });

  it('RETURNING still wins when the dialect supplies it', async () => {
    RESPONSE = { RowsAffected: 3, LastInsertId: 10, Returning: [{ Id: 7 }, { Id: 21 }, { Id: 34 }] };

    const models = [new Model1(), new Model1(), new Model1()];
    await Model1.insert(models);

    expect(models.map((m) => m.Id)).to.deep.equal([7, 21, 34]);
  });

  it('a single-row insert still reads the identity value directly', async () => {
    RESPONSE = { RowsAffected: 1, LastInsertId: 55, Returning: [] };

    const m = new Model1();
    await Model1.insert(m);

    expect(m.Id).to.equal(55);
  });

  it('an array insert still refuses a non-default insert behaviour', async () => {
    RESPONSE = { RowsAffected: 3, LastInsertId: 10, Returning: [] };

    await expect(Model1.insert([new Model1(), new Model1()], InsertBehaviour.InsertOrIgnore)).to.be.rejectedWith(/insert behaviour is not supported with arrays/);
  });
});
