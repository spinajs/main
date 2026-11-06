import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Connection, HasManyRelationMiddleware, Model, ModelBase, OrmDriver, Primary, StreamNotSupported } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import sinon from 'sinon';
import { db } from './common.js';
import { bootUow, registerUowConnection, UowOrder } from './uowFixture.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

/** `uow_order.Total` is nullable, so the tie-breaker test needs its own NOT NULL column. */
@Connection('sqlite')
@Model('stream_score')
class StreamScore extends ModelBase {
  @Primary()
  public Id: number;

  public Score: number;
}

function sqlite(): OrmDriver {
  return db().Connections.get('sqlite')!;
}

async function createScores(count: number, score: number): Promise<void> {
  await sqlite()
    .schema()
    .createTable('stream_score', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.int('Score').notNull();
    });
  await db().reloadTableInfo();
  await sqlite()
    .insert()
    .into('stream_score')
    .values(Array.from({ length: count }, () => ({ Score: score })));
}

async function seedOrders(count: number): Promise<void> {
  const rows = Array.from({ length: count }, (_, i) => ({ Total: i + 1 }));
  for (let at = 0; at < rows.length; at += 1000) {
    await sqlite().insert().into('uow_order').values(rows.slice(at, at + 1000));
  }
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

function withoutCursor(sandbox: sinon.SinonSandbox): void {
  const driver = sqlite();
  sandbox.stub(driver, 'supportedFeatures').returns({ ...driver.supportedFeatures(), streaming: false });
}

function streamSuite(mode: 'native' | 'keyset fallback'): void {
  describe(`stream() on sqlite, ${mode}`, function () {
    this.timeout(60000);
    const sandbox = sinon.createSandbox();

    before(() => registerUowConnection());
    beforeEach(async () => {
      await bootUow();
      if (mode === 'keyset fallback') {
        withoutCursor(sandbox);
      }
    });
    afterEach(() => {
      sandbox.restore();
      DI.clearCache();
    });

    it('yields 10k rows once each, in order, as models', async () => {
      await seedOrders(10000);

      const rows = await collect(UowOrder.select().order('Id').stream({ batchSize: 100 }));

      expect(rows).to.have.length(10000);
      expect(rows.every((r) => r instanceof UowOrder)).to.eq(true);
      expect(rows.map((r) => r.Id)).to.deep.equal(Array.from({ length: 10000 }, (_, i) => i + 1));
    });

    it('stops after the rows the loop took when it breaks', async () => {
      await seedOrders(10000);

      const rows = await collect(UowOrder.select().order('Id').stream({ batchSize: 100 }), 150);

      expect(rows.map((r) => r.Id)).to.deep.equal(Array.from({ length: 150 }, (_, i) => i + 1));
    });

    it('populates relations once per batch', async () => {
      await seedOrders(250);
      await sqlite()
        .insert()
        .into('uow_order_item')
        .values([
          { Sku: 'A', Qty: 1, order_id: 1 },
          { Sku: 'B', Qty: 1, order_id: 250 },
        ]);
      const populate = sandbox.spy(HasManyRelationMiddleware.prototype, 'afterHydration');

      const rows = await collect(UowOrder.select().order('Id').populate('Items').stream({ batchSize: 100 }));

      expect(populate.callCount).to.eq(3);
      expect(rows[0].Items.map((i) => i.Sku)).to.deep.equal(['A']);
      expect(rows[249].Items.map((i) => i.Sku)).to.deep.equal(['B']);
      expect(rows[120].Items.Populated).to.eq(true);
    });

    it('rejects the loop with an error raised mid-stream', async () => {
      await seedOrders(300);
      let hydrated = 0;
      const hydrate = sandbox.stub(UowOrder.prototype, 'hydrate');
      hydrate.callsFake(function (this: UowOrder, data: Partial<UowOrder>) {
        hydrated++;
        if (hydrated === 150) {
          throw new Error('row 150 is broken');
        }
        hydrate.wrappedMethod.call(this, data);
      });
      const seen: number[] = [];

      const loop = async () => {
        for await (const row of UowOrder.select().order('Id').stream({ batchSize: 100 })) {
          seen.push(row.Id);
        }
      };

      await expect(loop()).to.be.rejectedWith('row 150 is broken');
      expect(seen).to.have.length(100);
    });
  });
}

streamSuite('keyset fallback');

describe('stream() without a driver cursor', function () {
  this.timeout(60000);
  const sandbox = sinon.createSandbox();

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
    withoutCursor(sandbox);
  });
  afterEach(() => {
    sandbox.restore();
    DI.clearCache();
  });

  it('runs one select per batch and none after the loop breaks', async () => {
    await seedOrders(1000);
    const execute = sandbox.spy(sqlite(), 'execute');

    await collect(UowOrder.select().order('Id').stream({ batchSize: 100 }), 150);

    expect(execute.callCount).to.eq(2);
  });

  it('breaks ties across page boundaries with the primary key', async () => {
    await createScores(30, 7);

    const rows = await collect(StreamScore.select().orderByDescending('Score').stream({ batchSize: 7 }));

    expect(rows.map((r) => r.Id)).to.deep.equal(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it('refuses a nullable order column before the first page', async () => {
    await seedOrders(3);
    const execute = sandbox.spy(sqlite(), 'execute');

    await expect(collect(UowOrder.select().orderByDescending('Total').stream({ batchSize: 2 }))).to.be.rejectedWith(InvalidArgument, /NOT NULL/);
    expect(execute.callCount).to.eq(0);
  });

  it('refuses a query without an order', async () => {
    await expect(collect(UowOrder.select().stream())).to.be.rejectedWith(StreamNotSupported);
  });

  it('refuses take() and skip()', async () => {
    await expect(collect(UowOrder.select().order('Id').take(5).stream())).to.be.rejectedWith(StreamNotSupported);
  });

  it('refuses an order by a relation column', async () => {
    await expect(collect(UowOrder.select().order('Client.Name').order('Id').stream())).to.be.rejectedWith(StreamNotSupported);
  });
});
