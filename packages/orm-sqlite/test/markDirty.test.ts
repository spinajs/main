/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import { bootUow, registerUowConnection, UowOrder, UowOrderItem } from './uowFixture.js';

describe('SingleRelation.attach dirty tracking', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  it('marks the owner dirty and records the foreign key', () => {
    const item = new UowOrderItem({ Sku: 'A', Qty: 1 });
    item.IsDirty = false;

    item.Order.attach(new UowOrder({ Total: 1 }));

    expect(item.IsDirty).to.equal(true);
    expect((item as any).__dirty_props__).to.include('order_id');
  });

  it('records the foreign key only once across repeated attaches', () => {
    const item = new UowOrderItem({ Sku: 'A', Qty: 1 });
    item.IsDirty = false;

    const order = new UowOrder({ Total: 1 });
    item.Order.attach(order);
    item.Order.attach(order);
    item.Order.attach(new UowOrder({ Total: 2 }));

    expect((item as any).__dirty_props__.filter((p: string) => p === 'order_id')).to.have.length(1);
  });

  it('never records undefined for a relation without a descriptor', () => {
    const item = new UowOrderItem({ Sku: 'A', Qty: 1 });
    item.IsDirty = false;

    const relation: any = item.Order;
    const previous = relation.Relation;
    relation.Relation = null;

    try {
      relation.attach(new UowOrder({ Total: 1 }));
      expect((item as any).__dirty_props__).to.not.include(undefined);
    } finally {
      relation.Relation = previous;
    }
  });

  it('detach marks the owner dirty too', () => {
    const item = new UowOrderItem({ Sku: 'A', Qty: 1 });
    item.Order.attach(new UowOrder({ Total: 1 }));
    item.IsDirty = false;

    item.Order.detach();

    expect(item.IsDirty).to.equal(true);
    expect((item.Order as any).Value).to.equal(null);
  });

  it('does not read the owner private field from outside the model', () => {
    const source = (Object.getPrototypeOf(new UowOrderItem({ Sku: 'A', Qty: 1 }).Order) as any).attach.toString();

    expect(source).to.not.contain('__dirty_props__');
  });
});
