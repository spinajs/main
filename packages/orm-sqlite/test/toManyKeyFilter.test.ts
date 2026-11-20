import { DI } from '@spinajs/di';
import { BelongsToRelationRecursiveMiddleware, extractModelDescriptor, HasManyRelationMiddleware, IBuilderMiddleware, ISelectQueryBuilder, ModelBase } from '@spinajs/orm';
import type { Constructor } from '@spinajs/di';
import { Lazy } from '@spinajs/util';
import { expect } from 'chai';
import 'mocha';
import sinon from 'sinon';
import { db } from './common.js';
import './migrations/TestMigration_2022_02_08_01_13_00.js';
import { Category } from './models/Category.js';
import { bootUow, captureStatements, registerUowConnection, UowOrder, UowOrderItem, UowOrderTag, UowTag } from './uowFixture.js';

type Row = Record<string, unknown>;

/** The rows every select returns from the database, in execution order, before any model sees them. */
async function rawResults(run: () => PromiseLike<unknown>): Promise<Row[][]> {
  const results: Row[][] = [];
  const driver = db().Connections.get('sqlite')!;
  const original = driver.execute.bind(driver);
  const stub = sinon.stub(driver, 'execute').callsFake(async (builder) => {
    const result = (await original(builder)) as Row[];
    results.push(result);
    return result;
  });

  try {
    await run();
  } finally {
    stub.restore();
  }

  return results;
}

function relationMiddleware(query: ISelectQueryBuilder, type: Constructor<IBuilderMiddleware>): IBuilderMiddleware {
  query.toDB();
  const found = (query as unknown as { _middlewares: IBuilderMiddleware[] })._middlewares.find((m) => m instanceof type);
  if (!found) {
    throw new Error(`the populate registered no ${type.name}`);
  }
  return found;
}

const qtyFiveOrNinetyNine = function (this: ISelectQueryBuilder) {
  this.where('Qty', 5).orWhere('Qty', 99);
};

