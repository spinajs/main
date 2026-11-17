/**
 * A stream inside a transaction, against a live SQL Server. CI: .github/workflows/orm-mssql.yml.
 *
 *   docker compose --profile test up -d mssql mssql-init
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { Connection, HasMany, Model, ModelBase, Orm, Primary, QueryContext, Relation } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import _ from 'lodash';
import 'mocha';
import sinon from 'sinon';

import { MsSqlOrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const SERVER = {
  Host: 'localhost',
  User: 'sa',
  Password: 'yourStrong(!)Password',
  Database: 'test',
  Options: { TrustServerCertificate: true },
};

class StreamMsSqlConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
        db: { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-mssql', Name: 'mssql-stream', ...SERVER, Options: { ...SERVER.Options, Schema: 'dbo' }, Migration: { OnStartup: false } }] },
      },
      (target: unknown, source: unknown) => (Array.isArray(target) ? target.concat(source) : undefined),
    );
  }
}

@Connection('mssql-stream')
@Model('stream_tx_note')
class StreamTxNote extends ModelBase {
  @Primary()
  public Id: number;

  public Body: string;

  public doc_id: number;
}

@Connection('mssql-stream')
@Model('stream_tx_doc')
class StreamTxDoc extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @HasMany(StreamTxNote, { foreignKey: 'doc_id', primaryKey: 'Id' })
  public Notes: Relation<StreamTxNote, StreamTxDoc>;
}

describe('mssql stream inside a transaction', function () {
  this.timeout(60000);

  let orm: Orm | undefined;
  let driver: MsSqlOrmDriver;

  before(async () => {
    DI.clearCache();
    DI.register(StreamMsSqlConf).as(Configuration);
    DI.register(MsSqlOrmDriver).as('orm-driver-mssql');
    orm = await DI.resolve(Orm);
    driver = orm.Connections.get('mssql-stream') as MsSqlOrmDriver;
    await driver.executeOnDb('DROP TABLE IF EXISTS [stream_tx_note]; DROP TABLE IF EXISTS [stream_tx_doc]', [], QueryContext.Schema);
    await driver.executeOnDb('CREATE TABLE [stream_tx_doc] ([Id] INT PRIMARY KEY, [Name] NVARCHAR(64) NOT NULL)', [], QueryContext.Schema);
    await driver.executeOnDb('CREATE TABLE [stream_tx_note] ([Id] INT IDENTITY PRIMARY KEY, [Body] NVARCHAR(64) NOT NULL, [doc_id] INT NOT NULL)', [], QueryContext.Schema);
    await driver
      .insert()
      .into('stream_tx_doc')
      .values(Array.from({ length: 300 }, (_, i) => ({ Id: i + 1, Name: `d${i + 1}` })));
    await driver
      .insert()
      .into('stream_tx_note')
      .values([
        { Body: 'first', doc_id: 1 },
        { Body: 'last', doc_id: 300 },
      ]);
    await orm.reloadTableInfo();
  });

  afterEach(() => sinon.restore());

  after(async () => {
    await driver?.executeOnDb('DROP TABLE IF EXISTS [stream_tx_note]; DROP TABLE IF EXISTS [stream_tx_doc]', [], QueryContext.Schema);
    await orm?.dispose();
    DI.unregister(StreamMsSqlConf);
    DI.clearCache();
  });

  it('pages by keyset inside a transaction, populates every batch and runs statements in the loop body', async () => {
    const cursor = sinon.spy(driver, 'executeStreamOnDb');

    const docs = await driver.transaction(async () => {
      const seen: StreamTxDoc[] = [];
      for await (const doc of StreamTxDoc.select().order('Id').populate('Notes').stream({ batchSize: 64 })) {
        // a second request on the transaction: the stream pages by keyset here and never opens a cursor on its connection
        await driver.update().in('stream_tx_doc').update({ Name: `seen-${doc.Id}` }).where({ Id: doc.Id });
        seen.push(doc);
      }
      return seen;
    });

    expect(docs).to.have.length(300);
    expect(cursor.callCount).to.eq(0);
    expect(docs[0].Notes.map((n) => n.Body)).to.deep.equal(['first']);
    expect(docs[299].Notes.map((n) => n.Body)).to.deep.equal(['last']);
    const renamed = (await driver.executeOnDb(`SELECT COUNT(*) AS n FROM [stream_tx_doc] WHERE [Name] LIKE 'seen-%'`, [], QueryContext.Select)) as Array<{ n: number }>;
    expect(renamed[0].n).to.eq(300);
  });
});
