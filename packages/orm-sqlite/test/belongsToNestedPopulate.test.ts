import { DI } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import { bootUow, captureStatements, registerUowConnection, UowClient, UowOrder, UowOrderItem, UowOrderTag, UowTag } from './uowFixture.js';

describe('relations populated under a belongsTo populate', function () {
  this.timeout(30000);

  before(() => registerUowConnection());

  beforeEach(async () => {
    await bootUow();
    await UowClient.insert({ Name: 'acme' });
    await UowOrder.insert({ Total: 10, client_id: 1 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
    await UowOrderItem.insert({ Sku: 'B', Qty: 1, order_id: 1 });
    await UowTag.insert({ Name: 'x' });
    await UowOrderTag.insert({ order_id: 1, tag_id: 1 });
  });

  afterEach(() => DI.clearCache());

  it('loads a to-many, a many-to-many and a to-one under it, each to-many with one select', async () => {
    const capture = captureStatements();
    const [item] = await UowOrderItem.where('Sku', 'A').populate('Order', function () {
      this.populate('Items');
      this.populate('Tags');
      this.populate('Client');
    });
    capture.restore();

    const order = item.Order.Value;
    expect(order.Client.Value?.Name).to.equal('acme');
    expect(order.Items.map((i) => i.Sku).sort()).to.deep.equal(['A', 'B']);
    expect(order.Tags.map((t) => t.Name)).to.deep.equal(['x']);
    expect(capture.statements.filter((s) => s.context === QueryContext.Select)).to.have.length(3);
  });

  it('loads nothing more when the belongsTo populate has no nested relation', async () => {
    const capture = captureStatements();
    const [item] = await UowOrderItem.where('Sku', 'A').populate('Order');
    capture.restore();

    expect(item.Order.Value.Total).to.equal(10);
    expect(capture.statements.filter((s) => s.context === QueryContext.Select)).to.have.length(1);
  });
});
