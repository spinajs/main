/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-floating-promises */
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import _ from 'lodash';
import { DateTime } from 'luxon';
import { join, normalize, resolve } from 'path';

import { Bootstrapper, DI, IContainer, Injectable } from '@spinajs/di';
import '@spinajs/log';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Config, Configuration, ConfigurationSource, FrameworkConfiguration, IConfigLike } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';

import { ConfigFileValidator, DbConfig, DbConfigFileHistory, DbConfigSourceBotstrapper, DbConfigValueConverter } from './../src/index.js';
import './migration/test_config_data_2022_02_08_01_13_00.js';

const expect = chai.expect;
chai.use(chaiAsPromised);



export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

const TEST_CONFIG = {
  logger: {
    targets: [
      {
        name: 'Empty',
        type: 'BlackHoleTarget',
        layout: '${datetime} ${level} ${message} ${error} duration: ${duration} ms (${logger})',
      },
    ],

    rules: [{ name: '*', level: 'trace', target: 'Empty' }],
  },
  configuration_db_source: {
    connection: 'sqlite',
    table: 'configuration',
  },
  db: {
    DefaultConnection: 'sqlite',

    Connections: [
      {
        Driver: 'orm-driver-sqlite',
        Filename: ':memory:',
        Name: 'sqlite',
        Migration: {
          OnStartup: true,
        },
      },
    ],
  },
};

/**
 * The db configuration source (Order 999) reads `db.Connections` from the
 * config that earlier sources have already produced - in production that is a
 * file source. We emulate that here with an in-memory source that loads first
 * (Order 0), so the db source can actually connect during the load loop.
 *
 * NOTE: `onLoad()` alone is NOT enough - it is merged AFTER all sources run,
 * so the db source would never see the connection options.
 */
@Injectable(ConfigurationSource)
export class ConnectionConfigSource extends ConfigurationSource {
  public get Order(): number {
    return 0;
  }

  public Load(): Promise<IConfigLike> {
    return Promise.resolve(TEST_CONFIG as unknown as IConfigLike);
  }
}

export class ConnectionConf extends FrameworkConfiguration {
  public onLoad(): unknown {
    // connection options are provided by ConnectionConfigSource (Order 0) so the
    // db source can see them during the load loop. onLoad is merged afterwards,
    // so returning TEST_CONFIG here too would only duplicate logger targets.
    return {};
  }
}

class SampleTemplateValidator extends ConfigFileValidator {
  public validate(): Promise<void> {
    return Promise.resolve();
  }
}

async function db() {
  return await DI.resolve(Orm);
}

async function cfg() {
  return await DI.resolve(Configuration);
}

export class Test {
  @Config('test', {
    expose: true,
    exposeOptions: {
      type: 'string',
      group: 'db-config',
    },
  })
  protected SomeVal: string;

  @Config('test-watch', {
    expose: true,
    exposeOptions: {
      type: 'string',
      group: 'db-config',
      watch: true,
    },
  })
  protected SomeVal2: string;

  // a non-string exposed option - exercises converter serialization of the
  // default value (number -> '42') and parsing it back on load.
  @Config('test-number', {
    defaultValue: 42,
    expose: true,
    exposeOptions: {
      type: 'number',
      group: 'db-config',
    },
  })
  protected SomeNum: number;

  // a watched non-string option - exercises the watch loop + converter + the
  // DateTime-aware comparison for a numeric value.
  @Config('test-watch-num', {
    defaultValue: 0,
    expose: true,
    exposeOptions: {
      type: 'number',
      group: 'db-config',
      watch: true,
    },
  })
  protected SomeWatchNum: number;
}

async function wait(amount?: number) {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, amount);
  });
}

