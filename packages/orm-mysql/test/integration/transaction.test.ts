/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Integration coverage for the transaction contract against a **live** MySQL.
 *
 * Requires the docker service:
 *
 *   docker compose --profile test up -d mysql
 *   npm run test:integration --workspace=@spinajs/orm-mysql
 *
 * Connection settings come from ORM_TEST_MYSQL_* (see README).
 *
 * These assert what the stubbed-pool unit tests in `test/transaction-unit.test.ts` cannot:
 * that the server actually commits, actually rolls back, actually honours savepoints, and
 * that pooled connections come back.
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
// Registers the concrete Log implementation — `Orm` types its logger as the ABSTRACT `Log`
// from @spinajs/log-common, so without this `Orm.createConnections` dies on
// `this.Log.trace is not a function`.
import '@spinajs/log';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import _ from 'lodash';
import 'mocha';

import { MySqlOrmDriver } from '../../src/index.js';
import { IntegrationUser } from './models/IntegrationUser.js';
import './migrations/IntegrationTransactionMigration_2026_07_25_00_00_00.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const HOST = process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.ORM_TEST_MYSQL_PORT ?? 3900);
const USER = process.env.ORM_TEST_MYSQL_USER ?? 'root';
const PASSWORD = process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root';
const DATABASE = process.env.ORM_TEST_MYSQL_DATABASE ?? 'test';

/**
 * A pool of 2 is the whole point of the connection-release test: with a leak, the third
 * transaction has nothing to acquire and the suite hangs instead of passing quietly.
 */
const POOL_LIMIT = 2;

export class IntegrationConf extends FrameworkConfiguration {
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
          Migration: { Startup: false },
          Connections: [
            {
              Driver: 'orm-driver-mysql',
              Name: 'mysql',
              Host: HOST,
              Port: PORT,
              User: USER,
              Password: PASSWORD,
              Database: DATABASE,
              PoolLimit: POOL_LIMIT,
              // OnStartup MUST be true here. `Orm.resolve()` runs migrations and then
              // immediately calls `reloadTableInfo()`, and the MySQL driver *throws*
              // `Table <db>.<name> does not exist` for a missing table
              // (orm-mysql/src/index.ts:217) where the SQLite driver returns null.
              // With OnStartup false the migration is skipped by design, so resolve()
              // blows up before the suite can migrate by hand.
              Migration: { Table: 'orm_migrations_integration', OnStartup: true },
            },
          ],
        },
      },
      (target: any, source: any) => (_.isArray(target) ? target.concat(source) : undefined),
    );
  }
}

function db() {
  return DI.get(Orm)!;
}

function driver() {
  return db().Connections.get('mysql')!;
}

describe('MySQL transaction contract (integration)', function () {
  // container round-trips are slower than the 2s mocha default
  this.timeout(30000);

  before(async () => {
    DI.clearCache();
    DI.register(IntegrationConf).as(Configuration);
    DI.register(MySqlOrmDriver).as('orm-driver-mysql');
    await DI.resolve(Orm);
    await db().migrateUp();
    // model descriptors get their columns from the live schema; without this the
    // insert compiler has no columns to work with
    await db().reloadTableInfo();
  });

  beforeEach(async () => {
    await driver().truncate('integration_user');
  });

  after(async () => {
    await driver().disconnect();
    DI.clearCache();
  });

  it('commits on success', async () => {
    await driver().transaction(async () => {
      await IntegrationUser.create({ Name: 'a' });
    });

    expect(await IntegrationUser.count()).to.equal(1);
  });

  it('returns the callback result', async () => {
    const result = await driver().transaction(async () => 'the-value');
    expect(result).to.equal('the-value');
  });

  it('rolls back on throw', async () => {
    await expect(
      driver().transaction(async () => {
        await IntegrationUser.create({ Name: 'a' });
        throw new Error('boom');
      }),
    ).to.be.rejectedWith('boom');

    expect(await IntegrationUser.count()).to.equal(0);
  });

  it('propagates the transaction connection to model writes inside the callback', async () => {
    // If the ambient context were not propagated, this row would be written on a pooled
    // connection outside the transaction and would survive the rollback.
    await driver()
      .transaction(async () => {
        await IntegrationUser.create({ Name: 'ambient' });
        expect(await IntegrationUser.count()).to.equal(1);
        throw new Error('discard');
      })
      .catch(() => undefined);

    expect(await IntegrationUser.count()).to.equal(0);
  });

  it('inner savepoint rolls back without discarding the outer transaction', async () => {
    await driver().transaction(async () => {
      await IntegrationUser.create({ Name: 'outer' });

      await driver()
        .transaction(async () => {
          await IntegrationUser.create({ Name: 'inner' });
          throw new Error('inner fails');
        })
        .catch(() => undefined);
    });

    const rows = await IntegrationUser.all();
    expect(rows.map((r) => r.Name)).to.deep.equal(['outer']);
  });

  it('a nested transaction that succeeds folds into the outer commit', async () => {
    await driver().transaction(async () => {
      await IntegrationUser.create({ Name: 'outer' });
      await driver().transaction(async () => {
        await IntegrationUser.create({ Name: 'inner' });
      });
    });

    const rows = await IntegrationUser.all();
    expect(rows.map((r) => r.Name).sort()).to.deep.equal(['inner', 'outer']);
  });

  it('releases the pooled connection', async () => {
    // PoolLimit is 2; if connections leaked this would exhaust the pool and hang long
    // before iteration 50, failing on the suite timeout rather than passing quietly.
    for (let i = 0; i < 50; i++) {
      await driver().transaction(async () => {
        await IntegrationUser.count();
      });
    }

    expect(await IntegrationUser.count()).to.equal(0);
  });

  it('releases the pooled connection on the rollback path too', async () => {
    for (let i = 0; i < 50; i++) {
      await driver()
        .transaction(async () => {
          throw new Error('nope');
        })
        .catch(() => undefined);
    }

    expect(await IntegrationUser.count()).to.equal(0);
  });

  it('accepts a supported isolation level', async () => {
    await driver().transaction(
      async () => {
        await IntegrationUser.create({ Name: 'serializable' });
      },
      { isolation: 'SERIALIZABLE' },
    );

    expect(await IntegrationUser.count()).to.equal(1);
  });
});
