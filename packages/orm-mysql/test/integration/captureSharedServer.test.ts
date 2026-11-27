/**
 * The write capture of a save that writes a model of another connection on the same server: the write runs on the
 * save's connection, inside its transaction, and so must the capture's locking key select. A key select on the model's
 * own connection waits on the row lock of the transaction it serves.
 *
 * Connection settings come from ORM_TEST_MYSQL_* (see README); the two databases are ORM_TEST_MYSQL_CAPTURE_DATABASE
 * with `_a` and `_b` appended.
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, HasMany, Model, ModelBase, Orm, OrphanPolicy, Primary, QueryContext, Relation, WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, WriteStatement } from '@spinajs/orm';
import '@spinajs/log';
import { expect } from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { MySqlOrmDriver } from '../../src/index.js';

const SERVER = {
  Host: process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1',
  Port: Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306),
  User: process.env.ORM_TEST_MYSQL_USER ?? 'root',
  Password: process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root',
};
const PREFIX = process.env.ORM_TEST_MYSQL_CAPTURE_DATABASE ?? `orm_capture_shared_${randomUUID().slice(0, 8)}`;
const ROOT_DATABASE = `${PREFIX}_a`;
const ITEM_DATABASE = `${PREFIX}_b`;

@Connection('shared-b')
@Model('shared_item')
class SharedItem extends ModelBase {
  @Primary()
  public Id: number;

  public Sku: string;

  public Qty: number;

  public order_id: number;
}

@Connection('shared-a')
@Model('shared_order')
class SharedOrder extends ModelBase {
  @Primary()
  public Id: number;

  public Total: number;

  @HasMany(SharedItem, { foreignKey: 'order_id', primaryKey: 'Id', orphan: OrphanPolicy.Delete })
  public Items: Relation<SharedItem, SharedOrder>;
}

const writes: CapturedWrite[] = [];

class Recorder extends WriteObserver {
  interest({ model }: WriteStatement): CaptureInterest | undefined {
    return model === SharedItem ? { columns: '*', transactional: true } : undefined;
  }

  async observe(write: CapturedWrite): Promise<void> {
    writes.push(write);
  }
}

class SharedServerConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config.logger = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };
    this.Config.db = {
      ...(this.Config.db as object),
      Migration: { Startup: false },
      StrictTableCheck: false,
      DefaultConnection: 'shared-a',
      Connections: [
        { Driver: 'orm-driver-mysql', Name: 'shared-a', ...SERVER, Database: ROOT_DATABASE, SharedServer: 'mysql' },
        // One pooled connection keeps the session's lock wait timeout set below, and no retry: a lock wait timeout is
        // retried outside a transaction, so a key select waiting on the save's own lock would wait several times.
        { Driver: 'orm-driver-mysql', Name: 'shared-b', ...SERVER, Database: ITEM_DATABASE, SharedServer: 'mysql', Pool: { Max: 1 }, Resilience: { MaxRetries: 0 } },
      ],
    };
  }
}

const connection = (name: string) => DI.get(Orm)!.Connections.get(name)!;

describe('mysql write capture of a save through another connection on the same server (integration)', function () {
  this.timeout(60000);

  let admin: MySqlOrmDriver;
  const sql = (statement: string) => admin.executeOnDb(statement, [], QueryContext.Schema);
  const items = () => admin.executeOnDb(`SELECT * FROM \`${ITEM_DATABASE}\`.shared_item ORDER BY Id`, [], QueryContext.Select);
  const captured = () => writes.map((w) => [w.kind, w.rows]);

  before(async () => {
    admin = await DI.child().resolve(MySqlOrmDriver, [{ Name: 'shared-admin', Driver: 'orm-driver-mysql', ...SERVER, Database: 'mysql' }]);
    await admin.connect();
    for (const database of [ROOT_DATABASE, ITEM_DATABASE]) await admin.schema().createDatabase(database);
    await sql(`CREATE TABLE \`${ROOT_DATABASE}\`.shared_order (Id INT AUTO_INCREMENT PRIMARY KEY, Total INT NOT NULL)`);
    await sql(`CREATE TABLE \`${ITEM_DATABASE}\`.shared_item (Id INT AUTO_INCREMENT PRIMARY KEY, Sku VARCHAR(8) NOT NULL, Qty INT NOT NULL, order_id INT NOT NULL)`);

    DI.clearCache();
    DI.register(SharedServerConf).as(Configuration);
    DI.register(MySqlOrmDriver).as('orm-driver-mysql');
    DI.register(Recorder).as(WriteObserver);
    await DI.resolve(Orm);
  });

  beforeEach(async () => {
    await sql(`TRUNCATE TABLE \`${ROOT_DATABASE}\`.shared_order`);
    await sql(`TRUNCATE TABLE \`${ITEM_DATABASE}\`.shared_item`);
    const own = connection('shared-b');
    if (!(own instanceof MySqlOrmDriver)) throw new Error('shared-b is not a MySQL connection');
    // Through the pool, not schema(): a schema statement runs on a connection of its own.
    await own.executeOnDb('SET SESSION innodb_lock_wait_timeout = 2', [], QueryContext.Select);
    writes.length = 0;
  });

  after(async () => {
    for (const name of ['shared-a', 'shared-b']) await DI.get(Orm)?.Connections.get(name)?.disconnect();
    DI.unregister(Recorder);
    DI.clearCache();
    for (const database of [ROOT_DATABASE, ITEM_DATABASE]) await sql(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.disconnect();
  });

  const first = { Id: 1, Sku: 'A', Qty: 1, order_id: 1 };

  // The row is written by raw SQL on the root connection, inside its transaction: a save's insert of a model of another
  // database is not qualified on this base, and the capture's key select is only needed by the update and the delete.
  async function savedWithItem() {
    const order = new SharedOrder({ Total: 1 });
    await order.save();
    await connection('shared-a').schema().raw(`INSERT INTO \`${ITEM_DATABASE}\`.shared_item (Id, Sku, Qty, order_id) VALUES (1, 'A', 1, 1)`);
    const item = new SharedItem({ ...first });
    item.takeSnapshot();
    order.Items.push(item);
    await order.save();
    return { order, item };
  }

  it('updates a row the same transaction inserted, without waiting on its lock', async () => {
    await connection('shared-a').transaction(async () => {
      const { order, item } = await savedWithItem();
      item.Qty = 5;
      await order.save();
    });

    expect(captured()).to.deep.equal([['update', [{ id: '1', before: first, after: { ...first, Qty: 5 } }]]]);
    expect(await items()).to.deep.equal([{ ...first, Qty: 5 }]);
  });

  it('deletes as an orphan a row the same transaction inserted, without waiting on its lock', async () => {
    await connection('shared-a').transaction(async () => {
      const { order } = await savedWithItem();
      order.Items.empty();
      await order.save();
    });

    expect(captured()).to.deep.equal([['delete', [{ id: '1', before: first, after: undefined }]]]);
    expect(await items()).to.deep.equal([]);
  });
});
