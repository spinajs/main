/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import { bootUow, captureStatements, registerUowConnection, UowAltOwner, UowAltTarget, UowOrder, UowOrderItem } from './uowFixture.js';

describe('SingleRelation.populate', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  it('loads the target through the default join column', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });

    const item = await UowOrderItem.where({ Id: 1 }).first();
    await item.Order.populate();

    expect((item.Order as any).Value.Id).to.equal(1);
    expect(item.Order.Populated).to.equal(true);
  });

  it('loads the target through an explicitly declared join column', async () => {
    await UowAltTarget.insert({ Code: 'ALPHA', Label: 'first' });
    await UowAltTarget.insert({ Code: 'BETA', Label: 'second' });
    await UowAltOwner.insert({ target_code: 'BETA' });

    const owner = await UowAltOwner.where({ Id: 1 }).first();
    await owner.Target.populate();

    expect((owner.Target as any).Value.Label).to.equal('second');
  });

  it('queries the target table only, never the owner', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
    const item = await UowOrderItem.where({ Id: 1 }).first();

    const capture = captureStatements();
    await item.Order.populate();
    capture.restore();

    expect(capture.statements).to.have.length(1);
    expect(capture.statements[0].expression).to.contain('uow_order');
    expect(capture.statements[0].expression).to.not.contain('uow_order_item');
  });

  it('matches the eager populate result', async () => {
    await UowAltTarget.insert({ Code: 'ALPHA', Label: 'first' });
    await UowAltTarget.insert({ Code: 'BETA', Label: 'second' });
    await UowAltOwner.insert({ target_code: 'BETA' });

    const eager = await UowAltOwner.where({ Id: 1 }).populate('Target').first();
    const lazy = await UowAltOwner.where({ Id: 1 }).first();
    await lazy.Target.populate();

    expect((lazy.Target as any).Value.Label).to.equal((eager.Target as any).Value.Label);
  });

  it('applies a caller callback to the target query', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
    const item = await UowOrderItem.where({ Id: 1 }).first();

    let called = false;
    await item.Order.populate(function (this: any) {
      called = true;
      this.select('*');
    });

    expect(called).to.equal(true);
    expect((item.Order as any).Value.Id).to.equal(1);
  });
});
