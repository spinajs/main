/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import { bootUow, registerUowConnection, UowOrder, UowOrderItem, UowTag } from './uowFixture.js';

describe('ModelBase.attach', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  it('pushes a hasMany child and sets the back-reference', () => {
    const order = new UowOrder({ Total: 1 });
    const item = new UowOrderItem({ Sku: 'A', Qty: 1 });

    order.attach(item);

    expect([...order.Items]).to.deep.equal([item]);
    expect((item.Order as any).Value).to.equal(order);
  });

  it('pushes a manyToMany member without looking for a back-reference', () => {
    const order = new UowOrder({ Total: 1 });
    const tag = new UowTag({ Name: 'red' });

    order.attach(tag);

    expect([...order.Tags]).to.deep.equal([tag]);
  });

  it('does not push a hasMany child into a manyToMany relation as well', () => {
    const order = new UowOrder({ Total: 1 });

    order.attach(new UowOrderItem({ Sku: 'A', Qty: 1 }));

    expect(order.Tags.length).to.equal(0);
  });

  it('attaches a belongsTo target and marks the foreign key dirty exactly once', () => {
    const item = new UowOrderItem({ Sku: 'A', Qty: 1 });
    item.IsDirty = false;
    const order = new UowOrder({ Total: 1 });

    item.attach(order);
    item.attach(order);

    expect((item.Order as any).Value).to.equal(order);
    expect((item as any).__dirty_props__.filter((p: string) => p === 'order_id')).to.have.length(1);
  });

  it('matches relations by constructor identity, not class name', () => {
    const order = new UowOrder({ Total: 1 });

    // A different class that merely shares its name with a related model. Under class-name
    // matching this reached the hasMany branch; under identity matching it is skipped.
    class UowOrderItem {}

    order.attach(new UowOrderItem() as any);

    expect(order.Items.length).to.equal(0);
  });
});
