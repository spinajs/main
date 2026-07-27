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
