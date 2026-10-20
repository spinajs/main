import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm, OrmDriver, QueryContext } from '@spinajs/orm';
import { Mutex, mutex_acquire, mutex_create, mutex_renew } from '@spinajs/threading';
import '@spinajs/log';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import _ from 'lodash';
import { OrmMutex, dbNowMs } from '../../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function mutexContract(title: string, connection: { Name: string; Driver: string; [key: string]: unknown }) {
  class Conf extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();

      _.mergeWith(
        this.Config,
        {
          logger: {
            targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
            rules: [{ name: '*', level: 'error', target: 'Empty' }],
          },
          db: {
            DefaultConnection: connection.Name,
            Connections: [{ ...connection, Pool: { Max: 10 }, Migration: { Table: 'orm_migrations_mutex', OnStartup: true } }],
          },
        },
        (target: any, source: any) => (_.isArray(target) ? target.concat(source) : undefined),
      );
    }
  }

  const driver = () => DI.get(Orm)!.Connections.get(connection.Name)! as OrmDriver & { executeOnDb: Function };

  describe(title, function () {
    this.timeout(30000);

    before(() => {
      DI.register(OrmMutex).as(Mutex);
      DI.register(Conf).as(Configuration);
    });

    beforeEach(async () => {
      await DI.resolve(Configuration);
      await DI.resolve(Orm);
      await driver().executeOnDb('DELETE FROM __mutex__', [], QueryContext.Delete);
    });

    afterEach(async () => {
      for (const c of new Set(DI.get(Orm)?.Connections.values() ?? [])) {
        await c.disconnect();
      }
      DI.clearCache();
    });

    it('Should read the database clock', async () => {
      expect(Math.abs((await dbNowMs(driver())) - Date.now())).to.be.lessThan(5000);
    });

    it('Should grant exactly one of 20 concurrent acquires on an existing mutex', async () => {
      await mutex_create({ Name: 'race', Tenant: 'creator' });

      const results = await Promise.all(Array.from({ length: 20 }, (_v, i) => mutex_acquire({ Name: 'race', Tenant: `replica-${i}` })));

      expect(results.filter((r) => r.Locked)).to.have.length(1);
    });

    it('Should grant exactly one of 20 concurrent acquires on a missing mutex', async () => {
      const results = await Promise.all(Array.from({ length: 20 }, (_v, i) => mutex_acquire({ Name: 'race', Tenant: `replica-${i}` })));

      expect(results.filter((r) => r.Locked)).to.have.length(1);
    });

    // MySQL reports matched rows only because mysql2 sets CLIENT_FOUND_ROWS by default
    it('Should let the holder acquire again with ttl 0', async () => {
      expect((await mutex_acquire({ Name: 'reentrant', Tenant: 'a', ttl: 0 })).Locked).to.be.true;
      expect((await mutex_acquire({ Name: 'reentrant', Tenant: 'a', ttl: 0 })).Locked).to.be.true;
    });

    it('Should let another tenant take an expired lock', async () => {
      await mutex_acquire({ Name: 'ttl', Tenant: 'a', ttl: 300 });
      await sleep(500);

      expect((await mutex_acquire({ Name: 'ttl', Tenant: 'b', ttl: 300 })).Locked).to.be.true;
    });

    it('Should keep a renewed lock past its first expiry', async () => {
      await mutex_acquire({ Name: 'renew', Tenant: 'a', ttl: 600 });
      await sleep(300);
      expect(await mutex_renew({ Name: 'renew', Tenant: 'a', ttl: 600 })).to.be.true;
      await sleep(400);

      expect((await mutex_acquire({ Name: 'renew', Tenant: 'b', ttl: 600 })).Locked).to.be.false;
    });
  });
}