describe('Sqlite driver migration, updates, deletions & inserts', function () {

  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    DI.register({
      value: 2000,
    }).asValue('__config_watch_interval__');

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await db();
    await (await cfg()).load();
  });

  afterEach(async () => {
    const orm = await db();
    orm.dispose();

    DI.uncache(Orm);
    DI.uncache(Configuration);
  });

  after(async () => {
    await DI.dispose();
  });

  it('Should migrate configuration table', async () => {
    const result = await (await db()).Connections.get('sqlite')!.schema().tableExists('configuration');
    expect(result).to.be.true;
  });

  it('Should migrate configuration file history table', async () => {
    const result = await (await db()).Connections.get('sqlite')!.schema().tableExists('configuration_file_history');
    expect(result).to.be.true;
  });

  it('Should store and read configuration file history rows', async () => {
    const row = new DbConfigFileHistory({
      Slug: 'yourscreen.kalkulator.template',
      Fs: 'fs-excel-templates',
      FileName: 'kalkulator-20260916-121530.xlsx',
      OriginalName: 'kalkulator.xlsx',
      Size: 12345,
      Hash: 'a'.repeat(64),
      UploadedBy: 7,
      ArchivedPath: null,
      // `ArchivedAt` can't be typed `DateTime | null` and still satisfy the ORM's
      // @DateTimeColumn() decorator (see DbConfigFileHistory) - undefined is the
      // "not archived yet" value.
      ArchivedAt: undefined,
    });
    await row.insert();

    const read = await DbConfigFileHistory.where('Id', row.Id).first();

    expect(read.Slug).to.equal('yourscreen.kalkulator.template');
    expect(read.FileName).to.equal('kalkulator-20260916-121530.xlsx');
    expect(read.UploadedBy).to.equal(7);
    expect(DateTime.isDateTime(read.UploadedAt)).to.be.true;
    expect(read.ArchivedPath).to.not.exist;
    expect(read.ArchivedAt).to.not.exist;

    read.ArchivedPath = `archive/${read.FileName}`;
    read.ArchivedAt = DateTime.now();
    await read.update();

    const archived = await DbConfigFileHistory.where('Id', row.Id).first();
    expect(archived.ArchivedPath).to.equal('archive/kalkulator-20260916-121530.xlsx');
    expect(DateTime.isDateTime(archived.ArchivedAt)).to.be.true;
  });

  it('Should insert config values to db', async () => {
    const result = await DbConfig.where('Slug', 'test').first();

    expect(result).to.be.not.null;
    expect(result.Slug).to.equal('test');
  });

  it('Should load config values from db at their Slug path', async () => {
    const c = await cfg();

    // Slug is the canonical config path; Group is display-only metadata
    // and must NOT be part of the path the value is stored at.
    expect(c.get('config1')).to.equal('text-value-1');
    expect(c.get('config2')).to.equal(1);
    expect(c.get('config3')).to.equal(10.4);
    expect(c.get('config4')).to.deep.equal({ hello: 'world' });
    expect(c.get('config8')).to.equal(false);

    // datetime types are parsed to luxon DateTime
    expect((c.get('config7') as DateTime).isValid).to.be.true;
    expect(DateTime.isDateTime(c.get('config7'))).to.be.true;

    // composite config-only types round-trip through the source converter
    expect(c.get('config13')).to.deep.equal(['hello2', 'hello3']); // manyOf -> string[]
    expect(c.get('config14')).to.equal(1); // range -> number

    const dateRange = c.get('config9') as DateTime[]; // date-range -> DateTime[]
    expect(dateRange).to.be.an('array').with.lengthOf(2);
    expect(dateRange.every((x) => DateTime.isDateTime(x))).to.be.true;

    // values are NOT placed under the Group prefix
    expect(c.get('db-conf.config1')).to.be.undefined;
  });

  it('Should persist exposed options in canonical form and load them typed', async () => {
    const c = await cfg();

    // expose -> serialize default -> store -> source load, all via the converter
    expect(c.get('test-number')).to.equal(42);

    // the stored Value AND Default are the canonical text form ('42'), not the
    // raw number or a JSON-encoded value
    const conn = (await db()).Connections.get('sqlite')!;
    const rows = (await conn.select().from('configuration')) as any[];
    const row = rows.find((r) => r.Slug === 'test-number');

    expect(row).to.be.not.undefined;
    expect(row.Value).to.equal('42');
    expect(row.Default).to.equal('42');
  });

  it('Should NOT load config values that are not exposed', async () => {
    const c = await cfg();

    expect(c.get('config-hidden')).to.be.undefined;
  });

  it('Should watch config values from db at their Slug path', async () => {
    const c = await cfg();

    // exposed @Config var with no default - loaded from db as null/undefined
    expect(c.get('test-watch')).to.not.exist;
    // numeric watched var was seeded with its default
    expect(c.get('test-watch-num')).to.equal(0);

    await DbConfig.update({ Value: 'hello' }).where('Slug', 'test-watch');
    await DbConfig.update({ Value: '100' }).where('Slug', 'test-watch-num');

    await wait(5000);

    expect(c.get('test-watch')).to.eq('hello');
    // watched numeric value is refreshed AND converted back to a number
    expect(c.get('test-watch-num')).to.equal(100);
  });

  it('Should watch exposed options registered after startup', async () => {
    const c = await cfg();

    DI.register({
      path: 'late-watch',
      options: {
        expose: true,
        defaultValue: 'a',
        exposeOptions: { type: 'string', group: 'db-config', watch: true },
      },
    }).asValue('__configuration_property__');

    await wait(500);
    expect(c.get('late-watch')).to.equal('a');

    await DbConfig.update({ Value: 'b' }).where('Slug', 'late-watch');

    await wait(3000);

    expect(c.get('late-watch')).to.equal('b');
  });

  it('Should arm the watch timer from the first watched slug registered after ORM resolve, when nothing was watched at resolve time', async () => {
    const c = await cfg();

    // A bootstrapper instance of its own, deliberately not wired through DI.register/DI.on:
    // the shared instance the suite's beforeEach bootstraps is already armed (the `Test`
    // class registers watched vars at module load), so routing this scenario through the
    // real `di.registered.__configuration_property__` broadcast would also reach that
    // already-armed listener, which would refresh our slug on its own and mask a broken
    // arm(). Calling the real (unstubbed) private methods directly on a fresh instance
    // keeps `watchedSlugs`/`armWatchTimer` isolated while still exercising production code.
    const bootstrapper = new DbConfigSourceBotstrapper();
    const internals = bootstrapper as unknown as {
      Converter: DbConfigValueConverter;
      startWatchTimer(container: IContainer): void;
      syncConfigOption(v: { path: string; options: Record<string, unknown> }): Promise<void>;
    };
    internals.Converter = await DI.resolve(DbConfigValueConverter);

    // simulates ORM resolve with nothing watched yet - no timer should be armed
    internals.startWatchTimer({ get: () => c } as unknown as IContainer);

    // simulates the first watched option registered after startup
    await internals.syncConfigOption({
      path: 'isolated-late-watch',
      options: {
        expose: true,
        defaultValue: 'a',
        exposeOptions: { type: 'string', group: 'db-config', watch: true },
      },
    });

    expect(c.get('isolated-late-watch')).to.equal('a');

    await DbConfig.update({ Value: 'b' }).where('Slug', 'isolated-late-watch');

    await wait(3000);

    expect(c.get('isolated-late-watch')).to.equal('b');
  });

  it('Should refresh metadata of an existing row and keep its Value', async () => {
    await DbConfig.update({ Label: 'stale', Group: 'stale', Value: 'edited' }).where('Slug', 'test');

    DI.register({
      path: 'test',
      options: {
        expose: true,
        exposeOptions: { type: 'string', group: 'db-config', label: 'Fresh label' },
      },
    }).asValue('__configuration_property__');

    await wait(500);

    const row = await DbConfig.where('Slug', 'test').first();
    expect(row.Label).to.equal('Fresh label');
    expect(row.Group).to.equal('db-config');
    expect(row.Value).to.equal('edited');
  });

  it('Should store a class file validator in Meta under its name', async () => {
    DI.register({
      path: 'test-file-template',
      options: {
        expose: true,
        defaultValue: 'default.xlsx',
        exposeOptions: {
          type: 'file',
          group: 'db-config',
          meta: { file: { fs: 'fs-templates', extensions: ['xlsx'], validator: SampleTemplateValidator } },
        },
      },
    }).asValue('__configuration_property__');

    await wait(500);

    const row = await DbConfig.where('Slug', 'test-file-template').first();
    expect(row.Meta).to.deep.equal({ file: { fs: 'fs-templates', extensions: ['xlsx'], validator: 'SampleTemplateValidator' } });
  });
});