describe('to-many populate: the key filter confines a callback orWhere', function () {
  this.timeout(30000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
    await UowOrder.insert({ Total: 10 });
    await UowOrder.insert({ Total: 20 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
    await UowOrderItem.insert({ Sku: 'B', Qty: 5, order_id: 2 });
    await UowOrderItem.insert({ Sku: 'C', Qty: 5, order_id: 1 });
    await UowTag.insert({ Name: 'x' });
    await UowTag.insert({ Name: 'y' });
    await UowOrderTag.insert({ order_id: 1, tag_id: 1 });
    await UowOrderTag.insert({ order_id: 2, tag_id: 2 });
  });
  afterEach(() => DI.clearCache());

  it('hasMany reads no child row of another parent', async () => {
    const [, children] = await rawResults(() => UowOrder.where('Id', 1).populate('Items', qtyFiveOrNinetyNine));

    expect(children.map((r) => r.Sku)).to.deep.equal(['C']);
  });

  it('hasMany ANDs the key filter to the callback conditions as one group', async () => {
    const capture = captureStatements();
    try {
      await UowOrder.where('Id', 1).populate('Items', qtyFiveOrNinetyNine);
    } finally {
      capture.restore();
    }

    expect(capture.statements[1].expression).to.contain('WHERE ( `$Items$`.`Qty` = ? OR `$Items$`.`Qty` = ? ) AND `$Items$`.`order_id` IN (?)');
    expect(capture.statements[1].bindings).to.deep.equal([5, 99, 1]);
  });

  it('hasMany keeps an aggregate condition of the callback in HAVING, outside the group', async () => {
    const qty = extractModelDescriptor(UowOrderItem)!.Columns.find((c) => c.Name === 'Qty')!;
    qty.Aggregate = true;
    const capture = captureStatements();
    try {
      await UowOrder.where('Id', 1).populate('Items', function () {
        this.where('Sku', 'A').orWhere('Qty', '>', 3).orWhere('Sku', 'C').groupBy('order_id');
      });
    } finally {
      capture.restore();
      qty.Aggregate = false;
    }

    expect(capture.statements[1].expression).to.contain('WHERE ( `$Items$`.`Sku` = ? OR `$Items$`.`Sku` = ? ) AND `$Items$`.`order_id` IN (?) GROUP BY');
    expect(capture.statements[1].expression).to.match(/HAVING `Qty` > \?$/);
    expect(capture.statements[1].bindings).to.deep.equal(['A', 'C', 1, 3]);
  });

  it('many-to-many reads no junction row of another parent', async () => {
    const [, junction] = await rawResults(() =>
      UowOrder.where('Id', 1).populate('Tags', function () {
        this.where('Name', 'y').orWhere('Name', 'none');
      }),
    );

    expect(junction).to.deep.equal([]);
  });

  it('many-to-many ANDs the key filter to the callback conditions as one group', async () => {
    const capture = captureStatements();
    try {
      const [order] = await UowOrder.where('Id', 1).populate('Tags', function () {
        this.where('Name', 'none').orWhere('Name', 'x');
      });
      expect([...order.Tags].map((t) => t.Name)).to.deep.equal(['x']);
    } finally {
      capture.restore();
    }

    expect(capture.statements[1].expression).to.contain('WHERE ( `$Tags$`.`Name` = ? OR `$Tags$`.`Name` = ? ) AND `$uow_order_tag$`.`order_id` IN (?)');
  });

  it('recursive relation starts the walk from the owners only', async () => {
    const driver = db().Connections.get('sqlite')!;
    await driver.insert().into('category').values([
      { Name: 'A', parent_id: null },
      { Name: 'B', parent_id: null },
      { Name: 'A1', parent_id: 1 },
      { Name: 'B1', parent_id: 2 },
    ]);

    const [, tree] = await rawResults(() =>
      Category.where('Id', 1).populate('Children', function () {
        this.where('Name', 'B').orWhere('Name', 'A');
      }),
    );

    expect(tree.map((r) => r.Name).sort()).to.deep.equal(['A', 'A1']);
  });

  it('recursive relation keeps a Lazy condition of the callback', async () => {
    const driver = db().Connections.get('sqlite')!;
    await driver.insert().into('category').values([
      { Name: 'A', parent_id: null },
      { Name: 'B', parent_id: null },
      { Name: 'A1', parent_id: 1 },
      { Name: 'B1', parent_id: 2 },
    ]);

    const [category] = await Category.where('Id', 1).populate('Children', function () {
      this.where(
        Lazy.oF(function (this: ISelectQueryBuilder) {
          this.where('Name', 'A');
        }),
      );
    });

    expect(category.Children.map((c) => c.Name)).to.deep.equal(['A1']);
  });

  it('leaves the relation query as written, so a second batch is filtered by its own keys only', async () => {
    const middleware = relationMiddleware(UowOrder.select().populate('Items', qtyFiveOrNinetyNine), HasManyRelationMiddleware);
    const owners: ModelBase[] = [await UowOrder.where({ Id: 1 }).firstOrFail(), await UowOrder.where({ Id: 2 }).firstOrFail()];

    for (const owner of owners) {
      await middleware.afterHydration([owner]);
    }

    expect(owners.map((o) => [...(o as UowOrder).Items].map((i) => i.Sku))).to.deep.equal([['C'], ['B']]);
  });

  it('recursive relation keeps its query as written over several batches', async () => {
    const driver = db().Connections.get('sqlite')!;
    await driver.insert().into('category').values([
      { Name: 'A', parent_id: null },
      { Name: 'B', parent_id: null },
      { Name: 'A1', parent_id: 1 },
      { Name: 'B1', parent_id: 2 },
    ]);
    const middleware = relationMiddleware(
      Category.query()
        .whereNull('parent_id')
        .populate('Children', function () {
          this.where('Name', 'B').orWhere('Name', 'A');
        }),
      BelongsToRelationRecursiveMiddleware,
    );
    const owners = [await Category.where({ Id: 1 }).firstOrFail(), await Category.where({ Id: 2 }).firstOrFail()];

    for (const owner of owners) {
      await middleware.afterHydration([owner]);
    }

    expect(owners.map((o) => o.Children.map((c) => c.Name))).to.deep.equal([['A1'], ['B1']]);
  });
});
