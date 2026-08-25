/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import { bootUow, captureStatements, registerUowConnection, rows, UowClient, UowOrder } from './uowFixture.js';

describe('re-baseline after insert / refresh', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  it('insert() leaves the model with a snapshot that includes the generated key', async () => {
    const order = new UowOrder({ Total: 10 });

    await order.insert();

    expect(order.IsNew).to.equal(false);
    expect(order.Snapshot!.Columns.get('Id')).to.equal(order.Id);
    expect(order.changes()).to.deep.equal([]);
  });

  it('update() after insert() on the same instance writes only the changed column', async () => {
    const order = new UowOrder({ Total: 10 });
    await order.insert();

    order.Total = 20;

    const capture = captureStatements();
    await order.update();
    capture.restore();

    const updates = capture.statements.filter((s) => /^update/i.test(s.expression.trim()));
    expect(updates).to.have.length(1);
    expect(updates[0].expression).to.contain('`Total`');
    expect(updates[0].expression).to.not.contain('`client_id`');
    expect((await rows('uow_order'))[0].Total).to.equal(20);
  });

  it('refresh() re-baselines to what the database holds', async () => {
    const order = new UowOrder({ Total: 10 });
    await order.insert();

    // Change the row behind this instance's back.
    const other = await UowOrder.where({ Id: order.Id }).first();
    other.Total = 55;
    await other.update();

    await order.refresh();

    expect(order.Total).to.equal(55);
    expect(order.Snapshot!.Columns.get('Total')).to.equal(55);
    expect(order.changes()).to.deep.equal([]);
  });

  it('static bulk insert leaves the inserted models clean and snapshotted', async () => {
    const a = new UowOrder({ Total: 1 });
    const b = new UowOrder({ Total: 2 });

    await UowOrder.insert([a, b]);

    expect(a.IsNew).to.equal(false);
    expect(b.IsNew).to.equal(false);
    expect(a.Id).to.be.a('number');
    expect(a.Snapshot!.Columns.get('Id')).to.equal(a.Id);
    expect(a.IsDirty).to.equal(false);
    expect(b.IsDirty).to.equal(false);
  });

  it('static bulk insert converges a model holding an attached relation', async () => {
    await UowClient.insert({ Name: 'acme' });
    const client = await UowClient.where({ Id: 1 }).first();

    const order = new UowOrder({ Total: 5 });
    // Assigned, not attach()ed: `attach()` writes the foreign-key column itself, so it would
    // hide the gap. A directly assigned relation leaves the column untouched and the payload
    // `toSql()` builds is the only thing that carries the key.
    order.Client.Value = client;

    await UowOrder.insert([order]);

    expect((await rows('uow_order'))[0].client_id).to.equal(1);
    expect(order.client_id).to.equal(1);
    expect(order.IsDirty).to.equal(false);
  });
});
