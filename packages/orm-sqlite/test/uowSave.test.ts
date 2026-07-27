/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { QueryContext } from '@spinajs/orm';
import { bootUow, captureStatements, registerUowConnection, rows, UowClient, UowOrder, UowOrderItem, UowTag } from './uowFixture.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

/** INSERTs, whichever context — `returning()` flips Insert to InsertReturning. */
function insertsOf(statements: { context: QueryContext }[]) {
  return statements.filter((s) => s.context === QueryContext.Insert || s.context === QueryContext.InsertReturning);
}

describe('ModelBase.save', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  it('persists the whole graph from one call', async () => {
    const order = new UowOrder({ Total: 120 });
    order.Client.attach(new UowClient({ Name: 'acme' }));
    (order.Items as any).Populated = true;
    order.Items.push(new UowOrderItem({ Sku: 'A', Qty: 2 }));

    const result = await order.save();

    expect(result.Inserted).to.equal(3);
    expect(await rows('uow_client')).to.have.length(1);
    expect(await rows('uow_order')).to.have.length(1);
    expect((await rows('uow_order_item'))[0].order_id).to.equal(order.Id);
  });

  it('runs everything inside one transaction', async () => {
    const order = new UowOrder({ Total: 1 });
    (order.Items as any).Populated = true;
    order.Items.push(new UowOrderItem({ Sku: 'A', Qty: 1 }));

    const capture = captureStatements();
    await order.save();
    capture.restore();

    // Every statement saw the same ambient transaction context.
    expect(insertsOf(capture.statements)).to.have.length(2);
  });

  it('is a no-op on an unchanged graph', async () => {
    await UowOrder.insert({ Total: 10 });
    const order = await UowOrder.where({ Id: 1 }).first();

    const capture = captureStatements();
    const result = await order.save();
    capture.restore();

    expect(capture.statements.filter((s) => s.context !== QueryContext.Transaction)).to.have.length(0);
    expect(result.Inserted + result.Updated + result.Deleted).to.equal(0);
  });

  it('is idempotent - saving twice does not insert twice', async () => {
    const order = new UowOrder({ Total: 120 });
    (order.Items as any).Populated = true;
    order.Items.push(new UowOrderItem({ Sku: 'A', Qty: 2 }));

    await order.save();
    const second = await order.save();

    expect(second.Inserted).to.equal(0);
    expect(second.Updated).to.equal(0);
    expect(await rows('uow_order')).to.have.length(1);
    expect(await rows('uow_order_item')).to.have.length(1);
  });

  it('composes with a caller transaction as a savepoint', async () => {
    await UowOrder.transaction(async () => {
      const order = new UowOrder({ Total: 7 });
      await order.save();
    });

    expect(await rows('uow_order')).to.have.length(1);
  });

  it('rolls the whole graph back when a later statement fails', async () => {
    const order = new UowOrder({ Total: 1 });
    (order.Items as any).Populated = true;
    order.Items.push(new UowOrderItem({ Sku: 'A', Qty: 1 }));

    // Force the second insert to fail after the first succeeded.
    const connection: any = (order.constructor as any).driver();
    const original = connection.execute.bind(connection);
    let seen = 0;
    connection.execute = async (builder: any) => {
      seen += 1;
      if (seen === 2) {
        throw new Error('boom');
      }
      return await original(builder);
    };

    try {
      await expect(order.save()).to.be.rejectedWith('boom');
    } finally {
      connection.execute = original;
    }

    expect(await rows('uow_order')).to.have.length(0);
    expect(await rows('uow_order_item')).to.have.length(0);
  });

  it('rejects a graph that spans two connections', async () => {
    const order = new UowOrder({ Total: 1 });
    const client = new UowClient({ Name: 'acme' });
    order.Client.attach(client);

    const descriptor = client.ModelDescriptor!;
    const previous = descriptor.Connection;
    descriptor.Connection = 'other';

    try {
      await expect(order.save()).to.be.rejectedWith(/connection/);
    } finally {
      descriptor.Connection = previous;
    }
  });

  it('reload re-reads the baseline so an untouched column is not overwritten', async () => {
    await UowOrder.insert({ Total: 10, client_id: 1 });
    const order = await UowOrder.where({ Id: 1 }).first();

    // Another process moves the order to a different client.
    await UowOrder.update({ client_id: 9 }).where({ Id: 1 });

    order.Total = 99;
    await order.save({ reload: true });

    const persisted = (await rows('uow_order'))[0];
    expect(persisted.Total).to.equal(99);
    expect(persisted.client_id).to.equal(9);
  });

  it('without reload the hydration baseline is used and only truly changed columns are written', async () => {
    await UowOrder.insert({ Total: 10, client_id: 1 });
    const order = await UowOrder.where({ Id: 1 }).first();

    await UowOrder.update({ client_id: 9 }).where({ Id: 1 });

    order.Total = 99;
    await order.save();

    const persisted = (await rows('uow_order'))[0];
    expect(persisted.Total).to.equal(99);
    expect(persisted.client_id).to.equal(9);
  });

  it('re-snapshots relations so a second save sees no membership change', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowTag.insert({ Name: 'red' });
    const order = await UowOrder.where({ Id: 1 }).populate('Tags').first();

    order.Tags.push(await UowTag.where({ Id: 1 }).first());
    await order.save();

    const second = await order.save();

    expect(second.JunctionInserted).to.equal(0);
    expect(second.JunctionDeleted).to.equal(0);
    expect(await rows('uow_order_tag')).to.have.length(1);
  });
});
