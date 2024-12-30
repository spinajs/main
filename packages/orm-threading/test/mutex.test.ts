import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { _modelProxyFactory, MigrationTransactionMode, Orm } from '@spinajs/orm';
import { __mutex__, OrmMutex } from '../src/index';

import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import _ from 'lodash';
import { DI } from '@spinajs/di';
import { join, normalize, resolve } from 'path';
import { Mutex, mutex_create, mutex_get, mutex_delete, mutex_acquire, mutex_release, mutex_wait } from '@spinajs/threading';
import '@spinajs/log';
import '@spinajs/orm-sqlite';
import { DateTime } from 'luxon';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

export class ConnectionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(this.Config, {
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'ConsoleTarget',
          },
        ],

        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
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
              Table: 'orm_migrations',
              Transaction: {
                Mode: MigrationTransactionMode.PerMigration,
              },
            },
          },
        ],
      },
    });
  }
}

describe('orm-threading', function () {
  this.timeout(15000);
  before(() => {
    DI.register(OrmMutex).as(Mutex);
    DI.register(ConnectionConf).as(Configuration);
  });

  beforeEach(async () => {
    await DI.resolve(Configuration, [null, null, [dir('./config')]]);
    await DI.resolve(Orm);
  });

  afterEach(async () => {
    DI.clearCache();
  });

  it('Should create', async () => {
    await mutex_create({
      Name: 'test',
      Tenant: 'test-1',
    });

    const m = await __mutex__.get('test');
    expect(m).to.be.not.null;
    expect(m.Name).to.eq('test');
    expect(m.Tenant).to.eq('test-1');
    expect(m.Locked).to.eq(false);
  });

  it('should delete', async () => {
    await mutex_create({
      Name: 'test',
      Tenant: 'test-1',
    });

    let m = await __mutex__.get('test');
    expect(m).to.be.not.null;

    const r = await mutex_delete({
      Name: 'test',
      Tenant: 'test-1',
    });

    expect(r).to.be.true;

    m = await __mutex__.get('test');
    expect(m).to.be.undefined;
  });

  it('Should not delete if tenant not same', async () => {
    await mutex_create({
      Name: 'test',
      Tenant: 'test-1',
    });

    const r = await mutex_delete({
      Name: 'test',
      Tenant: 'test-2',
    });

    expect(r).to.be.false;

    let m = await __mutex__.get('test');
    expect(m).to.be.not.null;
  });

  it('Should create on acquire', async () => {
    const result = await mutex_acquire({
      Name: 'test',
      Tenant: 'test-1',
    });

    expect(result.Locked).to.be.true;

    let m = await __mutex__.get('test');
    expect(m).to.be.not.null;
    expect(m.Locked).to.be.true;
    expect(m.Tenant).to.eq('test-1');
  });

  it('should acquire', async () => {
    await mutex_create({
      Name: 'test',
      Tenant: 'test-1',
    });

    let m = await __mutex__.get('test');
    expect(m.Locked).to.be.false;

    await mutex_acquire({
      Name: 'test',
      Tenant: 'test-1',
    });

    await m.refresh();

    expect(m.Locked).to.be.true;
  });

  it('Should not acquire when already locked', async () => {});

  it('should release', async () => {
    const r = await mutex_acquire({
      Name: 'test',
      Tenant: 'test-1',
    });

    let m = await __mutex__.get('test');
    expect(m.Locked).to.be.true;

    await mutex_release(r.Mutex);

    await m.refresh();
    expect(m.Locked).to.be.false;
  });

  it('should not release by other tenant', async () => {
    const r = await mutex_acquire({
      Name: 'test',
      Tenant: 'test-1',
    });

    let m = await __mutex__.get('test');
    expect(m.Locked).to.be.true;

    await mutex_release({
      Name: 'test',
      Tenant: 'test-2',
    });

    await m.refresh();
    expect(m.Locked).to.be.true;
  });

  it('Should delete on release', async () => {
    const r = await mutex_acquire({
      Name: 'test',
      Tenant: 'test-1',
    });

    const m = await __mutex__.get('test');
    expect(m.Locked).to.be.true;

    await mutex_release(r.Mutex, true);

    const m2 = await __mutex__.get('test');
    expect(m2).to.be.undefined;
  });

  it('Should get', async () => {
    const r = await mutex_acquire({
      Name: 'test',
      Tenant: 'test-1',
    });

    const m = await mutex_get('test');
    expect(m).to.be.not.null;
    expect(m?.Name).to.eq('test');
    expect(m?.Tenant).to.eq('test-1');

    const m2 = await mutex_get('test2');
    expect(m2).to.be.undefined;
  });

  it('should wait', async () => {
    const r = await mutex_acquire({
      Name: 'test',
      Tenant: 'test-1',
    });

    setTimeout(async () => {
      await mutex_release({
        Name: 'test',
        Tenant: 'test-1',
      });
    }, 3000);

    const start = DateTime.now();

    await mutex_wait('test');

    const diff = DateTime.now().diff(start);
    expect(diff.milliseconds).to.be.gt(2500);
  });
});
