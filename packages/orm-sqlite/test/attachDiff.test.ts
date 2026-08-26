/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import { bootUow, registerUowConnection, rows, UowAltOwner, UowAltTarget, UowClient, UowOrder, UowOrderItem } from './uowFixture.js';

describe('SingleRelation.attach change tracking', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  async function loadedItem(): Promise<UowOrderItem> {
    await UowOrder.insert({ Total: 1 });
    await UowOrder.insert({ Total: 2 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });

    return UowOrderItem.where({ Id: 1 }).first();
  }

  it('reports the foreign key with the attached target key as the new value', async () => {
    const item = await loadedItem();
    const target = await UowOrder.where({ Id: 2 }).first();

    item.Order.attach(target);

    expect(item.IsDirty).to.equal(true);
    expect(item.changeSet()).to.deep.equal([{ Column: 'order_id', OldValue: 1, NewValue: 2 }]);
  });

  it('reports the foreign key once across repeated attaches', async () => {
    const item = await loadedItem();
    const target = await UowOrder.where({ Id: 2 }).first();

    item.Order.attach(target);
    item.Order.attach(target);

    expect(item.changeSet().filter((c) => c.Column === 'order_id')).to.have.length(1);
  });

  it('reports an attached target that is not saved yet, so a cascade can insert it first', async () => {
    const item = await loadedItem();

    item.Order.attach(new UowOrder({ Total: 9 }));

    // The target has no key of its own yet. `setDefaults()` fills every column from its database
    // default, which sqlite reports as null for an autoincrement key, so `PrimaryKeyValue` reads
    // back as null rather than undefined. What matters is that the foreign key is reported at
    // all: the unit of work inserts the parent first and backfills the real key before the
    // statement runs.
    const change = item.changeSet().find((c) => c.Column === 'order_id');
    expect(change).to.not.equal(undefined);
    expect(change!.OldValue).to.equal(1);
    expect(change!.NewValue).to.equal(null);
  });

  it('detach reports the foreign key as a change to null', async () => {
    const item = await loadedItem();

    item.Order.detach();

    expect(item.IsDirty).to.equal(true);
    expect(item.changeSet()).to.deep.equal([{ Column: 'order_id', OldValue: 1, NewValue: null }]);
    expect((item.Order as any).Value).to.equal(null);
  });

  it('attaching the target the row already points at is not a change', async () => {
    const item = await loadedItem();
    const same = await UowOrder.where({ Id: 1 }).first();

    item.Order.attach(same);

    expect(item.IsDirty).to.equal(false);
  });

  it('does not reach into a private dirty list from outside the model', () => {
    const source = (Object.getPrototypeOf(new UowOrderItem({ Sku: 'A', Qty: 1 }).Order) as any).attach.toString();

    expect(source).to.not.contain('__dirty_props__');
    expect(source).to.not.contain('markDirty');
  });

  async function orderWithClient(): Promise<UowOrder> {
    await UowClient.insert({ Name: 'acme' });
    await UowOrder.insert({ Total: 1, client_id: 1 });

    return UowOrder.where({ Id: 1 }).first();
  }

  it('detach() then update() writes NULL and leaves the model clean', async () => {
    const order = await orderWithClient();

    order.Client.detach();
    await order.update();

    expect((await rows('uow_order'))[0].client_id).to.equal(null);
    expect(order.IsDirty).to.equal(false);
    expect(order.changeSet()).to.deep.equal([]);
  });

  it('remove() deletes the target and clears the foreign key', async () => {
    const order = await orderWithClient();
    await order.Client.populate();

    await order.Client.remove();

    expect(await rows('uow_client')).to.have.length(0);
    expect((await rows('uow_order'))[0].client_id).to.equal(null);
    expect(order.IsDirty).to.equal(false);
  });

  it('populate() that finds no row is a read, not a detach', async () => {
    await UowOrder.insert({ Total: 1, client_id: 42 });
    const order = await UowOrder.where({ Id: 1 }).first();

    await order.Client.populate();

    // `undefined`, not `null`: populate() assigns whatever `first()` resolved and never touches
    // the column. `null` is what a detach leaves behind, and the two must stay distinguishable -
    // the row still points at 42 and toSql() writes it.
    expect(order.Client.Value).to.equal(undefined);
    expect(order.IsDirty).to.equal(false);
    expect(order.toSql().client_id).to.equal(42);
  });

  it('a direct foreign-key write is overridden by a relation that holds the baseline target', async () => {
    const item = await loadedItem();
    await item.Order.populate();

    (item as any).order_id = 5;

    expect(item.changeSet()).to.deep.equal([]);
    expect(item.IsDirty).to.equal(false);
  });

  it('a relation re-pointed by assigning Value directly reports the target key, not the column', async () => {
    const item = await loadedItem();
    const target = await UowOrder.where({ Id: 2 }).first();

    // The relation machinery sets back-references this way, without touching the column.
    item.Order.Value = target;

    expect(item.changeSet()).to.deep.equal([{ Column: 'order_id', OldValue: 1, NewValue: 2 }]);
    expect(item.IsDirty).to.equal(true);
  });

  it('a held target wins over a direct foreign-key write, in the diff and in the row', async () => {
    const item = await loadedItem();
    const target = await UowOrder.where({ Id: 2 }).first();

    (item as any).order_id = 5;
    item.Order.Value = target;
    expect(item.changeSet()).to.deep.equal([{ Column: 'order_id', OldValue: 1, NewValue: 2 }]);

    await item.update();

    expect((await rows('uow_order_item'))[0].order_id).to.equal(2);
    expect(item.IsDirty).to.equal(false);
  });

  it('attach() writes the join column of an explicitly keyed belongsTo, not the target primary key', async () => {
    await UowAltTarget.insert({ Code: 'ALPHA', Label: 'first' });
    await UowAltTarget.insert({ Code: 'BETA', Label: 'second' });
    await UowAltOwner.insert({ target_code: 'BETA' });

    const owner = await UowAltOwner.where({ Id: 1 }).first();
    const alpha = await UowAltTarget.where({ Code: 'ALPHA' }).first();

    owner.Target.attach(alpha);

    expect(owner.target_code).to.equal('ALPHA');
    expect(owner.changeSet()).to.deep.equal([{ Column: 'target_code', OldValue: 'BETA', NewValue: 'ALPHA' }]);

    await owner.update();

    expect((await rows('uow_alt_owner'))[0].target_code).to.equal('ALPHA');
    expect(owner.IsDirty).to.equal(false);
  });

  it('save() writes the join column of an explicitly keyed belongsTo and converges', async () => {
    await UowAltTarget.insert({ Code: 'ALPHA', Label: 'first' });
    await UowAltTarget.insert({ Code: 'BETA', Label: 'second' });
    await UowAltOwner.insert({ target_code: 'BETA' });

    const owner = await UowAltOwner.where({ Id: 1 }).first();
    const alpha = await UowAltTarget.where({ Code: 'ALPHA' }).first();

    owner.Target.attach(alpha);
    await owner.save();

    expect((await rows('uow_alt_owner'))[0].target_code).to.equal('ALPHA');
    expect(owner.target_code).to.equal('ALPHA');
    expect(owner.IsDirty).to.equal(false);
  });
});
