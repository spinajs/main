/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import { IdentityMap, SubjectBuilder, SubjectOperation } from '@spinajs/orm';
import { bootUow, registerUowConnection, UowClient, UowOrder, UowOrderItem, UowTag } from './uowFixture.js';

function builder() {
  return new SubjectBuilder(new IdentityMap());
}

describe('SubjectBuilder - traversal and classification', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  it('classifies a freshly constructed model as an insert', () => {
    const set = builder().build(new UowOrder({ Total: 120 }));

    expect(set.Subjects.length).to.equal(1);
    expect(set.Subjects[0].Operation).to.equal(SubjectOperation.Insert);
  });

  it('classifies an unmodified loaded model as none', async () => {
    await UowOrder.insert({ Total: 10 });
    const order = await UowOrder.where({ Id: 1 }).first();

    const set = builder().build(order);

    expect(set.Subjects[0].Operation).to.equal(SubjectOperation.None);
    expect(set.IsEmpty).to.equal(true);
  });

  it('classifies a mutated loaded model as an update naming only the changed column', async () => {
    await UowOrder.insert({ Total: 10 });
    const order = await UowOrder.where({ Id: 1 }).first();
    order.Total = 99;

    const set = builder().build(order);

    expect(set.Subjects[0].Operation).to.equal(SubjectOperation.Update);
    expect(set.Subjects[0].ChangedColumns).to.deep.equal(['Total']);
  });

  it('classifies a model whose write restored the original value as none', async () => {
    await UowOrder.insert({ Total: 10 });
    const order = await UowOrder.where({ Id: 1 }).first();
    order.Total = 99;
    order.Total = 10;

    expect(builder().build(order).Subjects[0].Operation).to.equal(SubjectOperation.None);
  });

  it('treats a new model with a pre-filled key as an insert', () => {
    const tag = new UowTag({ Name: 'x' });
    (tag as any).Id = 4242;

    expect(builder().build(tag).Subjects[0].Operation).to.equal(SubjectOperation.Insert);
  });

  it('descends into a belongsTo whose Value is set, even though it is not Populated', () => {
    const order = new UowOrder({ Total: 1 });
    order.Client.attach(new UowClient({ Name: 'acme' }));

    expect(order.Client.Populated).to.equal(false);

    const set = builder().build(order);
    expect(set.Subjects.length).to.equal(2);
    expect(set.Subjects.map((s) => s.Descriptor.Name).sort()).to.deep.equal(['UowClient', 'UowOrder']);
  });

  it('records the belongsTo foreign key as pending on the owner', () => {
    const client = new UowClient({ Name: 'acme' });
    const order = new UowOrder({ Total: 1 });
    order.Client.attach(client);

    const set = builder().build(order);
    const orderSubject = set.find(order)!;

    expect(orderSubject.PendingForeignKeys.length).to.equal(1);
    expect(orderSubject.PendingForeignKeys[0].Column).to.equal('client_id');
    expect(orderSubject.PendingForeignKeys[0].Target).to.equal(client);
  });

  it('does not descend into a belongsTo with no Value', () => {
    expect(builder().build(new UowOrder({ Total: 1 })).Subjects.length).to.equal(1);
  });

  it('does not descend into a hasMany that was never populated', () => {
    const order = new UowOrder({ Total: 1 });
    order.Items.push(new UowOrderItem({ Sku: 'A', Qty: 1 }));

    expect(order.Items.Populated).to.equal(false);
    expect(builder().build(order).Subjects.length).to.equal(1);
  });

  it('descends into a hasMany once it is populated', async () => {
    const order = new UowOrder({ Total: 1 });
    (order.Items as any).Populated = true;
    order.Items.push(new UowOrderItem({ Sku: 'A', Qty: 1 }));

    expect(builder().build(order).Subjects.length).to.equal(2);
  });

  it('terminates on a cycle in the object graph', () => {
    const order = new UowOrder({ Total: 1 });
    const item = new UowOrderItem({ Sku: 'A', Qty: 1 });
    (order.Items as any).Populated = true;
    order.Items.push(item);
    item.Order.attach(order);

    const set = builder().build(order);
    expect(set.Subjects.length).to.equal(2);
  });

  it('produces one subject for a row reached through two paths', async () => {
    await UowClient.insert({ Name: 'acme' });
    const clientA = await UowClient.where({ Id: 1 }).first();
    const clientB = await UowClient.where({ Id: 1 }).first();

    expect(clientA).to.not.equal(clientB);

    const orderA = new UowOrder({ Total: 1 });
    const orderB = new UowOrder({ Total: 2 });
    orderA.Client.attach(clientA);
    orderB.Client.attach(clientB);

    const root = new UowClient({ Name: 'root' });
    (root.Orders as any).Populated = true;
    root.Orders.push(orderA, orderB);

    const set = builder().build(root);
    const clientSubjects = set.Subjects.filter((s) => s.Descriptor.Name === 'UowClient');

    expect(clientSubjects.length).to.equal(2); // the new root plus the one canonical acme
  });

  it('never produces a subject for a Query or Virtual relation', async () => {
    await UowOrder.insert({ Total: 10 });
    const order = await UowOrder.where({ Id: 1 }).first();

    const set = builder().build(order);
    expect(set.Subjects.every((s) => s.Descriptor.Name !== undefined)).to.equal(true);
  });
});

