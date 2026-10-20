/* eslint-disable @typescript-eslint/no-explicit-any */
import { Configuration, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import '@spinajs/log';
import { Connection, extractModelDescriptor, IColumnDescriptor, IOrmOptions, Model, ModelBase, Orm, ORM_CONFIGURATION_SCHEMA, OrmConfigurationBootstrapper, OrmException, Primary } from '../src/index.js';
import { FakeSqliteDriver } from './misc.js';

const expect = chai.expect;

const CONNECTION = 'strict-check';
const ALIAS = 'strict-check-alias';

/** Tables the fake database holds; tableInfo() answers null for any other, as every real driver does. */
const TABLES = new Set<string>();

/** db.StrictTableCheck of the next boot; undefined leaves the key out. */
let strictSetting: boolean | undefined;

class StrictCheckDriver extends FakeSqliteDriver {
  public async tableInfo(table: string): Promise<IColumnDescriptor[]> {
    return TABLES.has(table) ? [] : (null as any);
  }
}

class StrictCheckConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      db: {
        ...(strictSetting === undefined ? {} : { StrictTableCheck: strictSetting }),
        Aliases: { [ALIAS]: CONNECTION },
        Connections: [{ Driver: 'strict-check-driver', Name: CONNECTION, Migration: { OnStartup: false } }],
      },
    };
  }
}

/** Declared here rather than at module scope: @Model registers globally, and after() unregisters them. */
function defineModels() {
  @Connection(CONNECTION)
  @Model('strict_present')
  class StrictPresent extends ModelBase {
    @Primary()
    public Id: number;
  }

  @Connection(CONNECTION)
  @Model('strict_missing')
  class StrictMissing extends ModelBase {
    @Primary()
    public Id: number;
  }

  @Connection(ALIAS)
  @Model('strict_aliased')
  class StrictAliased extends ModelBase {
    @Primary()
    public Id: number;
  }

  @Connection('strict-check-not-configured')
  @Model('strict_unconfigured')
  class StrictUnconfigured extends ModelBase {
    @Primary()
    public Id: number;
  }

  return { StrictPresent, StrictMissing, StrictAliased, StrictUnconfigured };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }

  return undefined;
}

const ALL_TABLES = ['strict_present', 'strict_missing', 'strict_aliased'];

describe('Orm strict table check (db.StrictTableCheck)', () => {
  let models: ReturnType<typeof defineModels>;

  before(() => {
    models = defineModels();
  });

  after(() => {
    Object.values(models).forEach((m) => DI.unregister(m));
    DI.unregister(StrictCheckConf);
    DI.clearCache();
  });

  beforeEach(() => {
    DI.clearCache();
    TABLES.clear();
    strictSetting = undefined;
    DI.register(StrictCheckConf).as(Configuration);
    DI.register(StrictCheckDriver).as('strict-check-driver');
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('fails the boot naming every model whose table is missing, its table and its connection', async () => {
    TABLES.add('strict_present');

    const err = await rejection(DI.resolve(Orm));

    expect(err).to.be.instanceOf(OrmException);
    expect((err as Error).message).to.equal(
      'Missing tables (db.StrictTableCheck): model StrictMissing: table strict_missing on connection strict-check; model StrictAliased: table strict_aliased on connection strict-check-alias (strict-check). Create them (run their migrations) or set db.StrictTableCheck to false',
    );
  });

  it('boots when every model on a configured connection has its table; a model on an unconfigured connection stays a warning', async () => {
    ALL_TABLES.forEach((t) => TABLES.add(t));

    const orm = await DI.resolve(Orm);

    expect(orm.StrictTableCheck).to.equal(true);
    expect(extractModelDescriptor(models.StrictPresent)!.Driver).to.equal(orm.Connections.get(CONNECTION));
    expect(extractModelDescriptor(models.StrictUnconfigured)!.Driver ?? null).to.equal(null);
  });

  it('boots with db.StrictTableCheck false and binds the model whose table is missing', async () => {
    strictSetting = false;

    const orm = await DI.resolve(Orm);

    expect(orm.StrictTableCheck).to.equal(false);
    expect(extractModelDescriptor(models.StrictMissing)!.Driver).to.equal(orm.Connections.get(CONNECTION));
  });

  it('an Orm resolved with MigrateOnStartup: false boots before the tables exist', async () => {
    const orm = await DI.resolve(Orm, [{ MigrateOnStartup: false } as IOrmOptions]);

    expect(await rejection(orm.reloadTableInfo({ strict: orm.StrictTableCheck }))).to.be.instanceOf(OrmException);

    ALL_TABLES.forEach((t) => TABLES.add(t));
    await orm.reloadTableInfo({ strict: orm.StrictTableCheck });
  });

  it('reloadTableInfo() called by hand is lenient unless asked to be strict', async () => {
    strictSetting = false;
    const orm = await DI.resolve(Orm);

    await orm.reloadTableInfo();
    expect(await rejection(orm.reloadTableInfo({ strict: true }))).to.be.instanceOf(OrmException);
  });
});

describe('db.StrictTableCheck configuration schema', () => {
  class SchemaConf extends FrameworkConfiguration {}

  afterEach(() => {
    DI.unregister(SchemaConf);
    DI.clearCache();
  });

  it('defaults the key to true and refuses a value that is not a boolean', async () => {
    DI.clearCache();
    new OrmConfigurationBootstrapper().bootstrap();
    DI.register(SchemaConf).as(Configuration);

    const config = (await DI.resolve(Configuration)) as FrameworkConfiguration;
    expect(config.get('db.StrictTableCheck')).to.equal(true);

    config.set(['db', 'StrictTableCheck'], 'no');
    expect(() => config.validateModule(ORM_CONFIGURATION_SCHEMA)).to.throw(InvalidConfiguration, 'db.StrictTableCheck');
  });
});
