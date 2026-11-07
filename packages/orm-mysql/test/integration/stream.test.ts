/**
 * Streams against a live MySQL. Local only: CI covers MySQL streams through the orm-conformance suite.
 *
 *   docker compose --profile test up -d mysql
 *   npx ts-mocha -p tsconfig.json test/integration/stream.test.ts
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, HasMany, Model, ModelBase, Orm, Primary, QueryContext, Relation, StreamNotSupported } from '@spinajs/orm';
import '@spinajs/log';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import _ from 'lodash';
import 'mocha';
import { randomUUID } from 'node:crypto';
import sinon from 'sinon';

import { MySqlOrmDriver } from '../../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const SERVER = {
  Host: process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1',
  Port: Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306),
  User: process.env.ORM_TEST_MYSQL_USER ?? 'root',
  Password: process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root',
};

/** The transaction suite boots an Orm, because the keyset path needs a model; its database is created in `before`. */
const TX_DATABASE = `orm_stream_tx_${randomUUID().slice(0, 8)}`;

class StreamMySqlConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
        db: { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-mysql', Name: 'mysql-stream', ...SERVER, Database: TX_DATABASE, Migration: { OnStartup: false } }] },
      },
      (target: unknown, source: unknown) => (Array.isArray(target) ? target.concat(source) : undefined),
    );
  }
}

@Connection('mysql-stream')
@Model('stream_note')
class StreamNote extends ModelBase {
  @Primary()
  public Id: number;

  public Body: string;

  public doc_id: number;
}

@Connection('mysql-stream')
@Model('stream_doc')
class StreamDoc extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @HasMany(StreamNote, { foreignKey: 'doc_id', primaryKey: 'Id' })
  public Notes: Relation<StreamNote, StreamDoc>;
}

async function driverOn(database: string): Promise<MySqlOrmDriver> {
  const driver = await DI.child().resolve(MySqlOrmDriver, [{ Name: `stream-${database}`, Driver: 'orm-driver-mysql', ...SERVER, Database: database }]);
  await driver.connect();
  return driver;
}

async function collect<T>(source: AsyncIterable<T>, stopAfter = Number.POSITIVE_INFINITY): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) {
    out.push(item);
    if (out.length >= stopAfter) {
      break;
    }
  }
  return out;
}

describe('mysql stream (integration)', function () {
  this.timeout(60000);

  const database = `orm_stream_${randomUUID().slice(0, 8)}`;
  let admin: MySqlOrmDriver;
  let driver: MySqlOrmDriver;

  before(async () => {
    admin = await driverOn('mysql');
    await admin.schema().createDatabase(database);
    driver = await driverOn(database);
    await driver.executeOnDb('CREATE TABLE stream_t (Id INT PRIMARY KEY, Name VARCHAR(64) NOT NULL)', [], QueryContext.Schema);
    await driver
      .insert()
      .into('stream_t')
      .values(Array.from({ length: 1000 }, (_, i) => ({ Id: i + 1, Name: `n${i + 1}` })));
  });

  after(async () => {
    try {
      await admin?.executeOnDb(`DROP DATABASE IF EXISTS \`${database}\``, [], QueryContext.Schema);
    } finally {
      await driver?.disconnect();
      await admin?.disconnect();
    }
  });

  it('streams every row in order', async () => {
    const rows = (await collect(driver.select().from('stream_t').order('Id').stream({ batchSize: 100 }))) as Array<{ Id: number }>;

    expect(rows.map((r) => r.Id)).to.deep.equal(Array.from({ length: 1000 }, (_, i) => i + 1));
  });

  it('gives the pool its slot back when the loop breaks', async () => {
    await collect(driver.select().from('stream_t').order('Id').stream({ batchSize: 100 }), 150);

    expect(driver.poolMetrics().InUse).to.eq(0);
    const one = (await driver.executeOnDb('SELECT 1 AS one', [], QueryContext.Select)) as Array<{ one: number }>;
    expect(one[0].one).to.eq(1);
  });

  it('closes the socket when the loop breaks, so the server stops sending', async () => {
    // about 1 GB: the server is still writing when the loop leaves
    const marker = `spinajs-stream-close-${randomUUID().slice(0, 8)}`;
    const huge = `SELECT /* ${marker} */ a.Id, REPEAT('x', 1024) AS pad FROM stream_t a CROSS JOIN stream_t b`;
    await collect(driver.executeStreamOnDb(huge, [], { batchSize: 100 }), 150);

    const stillSending = async () => {
      const rows = (await admin.executeOnDb(`SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE ? AND ID <> CONNECTION_ID()`, [`%${marker}%`], QueryContext.Select)) as Array<{ n: number | string }>;
      return Number(rows[0].n);
    };
    for (let attempt = 0; attempt < 30 && (await stillSending()) > 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await stillSending()).to.eq(0);
  });

  it('refuses a raw select inside a transaction: no model, so no keyset page', async () => {
    const loop = driver.transaction(async () => collect(driver.select().from('stream_t').order('Id').stream({ batchSize: 10 }), 5));

    await expect(loop).to.be.rejectedWith(StreamNotSupported);
    const one = (await driver.executeOnDb('SELECT 1 AS one', [], QueryContext.Select)) as Array<{ one: number }>;
    expect(one[0].one).to.eq(1);
  });
});

