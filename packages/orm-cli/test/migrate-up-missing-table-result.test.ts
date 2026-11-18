import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, Migration, Model, ModelBase, Orm, OrmDriver, OrmException, OrmMigration, Primary } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';
import '@spinajs/log';
import '@spinajs/orm-sqlite';
import { MigrateUpCommand, resolveCliMigrator } from '../src/index.js';

const expect = chai.expect;

const CONNECTION_NAME = 'orm-cli-missing-table-result';

class MissingTableResultConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    const logger = (this.Config.logger ?? {}) as Record<string, unknown>;
    logger.targets = [...((logger.targets as unknown[]) ?? []), { name: 'Empty', type: 'BlackHoleTarget' }];
    logger.rules = [{ name: '*', level: 'trace', target: 'Empty' }];
    this.Config.logger = logger;

    const db = (this.Config.db ?? {}) as Record<string, unknown>;
    db.Connections = [
      ...((db.Connections as unknown[]) ?? []),
      { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: CONNECTION_NAME, Migration: { Table: 'orm_cli_missing_table_result_migrations' } },
    ];
    this.Config.db = db;
  }
}

describe('migrate-up run in-process reports a model without a table to its caller', function () {
  this.timeout(20000);

  let orm: Orm;
  let defined: any[] = [];
  let missingType: any;
  const originalExitCode = process.exitCode;

  function defineSchema() {
    @Migration(CONNECTION_NAME)
    class OrmCliMissingTableResult_2021_10_01_00_00_00 extends OrmMigration {
      public async up(connection: OrmDriver): Promise<void> {
        await connection.schema().createTable('orm_cli_result_present', (table) => {
          table.int('Id').primaryKey();
        });
      }

      public async down(connection: OrmDriver): Promise<void> {
        await connection.schema().dropTable('orm_cli_result_present');
      }
    }

    @Connection(CONNECTION_NAME)
    @Model('orm_cli_result_present')
    class OrmCliResultPresent extends ModelBase {
      @Primary()
      public Id: number;
    }

    @Connection(CONNECTION_NAME)
    @Model('orm_cli_result_missing')
    class OrmCliResultMissing extends ModelBase {
      @Primary()
      public Id: number;
    }

    defined = [OrmCliMissingTableResult_2021_10_01_00_00_00, OrmCliResultPresent, OrmCliResultMissing];
    missingType = OrmCliResultMissing;
  }

  before(async () => {
    DI.clearCache();
    defineSchema();
    DI.register(MissingTableResultConf).as(Configuration);
    await resolveCliMigrator();
    orm = await DI.resolve(Orm);
  });

  after(async () => {
    try {
      if (orm) {
        await orm.dispose();
      }
    } finally {
      DI.unregister(MissingTableResultConf);
      defined.forEach((t) => DI.unregister(t));
      DI.clearCache();
      process.exitCode = originalExitCode;
    }
  });

  beforeEach(() => {
    process.exitCode = 0;
  });

  // The tests run in order on one database.
  it('resolves with the table check error naming the model, and still sets the exit code for the bin', async () => {
    const result = await (await DI.resolve(MigrateUpCommand)).execute({});

    expect(result?.applied.map((m) => m.constructor.name)).to.eql(['OrmCliMissingTableResult_2021_10_01_00_00_00']);
    expect(result?.tableCheckError).to.be.instanceOf(OrmException);
    expect(result?.tableCheckError?.message).to.contain('orm_cli_result_missing');
    expect(result?.tableCheckError?.message).to.contain('OrmCliResultMissing');
    expect(result?.tableCheckError?.message).to.not.contain('orm_cli_result_present');
    expect(process.exitCode).to.equal(1);
  });

  it('resolves with the table check error under --fake as well', async () => {
    const result = await (await DI.resolve(MigrateUpCommand)).execute({ fake: true });

    expect(result?.applied).to.eql([]);
    expect(result?.tableCheckError).to.be.instanceOf(OrmException);
    expect(result?.tableCheckError?.message).to.contain('OrmCliResultMissing');
    expect(process.exitCode).to.equal(1);
  });

  it('resolves without a table check error once every model has its table', async () => {
    DI.unregister(missingType);
    orm.Models = orm.Models.filter((m) => m.type !== missingType);

    const result = await (await DI.resolve(MigrateUpCommand)).execute({});

    expect(result).to.eql({ applied: [] });
    expect(process.exitCode).to.equal(0);
  });
});
