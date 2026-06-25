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

    // values are NOT placed under the Group prefix
    expect(c.get('db-conf.config1')).to.be.undefined;
  });

  it('Should NOT load config values that are not exposed', async () => {
    const c = await cfg();

    expect(c.get('config-hidden')).to.be.undefined;
  });

  it('Should watch config values from db at their Slug path', async () => {
    const c = await cfg();

    // exposed @Config var with no default - loaded from db as null/undefined
    expect(c.get('test-watch')).to.not.exist;

    await DbConfig.update({
      Value: 'hello',
    }).where('Slug', 'test-watch');

    await wait(5000);

    expect(c.get('test-watch')).to.eq('hello');
  });
});
