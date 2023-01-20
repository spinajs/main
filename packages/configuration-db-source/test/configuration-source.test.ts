/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-floating-promises */
import { DbConfig } from './../src/models/DbConfig';
import { Bootstrapper, DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Config, Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import * as _ from 'lodash';
import { join, normalize, resolve } from 'path';
import { Orm } from '@spinajs/orm';
import './../src/migrations/configuration_db_source_2022_02_08_01_13_00';
import './migration/test_config_data_2022_02_08_01_13_00';
import './../src/bootstrap';
import './../src/index';

const expect = chai.expect;
chai.use(chaiAsPromised);

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return target.concat(source);
  }
}

export function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

export class ConnectionConf extends FrameworkConfiguration {
  public onReload(): unknown {
    return {
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
    await (await cfg()).reload();
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
    const result = await (await db()).Connections.get('sqlite').schema().tableExists('configuration');
    expect(result).to.be.true;
  });

  it('Should insert config values to db', async () => {
    const result = await DbConfig.where('slug', 'test').first();

    expect(result).to.be.not.null;
    expect(result.Slug).to.equal('test');
  });

  it('Should load config values from db', async () => {
    const c = await cfg();

    expect(c.get('db-conf.config7')).to.be.not.null;
  });

  it('Should watch config values from db', async () => {
    const c = await cfg();

    expect(c.get('db-conf.test-watch')).to.be.undefined;

    await DbConfig.update({
      Value: 'hello',
    }).where('Slug', 'test-watch');

    await wait(5000);

    expect(c.get('db-config.test-watch')).to.eq('hello');
  });
});
