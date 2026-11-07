import { DI } from '@spinajs/di';
import { BelongsToRelationRecursiveMiddleware, HasManyRelationMiddleware, HasManyToManyRelationMiddleware, IBuilderMiddleware } from '@spinajs/orm';
import type { Constructor } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import { db } from './common.js';
import './migrations/TestMigration_2022_02_08_01_13_00.js';
import { Category } from './models/Category.js';
import { bootUow, registerUowConnection, UowOrder, UowOrderItem } from './uowFixture.js';

function relationMiddleware(query: object, type: Constructor<IBuilderMiddleware>): IBuilderMiddleware {
  (query as { toDB(): unknown }).toDB();
  const middlewares = (query as { _middlewares: IBuilderMiddleware[] })._middlewares;
  const found = middlewares.find((m) => m instanceof type);
  if (!found) {
    throw new Error(`the populate registered no ${type.name}`);
  }
  return found;
}

describe('relation middlewares over several batches', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
    await UowOrder.insert({ Total: 10 });
    await UowOrder.insert({ Total: 20 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
    await UowOrderItem.insert({ Sku: 'B', Qty: 1, order_id: 2 });
  });
  afterEach(() => DI.clearCache());

  it('loads the second batch of owners after the first', async () => {
    const middleware = relationMiddleware(UowOrder.select().populate('Items'), HasManyRelationMiddleware);

    const first = await UowOrder.where({ Id: 1 }).firstOrFail();
    const second = await UowOrder.where({ Id: 2 }).firstOrFail();

    await middleware.afterHydration([first]);
    await middleware.afterHydration([second]);

    expect(first.Items.map((i) => i.Sku)).to.deep.equal(['A']);
    expect(second.Items.map((i) => i.Sku)).to.deep.equal(['B']);
  });

  it('loads the second batch of a many-to-many relation after the first', async () => {
    const driver = db().Connections.get('sqlite')!;
    await driver.insert().into('uow_tag').values([{ Name: 'T1' }, { Name: 'T2' }]);
    await driver.insert().into('uow_order_tag').values([
      { order_id: 1, tag_id: 1 },
      { order_id: 2, tag_id: 2 },
    ]);
    const middleware = relationMiddleware(UowOrder.select().populate('Tags'), HasManyToManyRelationMiddleware);

    const first = await UowOrder.where({ Id: 1 }).firstOrFail();
    const second = await UowOrder.where({ Id: 2 }).firstOrFail();

    await middleware.afterHydration([first]);
    await middleware.afterHydration([second]);

    expect(first.Tags.map((t) => t.Name)).to.deep.equal(['T1']);
    expect(second.Tags.map((t) => t.Name)).to.deep.equal(['T2']);
  });

  it('loads the second batch of a recursive relation after the first', async () => {
    const driver = db().Connections.get('sqlite')!;
    await driver.insert().into('category').values([
      { Name: 'A', parent_id: null },
      { Name: 'B', parent_id: null },
      { Name: 'A1', parent_id: 1 },
      { Name: 'B1', parent_id: 2 },
    ]);
    const middleware = relationMiddleware(Category.query().whereNull('parent_id').populate('Children'), BelongsToRelationRecursiveMiddleware);

    const first = await Category.where({ Id: 1 }).firstOrFail();
    const second = await Category.where({ Id: 2 }).firstOrFail();

    await middleware.afterHydration([first]);
    await middleware.afterHydration([second]);

    expect(first.Children.map((c) => c.Name)).to.deep.equal(['A1']);
    expect(second.Children.map((c) => c.Name)).to.deep.equal(['B1']);
  });
});
