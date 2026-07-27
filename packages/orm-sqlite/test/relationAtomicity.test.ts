/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { Orm } from '@spinajs/orm';
import { bootUow, registerUowConnection, rows, UowOrder, UowOrderItem, UowTag } from './uowFixture.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

/** Fails the nth statement the driver is asked to execute. */
function failAt(n: number): () => void {
  const connection: any = DI.get(Orm)!.Connections.get('sqlite')!;
  const original = connection.execute.bind(connection);
  let seen = 0;

  connection.execute = async (builder: any) => {
    seen += 1;
    if (seen === n) {
      throw new Error('boom');
    }
    return await original(builder);
  };

  return () => {
    connection.execute = original;
  };
}

/** Fails the first statement whose compiled SQL starts with `verb`. */
function failOn(verb: string): () => void {
  const connection: any = DI.get(Orm)!.Connections.get('sqlite')!;
  const original = connection.execute.bind(connection);

  connection.execute = async (builder: any) => {
    const compiled: any = builder.toDB();
    const expression = Array.isArray(compiled) ? compiled[0]?.expression : compiled?.expression;
    if (typeof expression === 'string' && expression.startsWith(verb)) {
      throw new Error('boom');
    }
    return await original(builder);
  };

  return () => {
    connection.execute = original;
  };
}

describe('relation write paths are transactional', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  it('OneToManyRelationList.update rolls back every insert when one fails', async () => {
    await UowOrder.insert({ Total: 10 });
    const order = await UowOrder.where({ Id: 1 }).populate('Items').first();

    order.Items.push(new UowOrderItem({ Sku: 'A', Qty: 1 }), new UowOrderItem({ Sku: 'B', Qty: 2 }));

    const restore = failAt(2);
    try {
      await expect(order.Items.update()).to.be.rejectedWith('boom');
    } finally {
      restore();
    }

    expect(await rows('uow_order_item')).to.have.length(0);
  });

  it('OneToManyRelationList.sync rolls the orphan delete back with its updates', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
    const order = await UowOrder.where({ Id: 1 }).populate('Items').first();

    order.Items.push(new UowOrderItem({ Sku: 'B', Qty: 2 }));

    // The DELETE is the last statement sync() issues.
    const restore = failOn('DELETE');
    try {
      await expect(order.Items.sync()).to.be.rejectedWith('boom');
    } finally {
      restore();
    }

    expect(await rows('uow_order_item')).to.have.length(1);
  });

  it('ManyToManyRelationList.update rolls back every junction write when one fails', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowTag.insert({ Name: 'red' });
    await UowTag.insert({ Name: 'blue' });

    const order = await UowOrder.where({ Id: 1 }).populate('Tags').first();
    order.Tags.push(await UowTag.where({ Id: 1 }).first(), await UowTag.where({ Id: 2 }).first());

    const restore = failAt(2);
    try {
      await expect(order.Tags.update()).to.be.rejectedWith('boom');
    } finally {
      restore();
    }

    expect(await rows('uow_order_tag')).to.have.length(0);
  });

  it('SingleRelation.remove rolls the owner update back with the target delete', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });

    const item = await UowOrderItem.where({ Id: 1 }).populate('Order').first();

    const restore = failOn('UPDATE');
    try {
      await expect(item.Order.remove()).to.be.rejectedWith('boom');
    } finally {
      restore();
    }

    expect(await rows('uow_order')).to.have.length(1);
  });

  it('nests as a savepoint inside a caller transaction', async () => {
    await UowOrder.insert({ Total: 10 });
    const order = await UowOrder.where({ Id: 1 }).populate('Items').first();

    await UowOrder.transaction(async () => {
      order.Items.push(new UowOrderItem({ Sku: 'A', Qty: 1 }));
      await order.Items.update();
    });

    expect(await rows('uow_order_item')).to.have.length(1);
  });
});
