/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

chai.use(chaiAsPromised);
import { IdentityMap, OrphanPolicy, QueryContext, SubjectBuilder, SubjectExecutor, SubjectSorter } from '@spinajs/orm';
import { bootUow, captureStatements, registerUowConnection, rows, UowClient, UowNode, UowOrder, UowOrderItem, UowOrderTag, UowStrictItem, UowTag } from './uowFixture.js';

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
    expect(order.changes()).to.deep.equal([]);
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
    expect(order.changes()).to.deep.equal([]);
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

describe('SubjectExecutor - junction phase', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  async function seeded() {
    await UowOrder.insert({ Total: 10 });
    await UowTag.insert({ Name: 'red' });
    await UowTag.insert({ Name: 'blue' });
    await UowOrderTag.insert({ order_id: 1, tag_id: 1 });
    return await UowOrder.where({ Id: 1 }).populate('Tags').first();
  }

  it('inserts a junction row for an added existing tag', async () => {
    const order = await seeded();
    const blue = await UowTag.where({ Id: 2 }).first();
    order.Tags.push(blue);

    const result = await run(order);

    expect(result.JunctionInserted).to.equal(1);
    const links = await rows('uow_order_tag');
    expect(links.map((l: any) => l.tag_id).sort()).to.deep.equal([1, 2]);
  });

  it('inserts the new tag row before its junction row', async () => {
    const order = await seeded();
    order.Tags.push(new UowTag({ Name: 'green' }));

    const capture = captureStatements();
    await run(order);
    capture.restore();

    const inserts = insertsOf(capture.statements);
    const tagAt = inserts.findIndex((s) => s.expression.includes('uow_tag'));
    const linkAt = inserts.findIndex((s) => s.expression.includes('uow_order_tag'));

    expect(tagAt).to.be.greaterThan(-1);
    expect(linkAt).to.be.greaterThan(tagAt);
    expect((await rows('uow_order_tag')).length).to.equal(2);
  });

  it('deletes only the junction row when a tag is removed, never the tag', async () => {
    const order = await seeded();
    order.Tags.empty();

    const result = await run(order);

    expect(result.JunctionDeleted).to.equal(1);
    expect(await rows('uow_order_tag')).to.have.length(0);
    expect(await rows('uow_tag')).to.have.length(2);
  });

  it('scopes the junction delete to this owner', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowOrder.insert({ Total: 20 });
    await UowTag.insert({ Name: 'red' });
    await UowOrderTag.insert({ order_id: 1, tag_id: 1 });
    await UowOrderTag.insert({ order_id: 2, tag_id: 1 });

    const order = await UowOrder.where({ Id: 1 }).populate('Tags').first();
    order.Tags.empty();

    await run(order);

    const links = await rows('uow_order_tag');
    expect(links).to.have.length(1);
    expect(links[0].order_id).to.equal(2);
  });

  it('batches junction inserts to the configured chunk size', async () => {
    await UowOrder.insert({ Total: 10 });
    for (let i = 1; i <= 5; i += 1) {
      await UowTag.insert({ Name: `t${i}` });
    }

    const order = await UowOrder.where({ Id: 1 }).populate('Tags').first();
    order.Tags.push(...(await UowTag.all()));

    const set = new SubjectBuilder(new IdentityMap()).build(order);
    const plan = new SubjectSorter().sort(set);

    const capture = captureStatements();
    await new SubjectExecutor({ chunk: 2 }).execute(plan);
    capture.restore();

    const junctionInserts = insertsOf(capture.statements).filter((s) => s.expression.includes('uow_order_tag'));
    expect(junctionInserts).to.have.length(3); // 2 + 2 + 1
    expect(await rows('uow_order_tag')).to.have.length(5);
  });
});

describe('SubjectExecutor - orphan phase', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  it('deletes an orphan under the delete policy', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
    const order = await UowOrder.where({ Id: 1 }).populate('Items').first();

    order.Items.empty();
    const result = await run(order);

    expect(result.Deleted).to.equal(1);
    expect(await rows('uow_order_item')).to.have.length(0);
  });

  it('nullifies an orphan under the nullify policy', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
    const order = await UowOrder.where({ Id: 1 }).populate('Items').first();

    const relation = order.ModelDescriptor!.Relations.get('Items')!;
    const previous = relation.Orphan;
    relation.Orphan = OrphanPolicy.Nullify;

    try {
      order.Items.empty();
      const result = await run(order);

      expect(result.Updated).to.equal(1);
      expect(result.Deleted).to.equal(0);
      const items = await rows('uow_order_item');
      expect(items).to.have.length(1);
      expect(items[0].order_id).to.equal(null);
    } finally {
      relation.Orphan = previous;
    }
  });

  it('refuses to guess a policy when the foreign key is reflected NOT NULL', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowStrictItem.insert({ Sku: 'S', order_id: 1 });
    const order = await UowOrder.where({ Id: 1 }).populate('StrictItems').first();

    order.StrictItems.empty();

    // The row survives: refusing is a recoverable failure, an unasked-for DELETE is not.
    await expect(run(order)).to.be.rejectedWith(/NOT NULL/);
    expect(await rows('uow_strict_item')).to.have.length(1);
  });

  it('deletes when the relation declares the delete policy explicitly', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowStrictItem.insert({ Sku: 'S', order_id: 1 });
    const order = await UowOrder.where({ Id: 1 }).populate('StrictItems').first();

    const relation = order.ModelDescriptor!.Relations.get('StrictItems')!;
    const previous = relation.Orphan;
    relation.Orphan = OrphanPolicy.Delete;

    try {
      order.StrictItems.empty();
      const result = await run(order);

      expect(result.Deleted).to.equal(1);
      expect(await rows('uow_strict_item')).to.have.length(0);
    } finally {
      relation.Orphan = previous;
    }
  });

  it('does nothing under the disable policy', async () => {
    await UowOrder.insert({ Total: 10 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
    const order = await UowOrder.where({ Id: 1 }).populate('Items').first();

    const relation = order.ModelDescriptor!.Relations.get('Items')!;
    const previous = relation.Orphan;
    relation.Orphan = OrphanPolicy.Disable;

    try {
      order.Items.empty();
      const result = await run(order);

      expect(result.Deleted).to.equal(0);
      expect(await rows('uow_order_item')).to.have.length(1);
    } finally {
      relation.Orphan = previous;
    }
  });

  it('chunks the key list of an orphan delete', async () => {
    await UowOrder.insert({ Total: 10 });
    for (let i = 1; i <= 5; i += 1) {
      await UowOrderItem.insert({ Sku: `s${i}`, Qty: 1, order_id: 1 });
    }

    const order = await UowOrder.where({ Id: 1 }).populate('Items').first();
    order.Items.empty();

    const set = new SubjectBuilder(new IdentityMap()).build(order);
    const plan = new SubjectSorter().sort(set);

    const capture = captureStatements();
    await new SubjectExecutor({ chunk: 2 }).execute(plan);
    capture.restore();

    const deletes = capture.statements.filter((s) => s.context === QueryContext.Delete);
    expect(deletes).to.have.length(3);
    expect(await rows('uow_order_item')).to.have.length(0);
  });
});
