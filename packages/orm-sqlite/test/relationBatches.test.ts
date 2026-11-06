import { DI } from '@spinajs/di';
import { HasManyRelationMiddleware, IBuilderMiddleware } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import { bootUow, registerUowConnection, UowOrder, UowOrderItem } from './uowFixture.js';

function hasManyMiddleware(query: object): IBuilderMiddleware {
  const middlewares = (query as { _middlewares: IBuilderMiddleware[] })._middlewares;
  const found = middlewares.find((m) => m instanceof HasManyRelationMiddleware);
  if (!found) {
    throw new Error('populate(Items) registered no HasManyRelationMiddleware');
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
    const query = UowOrder.select().populate('Items');
    query.toDB();
    const middleware = hasManyMiddleware(query);

    const first = await UowOrder.where({ Id: 1 }).firstOrFail();
    const second = await UowOrder.where({ Id: 2 }).firstOrFail();

    await middleware.afterHydration([first]);
    await middleware.afterHydration([second]);

    expect(first.Items.map((i) => i.Sku)).to.deep.equal(['A']);
    expect(second.Items.map((i) => i.Sku)).to.deep.equal(['B']);
  });
});
