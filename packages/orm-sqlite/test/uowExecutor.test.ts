/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import { IdentityMap, QueryContext, SubjectBuilder, SubjectExecutor, SubjectSorter } from '@spinajs/orm';
import { bootUow, captureStatements, registerUowConnection, rows, UowClient, UowNode, UowOrder, UowOrderItem } from './uowFixture.js';

/** Builds, sorts and executes a graph outside any transaction — the executor under test only. */
async function run(root: any) {
  const set = new SubjectBuilder(new IdentityMap()).build(root);
  const plan = new SubjectSorter().sort(set);
  return await new SubjectExecutor({}).execute(plan);
}

/**
 * INSERT statements, whichever context they carry. `InsertQueryBuilder.returning()` flips
 * QueryContext.Insert to QueryContext.InsertReturning, and the executor asks for RETURNING
 * on every dialect that supports it — sqlite does.
 */
function insertsOf(statements: { context: QueryContext; expression: string }[]) {
  return statements.filter((s) => s.context === QueryContext.Insert || s.context === QueryContext.InsertReturning);
}

describe('SubjectExecutor - insert phase', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  it('inserts a single new model and backfills its generated key', async () => {
    const order = new UowOrder({ Total: 120 });

    const result = await run(order);

    expect(result.Inserted).to.equal(1);
    expect(order.Id).to.be.a('number').and.greaterThan(0);
    expect(await rows('uow_order')).to.have.length(1);
  });

  it('leaves the saved model clean and snapshotted', async () => {
    const order = new UowOrder({ Total: 120 });

    await run(order);

    expect(order.IsDirty).to.equal(false);
    expect(order.Snapshot).to.not.equal(null);
    expect(order.changedColumns()).to.deep.equal([]);
  });

  it('inserts the belongsTo parent first and stamps its key on the child', async () => {
    const client = new UowClient({ Name: 'acme' });
    const order = new UowOrder({ Total: 5 });
    order.Client.attach(client);

    const capture = captureStatements();
    await run(order);
    capture.restore();

    const inserts = insertsOf(capture.statements);
    expect(inserts[0].expression).to.contain('uow_client');
    expect(inserts[1].expression).to.contain('uow_order');

    const persisted = (await rows('uow_order'))[0];
    expect(persisted.client_id).to.equal(client.Id);
  });

  it('inserts hasMany children after the owner with the owner key stamped on them', async () => {
    const order = new UowOrder({ Total: 5 });
    (order.Items as any).Populated = true;
    order.Items.push(new UowOrderItem({ Sku: 'A', Qty: 1 }), new UowOrderItem({ Sku: 'B', Qty: 2 }));

    const result = await run(order);

    expect(result.Inserted).to.equal(3);
    const items = await rows('uow_order_item');
    expect(items).to.have.length(2);
    expect(items.every((i: any) => i.order_id === order.Id)).to.equal(true);
  });

  it('omits a deferred self-referencing foreign key from the INSERT', async () => {
    const a = new UowNode({ Name: 'a' });
    const b = new UowNode({ Name: 'b' });
    a.Parent.attach(b);
    b.Parent.attach(a);

    const capture = captureStatements();
    await run(a);
    capture.restore();

    const inserts = insertsOf(capture.statements);
    expect(inserts).to.have.length(2);
    expect(inserts.some((s) => s.expression.includes('parent_id'))).to.equal(false);
  });

  it('inserts a self-referencing tree parent first without deferring anything', async () => {
    const parent = new UowNode({ Name: 'root' });
    const child = new UowNode({ Name: 'leaf' });
    child.Parent.attach(parent);

    await run(child);

    const persisted = await rows('uow_node');
    const leaf = persisted.find((n: any) => n.Name === 'leaf');
    const root = persisted.find((n: any) => n.Name === 'root');
    expect(leaf.parent_id).to.equal(root.Id);
  });

  it('does nothing at all for a graph with no changes', async () => {
    await UowOrder.insert({ Total: 10 });
    const order = await UowOrder.where({ Id: 1 }).first();

    const capture = captureStatements();
    const result = await run(order);
    capture.restore();

    expect(capture.statements).to.have.length(0);
    expect(result).to.deep.equal({ Inserted: 0, Updated: 0, Deleted: 0, SoftDeleted: 0, JunctionInserted: 0, JunctionDeleted: 0 });
  });
});

describe('SubjectExecutor - update phase', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  it('updates only the changed column', async () => {
    await UowOrder.insert({ Total: 10, client_id: 3 });
    const order = await UowOrder.where({ Id: 1 }).first();
    order.Total = 99;

    const capture = captureStatements();
    const result = await run(order);
    capture.restore();

    const updates = capture.statements.filter((s) => s.context === QueryContext.Update);
    expect(updates).to.have.length(1);
    expect(updates[0].expression).to.contain('`Total`');
    expect(updates[0].expression).to.not.contain('`client_id`');
    expect(result.Updated).to.equal(1);
    expect((await rows('uow_order'))[0].Total).to.equal(99);
  });

  it('leaves the updated model clean and re-snapshotted', async () => {
    await UowOrder.insert({ Total: 10 });
    const order = await UowOrder.where({ Id: 1 }).first();
    order.Total = 99;

    await run(order);

    expect(order.IsDirty).to.equal(false);
    expect(order.changedColumns()).to.deep.equal([]);
  });

  it('emits no statement for a model whose write restored the original value', async () => {
    await UowOrder.insert({ Total: 10 });
    const order = await UowOrder.where({ Id: 1 }).first();
    order.Total = 99;
    order.Total = 10;

    const capture = captureStatements();
    const result = await run(order);
    capture.restore();

    expect(capture.statements).to.have.length(0);
    expect(result.Updated).to.equal(0);
  });

  it('persists a re-parented clean child through the update phase', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowOrder.insert({ Total: 20 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });

    const source = await UowOrder.where({ Id: 1 }).populate('Items').first();
    const target = await UowOrder.where({ Id: 2 }).populate('Items').first();

    const moved = source.Items[0];
    source.Items.splice(0, 1);
    target.Items.push(moved);

    expect(moved.IsDirty).to.equal(false);

    const result = await run(target);

    expect(result.Updated).to.equal(1);
    expect((await rows('uow_order_item'))[0].order_id).to.equal(2);
  });

  it('applies a deferred self-referencing foreign key as a follow-up UPDATE', async () => {
    const a = new UowNode({ Name: 'a' });
    const b = new UowNode({ Name: 'b' });
    a.Parent.attach(b);
    b.Parent.attach(a);

    const capture = captureStatements();
    await run(a);
    capture.restore();

    const updates = capture.statements.filter((s) => s.context === QueryContext.Update);
    expect(updates.length).to.be.greaterThan(0);
    expect(updates[0].expression).to.contain('`parent_id`');

    const persisted = await rows('uow_node');
    const rowA = persisted.find((n: any) => n.Name === 'a');
    const rowB = persisted.find((n: any) => n.Name === 'b');
    expect(rowA.parent_id).to.equal(rowB.Id);
    expect(rowB.parent_id).to.equal(rowA.Id);
  });

  it('writes an update WHERE clause keyed on the primary key', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowOrder.insert({ Total: 20 });
    const order = await UowOrder.where({ Id: 2 }).first();
    order.Total = 99;

    await run(order);

    const persisted = await rows('uow_order');
    expect(persisted.find((o: any) => o.Id === 1).Total).to.equal(10);
    expect(persisted.find((o: any) => o.Id === 2).Total).to.equal(99);
  });
});
