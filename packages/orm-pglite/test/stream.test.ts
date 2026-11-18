import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { Connection, HasMany, Model, ModelBase, Orm, Primary, QueryContext, Relation } from '@spinajs/orm';
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

  it('streams through a WITH HOLD cursor', async () => {
    expect(driver.supportedFeatures().streaming).to.eq(true);
    const cursor = sinon.spy(driver, 'executeStreamOnDb');

    const ids: number[] = [];
    for await (const row of PglStream.select().order('Id').stream({ batchSize: 64 })) {
      ids.push(row.Id);
    }

    expect(ids).to.deep.equal(Array.from({ length: 300 }, (_, i) => i + 1));
    expect(cursor.callCount).to.eq(1);
  });

  it('streams a query without an order: a cursor needs none', async () => {
    const ids: number[] = [];
    for await (const row of PglStream.select().stream({ batchSize: 64 })) {
      ids.push(row.Id);
    }

    expect(ids.sort((a, b) => a - b)).to.deep.equal(Array.from({ length: 300 }, (_, i) => i + 1));
  });

  const openCursors = async () => {
    const rows: Array<{ n: number }> = await driver.executeOnDb('SELECT count(*)::int AS n FROM pg_cursors', [], QueryContext.Select);
    return rows[0].n;
  };

  it('lets the loop body query between batches and leaves no cursor open', async () => {
    let seen = 0;
    let countedInside = 0;
    for await (const row of PglStream.select().order('Id').stream({ batchSize: 7 })) {
      seen += row.Id > 0 ? 1 : 0;
      if (seen === 8) {
        countedInside = (await PglStream.all()).length;
      }
    }

    expect(seen).to.eq(300);
    expect(countedInside).to.eq(300);
    expect(await openCursors()).to.eq(0);
  });

  it('closes the cursor when the loop breaks', async () => {
    let read = 0;
    for await (const row of PglStream.select().order('Id').stream({ batchSize: 7 })) {
      read += row.Id > 0 ? 1 : 0;
      if (read === 10) {
        break;
      }
    }

    expect(read).to.eq(10);
    expect(await openCursors()).to.eq(0);
  });

  it('closes the cursor when the loop body throws', async () => {
    const failing = async () => {
      for await (const row of PglStream.select().order('Id').stream({ batchSize: 7 })) {
        if (row.Id === 10) {
          throw new Error('stop');
        }
      }
    };

    await expect(failing()).to.be.rejectedWith('stop');
    expect(await openCursors()).to.eq(0);
  });

  it('runs two streams of one connection side by side', async () => {
    const pairs: number[] = [];
    for await (const outer of PglStream.select().where('Id', '<=', 2).order('Id').stream({ batchSize: 1 })) {
      for await (const inner of PglStream.select().where('Id', '<=', 2).order('Id').stream({ batchSize: 1 })) {
        pairs.push(outer.Id * 10 + inner.Id);
      }
    }

    expect(pairs).to.deep.equal([11, 12, 21, 22]);
    expect(await openCursors()).to.eq(0);
  });

  it('rejects with the FETCH error when the CLOSE after it fails too', async () => {
    const run = driver.executeOnDb.bind(driver);
    let fetches = 0;
    sinon.stub(driver, 'executeOnDb').callsFake((stmt: string, params: unknown[], context: QueryContext): Promise<unknown> => {
      if (stmt.startsWith('FETCH')) {
        fetches++;
      }
      if (fetches === 2 && stmt.startsWith('FETCH')) {
        return Promise.reject(new Error('fetch failed'));
      }
      if (fetches === 2 && stmt.startsWith('CLOSE')) {
        return Promise.reject(new Error('close failed'));
      }
      return run(stmt, params, context);
    });

    const reading = async () => {
      let read = 0;
      for await (const row of PglStream.select().order('Id').stream({ batchSize: 7 })) {
        read += row.Id > 0 ? 1 : 0;
      }
      return read;
    };

    await expect(reading()).to.be.rejectedWith('fetch failed');
    sinon.restore();
    // the stubbed CLOSE never reached the database
    await driver.executeOnDb('CLOSE ALL', [], QueryContext.Select);
    expect(await openCursors()).to.eq(0);
  });
});
