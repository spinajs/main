import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { Mutex, mutex_acquire, mutex_get, processIdentity } from '@spinajs/threading';
import '@spinajs/log';
import '@spinajs/orm-sqlite';
import { expect } from 'chai';
import { MutexHolder_2026_11_16_00_00_00, OrmMutex, __mutex__ } from '../src/index.js';

class HolderConf extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'sqlite',
            Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } },
          },
        ],
      },
    };
  }
}

describe('mutex holder rename', function () {
  this.timeout(15000);

  const driver = async (): Promise<OrmDriver> => {
    const sqlite = (await DI.resolve(Orm)).Connections.get('sqlite');
    if (!sqlite) throw new Error('the sqlite connection is missing');
    return sqlite;
  };

  before(() => {
    DI.register(OrmMutex).as(Mutex);
    DI.register(HolderConf).as(Configuration);
  });

  after(() => {
    DI.unregister(HolderConf);
  });

  beforeEach(async () => {
    await DI.resolve(Configuration);
    await (await DI.resolve(Orm)).Migrator.ready();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('has the Holder column and no Tenant column once the startup migrations ran', async () => {
    const columns = (await (await driver()).tableInfo('__mutex__')).map((c) => c.Name);

    expect(columns).to.include('Holder');
    expect(columns).to.not.include('Tenant');
  });

  it('keeps the holder of an existing lock when the column is renamed', async () => {
    const sqlite = await driver();
    const migration = new MutexHolder_2026_11_16_00_00_00();

    await migration.down(sqlite);
    await sqlite.insert().into('__mutex__').values({ Name: 'kept', Tenant: 'replica-7', Locked: 1 });
    await migration.up(sqlite);

    expect((await mutex_get('kept'))?.Holder).to.eq('replica-7');
  });

  it('names the holder on the options and on the lock', async () => {
    const granted = await mutex_acquire({ Name: 'typed', Holder: 'replica-1' });

    expect(granted.Locked).to.eq(true);
    expect(granted.Mutex.Holder).to.eq('replica-1');
    expect((await __mutex__.get('typed')).Holder).to.eq('replica-1');
  });

  it('takes the default holder from threading.mutex.holder', async () => {
    DI.get(Configuration)!.set('threading.mutex.holder', 'fixed-holder');

    await mutex_acquire({ Name: 'configured' });

    expect((await mutex_get('configured'))?.Holder).to.eq('fixed-holder');
  });

  it('does not read the removed key threading.mutex.tenant', async () => {
    DI.get(Configuration)!.set('threading.mutex.tenant', 'old-key');

    await mutex_acquire({ Name: 'ignored' });

    expect((await mutex_get('ignored'))?.Holder).to.eq(processIdentity());
  });
});