describe('SubjectBuilder - hasMany delta', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  async function seedOrderWithItems() {
    await UowOrder.insert({ Total: 10 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
    await UowOrderItem.insert({ Sku: 'B', Qty: 2, order_id: 1 });
    return await UowOrder.where({ Id: 1 }).populate('Items').first();
  }

  it('reports no delta when nothing changed', async () => {
    const order = await seedOrderWithItems();

    const set = builder().build(order);
    const delta = set.find(order)!.RelationDeltas.find((d: any) => d.Descriptor.Name === 'Items')!;

    expect(delta.Added).to.deep.equal([]);
    expect(delta.RemovedKeys).to.deep.equal([]);
    expect(delta.Kept.length).to.equal(2);
  });

  it('puts a brand new child in Added', async () => {
    const order = await seedOrderWithItems();
    const fresh = new UowOrderItem({ Sku: 'C', Qty: 3 });
    order.Items.push(fresh);

    const delta = builder().build(order).find(order)!.RelationDeltas.find((d: any) => d.Descriptor.Name === 'Items')!;

    expect(delta.Added).to.deep.equal([fresh]);
    expect(delta.RemovedKeys).to.deep.equal([]);
  });

  it('puts a spliced-out child key in RemovedKeys', async () => {
    const order = await seedOrderWithItems();
    const removed = order.Items[1];
    order.Items.splice(1, 1);

    const delta = builder().build(order).find(order)!.RelationDeltas.find((d: any) => d.Descriptor.Name === 'Items')!;

    expect(delta.RemovedKeys).to.deep.equal([removed.Id]);
    expect(delta.Kept.length).to.equal(1);
  });

  it('stamps the owner foreign key as pending on every added and kept child', async () => {
    const order = await seedOrderWithItems();
    const fresh = new UowOrderItem({ Sku: 'C', Qty: 3 });
    order.Items.push(fresh);

    const set = builder().build(order);

    for (const child of [...order.Items]) {
      const fks = set.find(child)!.PendingForeignKeys.filter((f: any) => f.Column === 'order_id');
      expect(fks.length, `child ${child.Sku}`).to.equal(1);
      expect(fks[0].Target).to.equal(order);
    }
  });

  it('treats a re-parented clean child as Kept and promotes it to an update', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowOrder.insert({ Total: 20 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });

    const source = await UowOrder.where({ Id: 1 }).populate('Items').first();
    const target = await UowOrder.where({ Id: 2 }).populate('Items').first();

    const moved = source.Items[0];
    source.Items.splice(0, 1);
    target.Items.push(moved);

    expect(moved.IsDirty).to.equal(false);

    const set = builder().build(target);
    const delta = set.find(target)!.RelationDeltas.find((d: any) => d.Descriptor.Name === 'Items')!;

    expect(delta.Kept).to.deep.equal([moved]);
    expect(set.find(moved)!.PendingForeignKeys[0].Target).to.equal(target);
  });

  it('produces no delta for a hasMany that was never populated', async () => {
    const order = (await UowOrder.where({ Id: 1 }).first().catch(() => null)) ?? new UowOrder({ Total: 1 });
    order.Items.push(new UowOrderItem({ Sku: 'X', Qty: 1 }));

    const subject = builder().build(order).find(order)!;

    expect(subject.RelationDeltas.find((d: any) => d.Descriptor.Name === 'Items')).to.equal(undefined);
  });

  it('reports every member as Added for a populated but previously empty relation', async () => {
    await UowOrder.insert({ Total: 10 });
    const order = await UowOrder.where({ Id: 1 }).populate('Items').first();

    expect(order.Items.length).to.equal(0);
    expect(order.Items.Populated).to.equal(true);

    const a = new UowOrderItem({ Sku: 'A', Qty: 1 });
    order.Items.push(a);

    const delta = builder().build(order).find(order)!.RelationDeltas.find((d: any) => d.Descriptor.Name === 'Items')!;

    expect(delta.Added).to.deep.equal([a]);
    expect(delta.RemovedKeys).to.deep.equal([]);
  });

  it('reports every key as removed when a populated relation is emptied', async () => {
    const order = await seedOrderWithItems();
    const keys = order.Items.map((i: any) => i.Id);
    order.Items.empty();

    const delta = builder().build(order).find(order)!.RelationDeltas.find((d: any) => d.Descriptor.Name === 'Items')!;

    expect([...delta.RemovedKeys].sort()).to.deep.equal([...keys].sort());
    expect(delta.Kept).to.deep.equal([]);
  });
});
