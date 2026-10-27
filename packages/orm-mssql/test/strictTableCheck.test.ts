/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import * as chai from 'chai';
import _ from 'lodash';

import '@spinajs/log';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, Model, ModelBase, Orm, OrmDriver, OrmException, Primary } from '@spinajs/orm';

import { MsSqlOrmDriver } from '../src/index.js';
import { mergeArrays } from './util.js';

const expect = chai.expect;

const CONNECTION = 'mssql-strict';

/** Tables the fake database holds; INFORMATION_SCHEMA.COLUMNS answers no rows for any other. */
const TABLES = new Set<string>();

/** The real driver with the server taken out: the reflection queries answer from TABLES. */
class StrictMsSqlDriver extends MsSqlOrmDriver {
  public async executeOnDb(stmt: string, params: any[]): Promise<any> {
    if (stmt.includes('FROM INFORMATION_SCHEMA.COLUMNS') && TABLES.has(params[0] as string)) {
      return [{ COLUMN_NAME: 'Id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null }];
    }

    return [];
  }

  public async ping(): Promise<boolean> {
    return true;
  }

  public async connect(): Promise<OrmDriver> {
    return this;
  }

  public async disconnect(): Promise<OrmDriver> {
    return this;
  }
}

class StrictMsSqlConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        db: {
          Connections: [{ Driver: 'orm-driver-mssql-strict-fake', Name: CONNECTION, Database: 'test' }],
        },
      },
      mergeArrays,
    );
  }
}

function defineModels() {
  @Connection(CONNECTION)
  @Model('strict_mssql_present')
  class StrictMsSqlPresent extends ModelBase {
    @Primary()
    public Id: number;
  }

  @Connection(CONNECTION)
  @Model('strict_mssql_missing')
  class StrictMsSqlMissing extends ModelBase {
    @Primary()
    public Id: number;
  }

  return [StrictMsSqlPresent, StrictMsSqlMissing];
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }

  return undefined;
}

describe('mssql strict table check (fake driver)', function () {
  this.timeout(15000);

  let models: ReturnType<typeof defineModels>;

  before(() => {
    models = defineModels();
  });

  after(() => {
    models.forEach((m) => DI.unregister(m));
    DI.unregister(StrictMsSqlConf);
    DI.clearCache();
  });

  beforeEach(() => {
    DI.clearCache();
    TABLES.clear();
    DI.register(StrictMsSqlConf).as(Configuration);
    DI.register(StrictMsSqlDriver).as('orm-driver-mssql-strict-fake');
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('fails the Orm resolve naming the model, its table and its connection', async () => {
    TABLES.add('strict_mssql_present');

    const err = await rejection(Promise.resolve(DI.resolve(Orm)));

    expect(err).to.be.instanceOf(OrmException);
    expect((err as Error).message).to.equal('Missing tables (db.StrictTableCheck): model StrictMsSqlMissing: table strict_mssql_missing on connection mssql-strict. Create them (run their migrations) or set db.StrictTableCheck to false');
  });

  it('boots when every table exists', async () => {
    TABLES.add('strict_mssql_present');
    TABLES.add('strict_mssql_missing');

    const orm = await DI.resolve(Orm);
    await orm.Migrator.ready();

    expect(orm.Connections.get(CONNECTION)).to.be.instanceOf(StrictMsSqlDriver);
  });
});
