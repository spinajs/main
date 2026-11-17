import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI, type ContainerSnapshot } from '@spinajs/di';
import { Clock, DbTimeSource } from '@spinajs/durable';
import { FakeClock } from '@spinajs/durable/testing';
import { MigrationTransactionMode, Orm, type OrmDriver } from '@spinajs/orm';
import '@spinajs/orm-mysql';
import '@spinajs/orm-postgres';
import '@spinajs/orm-sqlite';
import { OUTBOX_TABLE, OutboxRelay, QueueService } from '../../src/index.js';
import { broker, OrderPlaced, orderIdOf, outboxRows, T0 } from '../support/outbox-env.js';

chai.use(chaiAsPromised);
const { expect } = chai;

const MIGRATIONS_TABLE = 'queue_outbox_it_migrations';

interface Target {
  name: 'postgres' | 'mysql';
  enabled: boolean;
  connection: Record<string, unknown>;
}

const env = process.env;
const TARGETS: Target[] = [
  {
    name: 'postgres',
    enabled: !!env.SPINAJS_TEST_PG_HOST,
    connection: {
      Driver: 'orm-driver-postgres',
      Host: env.SPINAJS_TEST_PG_HOST,
      Port: Number(env.SPINAJS_TEST_PG_PORT ?? 5432),
      User: env.SPINAJS_TEST_PG_USER ?? 'postgres',
      Password: env.SPINAJS_TEST_PG_PASSWORD ?? 'postgres',
      Database: env.SPINAJS_TEST_PG_DB ?? 'spinajs_queue_outbox_test',
    },
  },
  {
    name: 'mysql',
    enabled: !!env.SPINAJS_TEST_MYSQL_HOST,
    connection: {
      Driver: 'orm-driver-mysql',
      Host: env.SPINAJS_TEST_MYSQL_HOST,
      Port: Number(env.SPINAJS_TEST_MYSQL_PORT ?? 3306),
      User: env.SPINAJS_TEST_MYSQL_USER ?? 'root',
      Password: env.SPINAJS_TEST_MYSQL_PASSWORD ?? '',
      Database: env.SPINAJS_TEST_MYSQL_DB ?? 'spinajs_queue_outbox_test',
    },
  },
];

let current: Target | undefined;

// One class at module level: DI keeps the first class registered under a name, so a class per target would boot
// every target against the first one's server.
class RealDbConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
      db: {
        DefaultConnection: 'orders',
        Connections: [
          { ...current?.connection, Name: 'orders', Migration: { OnStartup: true, Table: MIGRATIONS_TABLE, Transaction: { Mode: MigrationTransactionMode.PerMigration } } },
          { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'queue', Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } } },
        ],
      },
      queue: {
        default: 'bus-a',
        routing: {},
        connections: [{ service: 'RecordingQueueClient', name: 'bus-a', defaultQueueChannel: '/queue/a', defaultTopicChannel: '/topic/a' }],
        outbox: { enabled: true, relay: false, connections: ['orders'], backoff: { backoff: 'fixed', delay: 1000 } },
      },
    };
  }
}

async function ordersConnection(): Promise<OrmDriver> {
  const driver = (await DI.resolve(Orm)).Connections.get('orders');
  if (!driver) throw new Error('the orders connection did not open');
  return driver;
}

/** The migrator keeps its lock in `<table>_lock`; all three go together, so the next boot migrates again. */
async function dropOutboxTables(driver: OrmDriver): Promise<void> {
  await driver.schema().dropTable(OUTBOX_TABLE).ifExists();
  await driver.schema().dropTable(MIGRATIONS_TABLE).ifExists();
  await driver.schema().dropTable(`${MIGRATIONS_TABLE}_lock`).ifExists();
}

for (const target of TARGETS) {
  (target.enabled ? describe : describe.skip)(`queue outbox on ${target.name}`, function () {
    this.timeout(60_000);
    let beforeBoot: ContainerSnapshot | undefined;
    let orders: OrmDriver | undefined;

    beforeEach(async () => {
      DI.clearCache();
      beforeBoot = DI.snapshot();
      broker.reset();
      current = target;
      const clock = new FakeClock(T0);
      DI.register(RealDbConf).as(Configuration);
      DI.register(() => clock).as(Clock);
      DI.register(() => clock.dbSource).as(DbTimeSource);
      await DI.resolve(Configuration);
      // resolving the Orm runs the startup migrations, so the table exists from here on
      orders = await ordersConnection();
      await (await DI.resolve(Orm)).Migrator.ready();
      // rows of a run that died before its afterEach
      await orders.del().from(OUTBOX_TABLE).where('Id', '>', 0);
    });

    afterEach(async () => {
      if (orders) await dropOutboxTables(orders);
      orders = undefined;
      if (beforeBoot) await DI.restore(beforeBoot);
      beforeBoot = undefined;
      DI.clearCache();
    });

    it('writes in the transaction, claims, publishes, records a failure and backs off on a real server', async () => {
      const queue = await DI.resolve(QueueService);
      const driver = await ordersConnection();
      await driver.transaction(() => queue.emit(new OrderPlaced({ OrderId: '1' })));
      await driver.transaction(() => queue.emit(new OrderPlaced({ OrderId: '2' })));
      await expect(
        driver.transaction(async () => {
          await queue.emit(new OrderPlaced({ OrderId: '3' }));
          throw new Error('business change failed');
        }),
      ).to.be.rejectedWith('business change failed');
      broker.failures.set('bus-a', [new Error('down')]);
      const relay = await DI.resolve(OutboxRelay, [{ replicaId: 'it', autoStart: false }]);
      await relay.tick();
      const rows = await outboxRows(driver);
      expect(rows.map((r) => [r.Status, r.Attempts])).to.deep.equal([
        ['pending', 1],
        ['published', 0],
      ]);
      // the stored BIGINT epoch milliseconds survive toOutboxRow's Number() exactly, whatever type the driver hands it
      expect(rows[0].AvailableAt).to.equal(T0 + 1000);
      expect(rows[1].PublishedAt).to.equal(T0);
      expect(broker.sent.map((s) => orderIdOf(s.message))).to.deep.equal(['2']);
    });
  });
}
