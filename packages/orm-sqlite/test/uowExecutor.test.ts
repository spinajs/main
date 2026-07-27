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
