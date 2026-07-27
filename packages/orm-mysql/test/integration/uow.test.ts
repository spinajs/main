/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Integration coverage for `save()` against a **live** MySQL.
 *
 * Requires the docker service:
 *
 *   docker compose --profile test up -d mysql
 *   npm run test:integration --workspace=@spinajs/orm-mysql
 *
 * Connection settings come from ORM_TEST_MYSQL_* (see README).
 *
 * A second engine matters here specifically: SQLite does not enforce foreign keys unless
 * `PRAGMA foreign_keys=ON`, so the sqlite suite exercises the topological insert order
 * without ever proving it. The migration below declares real FK constraints, and MySQL
 * rejects a child row written before its parent — so a wrong sort fails loudly.
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm, QueryContext } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import _ from 'lodash';
import 'mocha';

import { MySqlOrmDriver } from '../../src/index.js';
import { IntegrationUowClient, IntegrationUowOrder, IntegrationUowOrderItem } from './models/IntegrationUowOrder.js';
import './migrations/IntegrationUowMigration_2026_07_26_00_00_00.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const HOST = process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.ORM_TEST_MYSQL_PORT ?? 3900);
const USER = process.env.ORM_TEST_MYSQL_USER ?? 'root';
const PASSWORD = process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root';
const DATABASE = process.env.ORM_TEST_MYSQL_DATABASE ?? 'test';

/**
 * A pool of 2 is the whole point of the connection-release test: with a leak, the third
 * save has nothing to acquire and the suite hangs instead of passing quietly.
 */
const POOL_LIMIT = 2;

export class UowIntegrationConf extends FrameworkConfiguration {
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
              // OnStartup MUST be true here — see the note in transaction.test.ts:
              // Orm.resolve() migrates and then immediately reloads table info, and the
              // MySQL driver throws for a missing table where SQLite returns null.
              // The SAME ledger the other two integration suites use. @Migration registers
              // globally on import and mocha loads every file into one process, so
              // migrateUp() here also sees theirs. With a private ledger it would find no
              // applied migrations and re-run them, failing on `Table ... already exists`.
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

describe('MySQL save() integration', function () {
  // container round-trips are slower than the 2s mocha default
  this.timeout(30000);

  before(async () => {
    DI.clearCache();
    DI.register(UowIntegrationConf).as(Configuration);
    DI.register(MySqlOrmDriver).as('orm-driver-mysql');
    await DI.resolve(Orm);
    await db().migrateUp();
    await db().reloadTableInfo();
  });

  beforeEach(async () => {
    // DELETE, not truncate(): MySQL refuses to TRUNCATE any table named in a foreign-key
    // constraint, empty or not. Child-first so the deletes themselves satisfy the constraints.
    const connection = driver() as any;
    await connection.executeOnDb('DELETE FROM uow_order_item', [] as any, QueryContext.Delete);
    await connection.executeOnDb('DELETE FROM uow_order', [] as any, QueryContext.Delete);
    await connection.executeOnDb('DELETE FROM uow_client', [] as any, QueryContext.Delete);
  });

  after(async () => {
    await driver().disconnect();
    DI.clearCache();
  });

  it('commits a whole graph', async () => {
    const order = new IntegrationUowOrder({ Total: 120 });
    order.Client.attach(new IntegrationUowClient({ Name: 'acme' }));
    (order.Items as any).Populated = true;
    order.Items.push(new IntegrationUowOrderItem({ Sku: 'A' }), new IntegrationUowOrderItem({ Sku: 'B' }));

    const result = await order.save();

    expect(result.Inserted).to.equal(4);
    expect(await IntegrationUowOrderItem.count()).to.equal(2);
  });

  it('satisfies real foreign-key constraints - the parent is written first', async () => {
    const order = new IntegrationUowOrder({ Total: 1 });
    order.Client.attach(new IntegrationUowClient({ Name: 'acme' }));
    (order.Items as any).Populated = true;
    order.Items.push(new IntegrationUowOrderItem({ Sku: 'A' }));

    // Would raise ER_NO_REFERENCED_ROW_2 if the sort were wrong.
    await order.save();

    const persisted = await IntegrationUowOrder.where({ Id: order.Id }).first();
    expect(persisted.client_id).to.be.a('number');
  });

  it('rolls the whole graph back when a statement partway through fails', async () => {
    const order = new IntegrationUowOrder({ Total: 1 });
    (order.Items as any).Populated = true;
    order.Items.push(new IntegrationUowOrderItem({ Sku: 'A' }), new IntegrationUowOrderItem({ Sku: 'B' }));

    const connection: any = DI.get(Orm)!.Connections.get('mysql')!;
    const original = connection.execute.bind(connection);
    let seen = 0;
    connection.execute = async (builder: any) => {
      seen += 1;
      if (seen === 3) {
        throw new Error('boom');
      }
      return await original(builder);
    };

    try {
      await expect(order.save()).to.be.rejectedWith('boom');
    } finally {
      connection.execute = original;
    }

    expect(await IntegrationUowOrder.count()).to.equal(0);
    expect(await IntegrationUowOrderItem.count()).to.equal(0);
  });

  it('deletes orphans in an order the foreign keys accept', async () => {
    const order = new IntegrationUowOrder({ Total: 1 });
    (order.Items as any).Populated = true;
    order.Items.push(new IntegrationUowOrderItem({ Sku: 'A' }), new IntegrationUowOrderItem({ Sku: 'B' }));
    await order.save();

    order.Items.empty();
    const result = await order.save();

    expect(result.Deleted).to.equal(2);
    expect(await IntegrationUowOrderItem.count()).to.equal(0);
    expect(await IntegrationUowOrder.count()).to.equal(1);
  });

  it('releases the pooled connection on every path', async () => {
    // POOL_LIMIT is 2; a leak makes the third save hang rather than fail.
    for (let i = 0; i < 5; i += 1) {
      await new IntegrationUowOrder({ Total: i }).save();
    }

    expect(await IntegrationUowOrder.count()).to.equal(5);
  });
});