describe('mysql stream inside a transaction (integration)', function () {
  this.timeout(60000);

  let orm: Orm | undefined;
  let driver: MySqlOrmDriver;

  before(async () => {
    const admin = await driverOn('mysql');
    await admin.schema().createDatabase(TX_DATABASE);
    await admin.disconnect();

    DI.clearCache();
    DI.register(StreamMySqlConf).as(Configuration);
    DI.register(MySqlOrmDriver).as('orm-driver-mysql');
    orm = await DI.resolve(Orm);
    driver = orm.Connections.get('mysql-stream') as MySqlOrmDriver;
    await driver.executeOnDb('CREATE TABLE stream_doc (Id INT PRIMARY KEY, Name VARCHAR(64) NOT NULL)', [], QueryContext.Schema);
    await driver.executeOnDb('CREATE TABLE stream_note (Id INT AUTO_INCREMENT PRIMARY KEY, Body VARCHAR(64) NOT NULL, doc_id INT NOT NULL)', [], QueryContext.Schema);
    await driver
      .insert()
      .into('stream_doc')
      .values(Array.from({ length: 300 }, (_, i) => ({ Id: i + 1, Name: `d${i + 1}` })));
    await driver
      .insert()
      .into('stream_note')
      .values([
        { Body: 'first', doc_id: 1 },
        { Body: 'last', doc_id: 300 },
      ]);
    await orm.reloadTableInfo();
  });

  afterEach(() => sinon.restore());

  after(async () => {
    try {
      await orm?.dispose();
    } finally {
      DI.unregister(StreamMySqlConf);
      DI.clearCache();
      const admin = await driverOn('mysql');
      await admin.executeOnDb(`DROP DATABASE IF EXISTS \`${TX_DATABASE}\``, [], QueryContext.Schema);
      await admin.disconnect();
    }
  });

  it('pages by keyset inside a transaction, populates every batch and runs statements in the loop body', async () => {
    const cursor = sinon.spy(driver, 'executeStreamOnDb');

    const docs = await driver.transaction(async () => {
      const seen: StreamDoc[] = [];
      for await (const doc of StreamDoc.select().order('Id').populate('Notes').stream({ batchSize: 64 })) {
        // a second statement on the transaction's connection: mysql2 would queue it behind the paused stream for ever
        await driver.update().in('stream_doc').update({ Name: `seen-${doc.Id}` }).where({ Id: doc.Id });
        seen.push(doc);
      }
      return seen;
    });

    expect(docs).to.have.length(300);
    expect(cursor.callCount).to.eq(0);
    expect(docs[0].Notes.map((n) => n.Body)).to.deep.equal(['first']);
    expect(docs[299].Notes.map((n) => n.Body)).to.deep.equal(['last']);
    const renamed = (await driver.executeOnDb(`SELECT COUNT(*) AS n FROM stream_doc WHERE Name LIKE 'seen-%'`, [], QueryContext.Select)) as Array<{ n: number | string }>;
    expect(Number(renamed[0].n)).to.eq(300);
  });
});
