import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { Connection, HasMany, Model, ModelBase, Orm, Primary, QueryContext, Relation, StreamNotSupported } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import sinon from 'sinon';
import { PgliteOrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

class PgliteStreamConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    Object.assign(this.Config, {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
      db: { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-pglite', Name: 'pglite', Filename: ':memory:', Migration: { OnStartup: false } }] },
    });
  }
}

@Connection('pglite')
@Model('pgl_stream_note')
class PglStreamNote extends ModelBase {
  @Primary()
  public Id: number;

  public Body: string;

  public item_id: number;
}

@Connection('pglite')
@Model('pgl_stream')
class PglStream extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @HasMany(PglStreamNote, { foreignKey: 'item_id', primaryKey: 'Id' })
  public Notes: Relation<PglStreamNote, PglStream>;
}

describe('stream() on PGlite', function () {
  this.timeout(60000);

  let orm: Orm | undefined;
  let driver: PgliteOrmDriver;

  before(async () => {
    DI.clearCache();
    DI.register(PgliteStreamConf).as(Configuration);
    DI.register(PgliteOrmDriver).as('orm-driver-pglite');
    orm = await DI.resolve(Orm);
    driver = orm.Connections.get('pglite') as PgliteOrmDriver;
    await driver.executeOnDb('CREATE TABLE pgl_stream ("Id" int PRIMARY KEY, "Name" text NOT NULL)', [], QueryContext.Schema);
    await driver.executeOnDb(`INSERT INTO pgl_stream ("Id", "Name") SELECT g, 'n' || g FROM generate_series(1, 300) g`, [], QueryContext.Insert);
    await driver.executeOnDb('CREATE TABLE pgl_stream_note ("Id" serial PRIMARY KEY, "Body" text NOT NULL, "item_id" int NOT NULL)', [], QueryContext.Schema);
    await driver.executeOnDb(`INSERT INTO pgl_stream_note ("Body", "item_id") VALUES ('first', 1), ('last', 300)`, [], QueryContext.Insert);
    await orm.reloadTableInfo();
  });

  afterEach(() => sinon.restore());

  after(async () => {
    await orm?.dispose();
    DI.unregister(PgliteStreamConf);
    DI.clearCache();
  });

  it('pages by keyset inside a transaction, populates every batch and runs statements in the loop body', async () => {
    const cursor = sinon.spy(driver, 'executeStreamOnDb');

    const items = await driver.transaction(async () => {
      const seen: PglStream[] = [];
      for await (const item of PglStream.select().order('Id').populate('Notes').stream({ batchSize: 64 })) {
        await driver.executeOnDb('UPDATE pgl_stream SET "Name" = $1 WHERE "Id" = $2', [`seen-${item.Id}`, item.Id], QueryContext.Update);
        seen.push(item);
      }
      return seen;
    });

    expect(items).to.have.length(300);
    expect(cursor.callCount).to.eq(0);
    expect(items[0].Notes.map((n) => n.Body)).to.deep.equal(['first']);
    expect(items[299].Notes.map((n) => n.Body)).to.deep.equal(['last']);
    await driver.executeOnDb(`UPDATE pgl_stream SET "Name" = 'n' || "Id"`, [], QueryContext.Update);
  });

  it('has no pg cursor and pages by keyset', async () => {
    expect(driver.supportedFeatures().streaming).to.eq(false);

    const ids: number[] = [];
    for await (const row of PglStream.select().order('Id').stream({ batchSize: 64 })) {
      ids.push(row.Id);
    }

    expect(ids).to.deep.equal(Array.from({ length: 300 }, (_, i) => i + 1));
  });

  it('refuses a query without an order', async () => {
    await expect(PglStream.select().stream()[Symbol.asyncIterator]().next()).to.be.rejectedWith(StreamNotSupported);
  });
});
