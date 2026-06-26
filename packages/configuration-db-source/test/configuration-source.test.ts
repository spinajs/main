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

import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import '@spinajs/log';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Config, Configuration, ConfigurationSource, FrameworkConfiguration, IConfigLike } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';

import { DbConfig } from './../src/index.js';
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
});
