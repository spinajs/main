/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import { bootUow, registerUowConnection, rows, UowOrder, UowOrderItem, UowOrderTag, UowTag } from './uowFixture.js';

/**
 * The deliberate divergence from TypeORM: SpinaJS can tell "never loaded" from "loaded and
 * then cleared", so an empty relation array on a freshly constructed model deletes nothing.
 *
 * Every case here is a data-loss scenario. If one of them regresses, users lose rows.
 */
describe('save() anti-footgun guarantee', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  it('an empty hasMany on a freshly constructed model deletes nothing', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });

    // A model constructed by hand that happens to carry the same primary key.
    const order = new UowOrder({ Total: 10 });
    (order as any).Id = 1;

    expect(order.Items.length).to.equal(0);
    expect(order.Items.Populated).to.equal(false);

    await order.save();

    expect(await rows('uow_order_item')).to.have.length(1);
  });

  it('an empty manyToMany on a freshly constructed model unlinks nothing', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowTag.insert({ Name: 'red' });
    await UowOrderTag.insert({ order_id: 1, tag_id: 1 });

    const order = new UowOrder({ Total: 10 });
    (order as any).Id = 1;

    await order.save();

    expect(await rows('uow_order_tag')).to.have.length(1);
  });

  it('saving a loaded model without populating its relations deletes nothing', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
    await UowOrderItem.insert({ Sku: 'B', Qty: 2, order_id: 1 });

    const order = await UowOrder.where({ Id: 1 }).first();
    order.Total = 99;

    expect(order.Items.Populated).to.equal(false);

    await order.save();

    expect((await rows('uow_order'))[0].Total).to.equal(99);
    expect(await rows('uow_order_item')).to.have.length(2);
  });

  it('emptying a POPULATED relation does delete - the flag is what distinguishes them', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });

    const order = await UowOrder.where({ Id: 1 }).populate('Items').first();
    expect(order.Items.Populated).to.equal(true);

    order.Items.empty();
    await order.save();

    expect(await rows('uow_order_item')).to.have.length(0);
  });

  // The honest cost of the guarantee: pushing onto a relation you never populated is a no-op.
  // The fix for a user who hits it is `await order.Items.populate()` first, or loading the
  // order with `UowOrder.query().populate('Items')`.
  it('pushing onto an unpopulated relation still inserts nothing', async () => {
    await UowOrder.insert({ Total: 10 });
    const order = await UowOrder.where({ Id: 1 }).first();

    order.Items.push(new UowOrderItem({ Sku: 'ghost', Qty: 1 }));
    await order.save();

    expect(await rows('uow_order_item')).to.have.length(0);
  });
});
