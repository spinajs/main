import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Log } from '@spinajs/log-common';
import * as chai from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import '@spinajs/log';
import { Connection, IMissingModelTable, Migration, MigrationTransactionMode, Model, ModelBase, Orm, OrmDriver, OrmMigration, Primary, resolveMigrationTool } from '../src/index.js';
import { logText, registerFakes, stubDb, TableSetDriver } from './misc.js';

const expect = chai.expect;

const CONNECTION = 'tool-missing';
const DRIVER = 'tool-missing-driver';
const TABLES = TableSetDriver.Tables;
const MODEL_TABLES = ['tool_missing_first', 'tool_missing_second'];

class ToolMissingConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      db: {
        StrictTableCheck: false,
        MigrationCheck: 'off',
        Connections: [{ Driver: DRIVER, Name: CONNECTION, Migration: { Transaction: { Mode: MigrationTransactionMode.None } } }],
      },
    };
  }
}

/** Declared here rather than at module scope: `@Model()` registers globally, and after() unregisters them. */
function defineModels() {
  @Connection(CONNECTION)
  @Model('tool_missing_first')
  class ToolMissingFirst extends ModelBase {
    @Primary()
    public Id: number;
  }

  @Connection(CONNECTION)
  @Model('tool_missing_second')
  class ToolMissingSecond extends ModelBase {
    @Primary()
    public Id: number;
  }

  return [ToolMissingFirst, ToolMissingSecond];
}

function register() {
  registerFakes();
  DI.register(ToolMissingConf).as(Configuration);
  DI.register(TableSetDriver).as(DRIVER);
}

describe('the Orm of a migration tool on a database whose tables do not exist yet', () => {
  let models: ReturnType<typeof defineModels>;
  let warn: sinon.SinonSpy;
  let preRegistered: unknown[] = [];
  let db: sinon.SinonStub | undefined;

  const missingTableLines = () => warn.getCalls().map(logText).filter((t) => t.includes('tool_missing_'));

  before(async () => {
    models = defineModels();

    // the logger is resolved once and cached on Orm.prototype, so a spy on a booted Orm's Log sees every later Orm
    DI.clearCache();
    MODEL_TABLES.forEach((t) => TABLES.add(t));
    register();
    const warmup = await DI.resolve(Orm);
    warn = sinon.spy(Reflect.get(warmup, 'Log') as Log, 'warn');
  });

  beforeEach(() => {
    DI.clearCache();
    TABLES.clear();
    warn.resetHistory();
    register();
    preRegistered = [...(DI.getRegisteredTypes('__migrations__') ?? [])];
  });

  afterEach(() => {
    for (const t of [...(DI.getRegisteredTypes('__migrations__') ?? [])]) {
      if (!preRegistered.includes(t)) {
        DI.unregister(t);
      }
    }
    db?.restore();
    db = undefined;
  });

  after(() => {
    warn.restore();
    models.forEach((m) => DI.unregister(m));
    DI.unregister(ToolMissingConf);
    DI.unregister(DRIVER, TableSetDriver);
    TABLES.clear();
    DI.clearCache();
  });

  it('logs one line that lists every missing table', async () => {
    await resolveMigrationTool();

    const lines = missingTableLines();
    expect(lines, lines.join('\n')).to.have.length(1);
    expect(lines[0]).to.contain('2 model tables do not exist yet');
    expect(lines[0]).to.contain('model ToolMissingFirst: table tool_missing_first on connection tool-missing');
    expect(lines[0]).to.contain('model ToolMissingSecond: table tool_missing_second on connection tool-missing');
    const fields = warn.lastCall.args[0] as { tables: IMissingModelTable[] };
    expect(fields.tables.map((t) => t.table)).to.deep.equal(MODEL_TABLES);
  });

  it('says one table in the singular', async () => {
    TABLES.add('tool_missing_first');

    await resolveMigrationTool();

    const lines = missingTableLines();
    expect(lines, lines.join('\n')).to.have.length(1);
    expect(lines[0]).to.contain('1 model table does not exist yet');
  });

  it('logs nothing about tables when every table exists', async () => {
    MODEL_TABLES.forEach((t) => TABLES.add(t));

    await resolveMigrationTool();

    expect(missingTableLines()).to.deep.equal([]);
  });

  it('logs no per-model line after migrate() created the tables', async () => {
    @Migration(CONNECTION)
    class ToolMissingCreate_2026_11_19_00_00_00 extends OrmMigration {
      public async up(connection: OrmDriver): Promise<void> {
        for (const table of MODEL_TABLES) {
          await connection.schema().createTable(table, (t) => {
            t.int('Id').primaryKey();
          });
          TABLES.add(table);
        }
      }

      public async down(_connection: OrmDriver): Promise<void> {}
    }

    db = stubDb([]);
    const migrator = await resolveMigrationTool();
    const executed = await migrator.migrate();

    expect(executed.map((m) => m.constructor.name)).to.deep.equal([ToolMissingCreate_2026_11_19_00_00_00.name]);
    const lines = missingTableLines();
    expect(lines, lines.join('\n')).to.have.length(1);
    expect(lines[0]).to.contain('2 model tables do not exist yet');
  });

  it('an application boot still warns once per model whose table is missing', async () => {
    await DI.resolve(Orm);

    const lines = missingTableLines();
    expect(lines, lines.join('\n')).to.have.length(2);
    expect(lines[0]).to.contain('ToolMissingFirst');
    expect(lines[1]).to.contain('ToolMissingSecond');
  });
});
