/* eslint-disable prettier/prettier */
import './../src/bootstrap.js';
import * as chai from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import '@spinajs/log';
import { useTestApp } from '@spinajs/testing';
import { Orm } from '../src/index.js';
import { InsertQueryBuilder } from '../src/builders.js';
import { FakeSqliteDriver, ormApp } from './misc.js';
import { DbServerResponse, ServerResponseMapper, InsertBehaviour } from '../src/interfaces.js';
import { Model1 } from './mocks/models/Model1.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

/** What the fake server "replies" with. Each test sets this before inserting. */
let RESPONSE: DbServerResponse | ((builder: InsertQueryBuilder) => DbServerResponse) = { RowsAffected: 0, LastInsertId: 0, Returning: [] };

/** The keys the fake connection package reports when there are no RETURNING rows; undefined reports none. */
let OWN_KEYS: Array<Record<string, unknown>> | undefined;

let MAX_INSERT_ROWS: number | undefined;

class OwnKeysResponseMapper extends ServerResponseMapper {
  public read(response: Partial<DbServerResponse> | undefined): DbServerResponse {
    return {
      LastInsertId: response?.LastInsertId ?? 0,
      RowsAffected: response?.RowsAffected ?? 0,
      Returning: response?.Returning ?? [],
    };
  }

  public insertedKeys(response: unknown, insert: InsertQueryBuilder): Array<Record<string, unknown>> | undefined {
    return this.returnedKeys(response, insert) ?? OWN_KEYS;
  }
}

class BatchInsertDriver extends FakeSqliteDriver {
  constructor(options: any) {
    super(options);
    // MaxInsertRows is a readonly field fixed at construction; tests change the limit after the driver exists
    Object.defineProperty(this, 'MaxInsertRows', { get: () => MAX_INSERT_ROWS ?? Infinity });
  }

  public async execute(builder: InsertQueryBuilder): Promise<DbServerResponse> {
    builder.toDB();
    return typeof RESPONSE === 'function' ? RESPONSE(builder) : RESPONSE;
  }
}

describe('batch insert key backfill', () => {
  beforeEach(() => {
    RESPONSE = { RowsAffected: 0, LastInsertId: 0, Returning: [] };
    OWN_KEYS = undefined;
    MAX_INSERT_ROWS = undefined;
  });

  useTestApp(() =>
    ormApp({
      register: (c) => {
        c.register(BatchInsertDriver).as('sqlite');
        c.register(OwnKeysResponseMapper).as(ServerResponseMapper);
      },
      resolve: [Orm],
    }),
  );

  afterEach(() => {
    sinon.restore();
  });

  it('assigns the keys the mapper reports to the rows, in order', async () => {
    RESPONSE = { RowsAffected: 3, LastInsertId: 10, Returning: [] };
    OWN_KEYS = [{ Id: 10 }, { Id: 11 }, { Id: 12 }];

    const models = [new Model1(), new Model1(), new Model1()];
    await Model1.insert(models);

    expect(models.map((m) => m.Id)).to.deep.equal([10, 11, 12]);
  });

  it('assigns nothing when the mapper reports no keys', async () => {
    RESPONSE = { RowsAffected: 3, LastInsertId: 10, Returning: [] };

    const models = [new Model1(), new Model1(), new Model1()];
    await Model1.insert(models);

    expect(models.map((m) => m.Id)).to.deep.equal([null, null, null]);
  });

  it('keeps a key the row already carries', async () => {
    RESPONSE = { RowsAffected: 3, LastInsertId: 10, Returning: [] };
    OWN_KEYS = [{ Id: 10 }, { Id: 11 }, { Id: 12 }];

    const models = [new Model1(), new Model1(), new Model1()];
    models[1].Id = 99;
    await Model1.insert(models);

    expect(models.map((m) => m.Id)).to.deep.equal([10, 99, 12]);
  });

  it('RETURNING backfills a batch split into several statements', async () => {
    MAX_INSERT_ROWS = 2;
    let nextId = 7;
    RESPONSE = (builder: InsertQueryBuilder) => ({ RowsAffected: builder.Values.length, LastInsertId: 0, Returning: builder.Values.map(() => ({ Id: nextId++ })) });

    const models = [new Model1(), new Model1(), new Model1()];
    await Model1.insert(models);

    expect(models.map((m) => m.Id)).to.deep.equal([7, 8, 9]);
  });

  it('RETURNING wins over the connection package rule', async () => {
    RESPONSE = { RowsAffected: 3, LastInsertId: 10, Returning: [{ Id: 7 }, { Id: 21 }, { Id: 34 }] };
    OWN_KEYS = [{ Id: 10 }, { Id: 11 }, { Id: 12 }];

    const models = [new Model1(), new Model1(), new Model1()];
    await Model1.insert(models);

    expect(models.map((m) => m.Id)).to.deep.equal([7, 21, 34]);
  });

  it('an array insert still refuses a non-default insert behaviour', async () => {
    RESPONSE = { RowsAffected: 3, LastInsertId: 10, Returning: [] };

    await expect(Model1.insert([new Model1(), new Model1()], InsertBehaviour.InsertOrIgnore)).to.be.rejectedWith(/insert behaviour is not supported with arrays/);
  });
});
