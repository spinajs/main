/* eslint-disable @typescript-eslint/no-explicit-any */
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import './migrations/PgOrderMigration_2026_10_15_00_01_00.js';
import { IPgSuite, openSuite } from './harness.js';
import { PgClient, PgOrder, PgOrderItem, PgOrderTag, PgTag } from './models/orders.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const loadOrder = (id: number) => PgOrder.where({ Id: id }).populate('Tags').first();
const noteOf = (order: PgOrder, tagId: number) => order.Tags.junction<PgOrderTag>(order.Tags.find((t) => t.Id === tagId)!)?.Note;

describe('postgres integration - relations', function () {
  let suite: IPgSuite;

  async function seed() {
    const acme = await PgClient.create({ Name: 'acme' });
    await PgOrder.insert([
      { Total: 10, client_id: acme.Id },
      { Total: 20, client_id: acme.Id },
    ] as any);
    await PgOrderItem.insert([
      { Sku: 'A', order_id: 1 },
      { Sku: 'B', order_id: 1 },
    ] as any);
    await PgTag.insert([{ Name: 'red' }, { Name: 'blue' }] as any);
    await PgOrderTag.insert([
      { order_id: 1, tag_id: 1, Note: 'first red' },
      { order_id: 1, tag_id: 2, Note: 'first blue' },
      { order_id: 2, tag_id: 1, Note: 'second red' },
    ] as any);
  }

  const junctionRows = () => suite.raw<{ order_id: number; tag_id: number; Note: string | null }[]>('SELECT "order_id", "tag_id", "Note" FROM "pg_order_tag" ORDER BY "Id"');

  before(async function () {
    suite = await openSuite(this, { name: 'rel' });
  });

  beforeEach(async () => {
    await suite.reset('pg_order_tag', 'pg_order_item', 'pg_order', 'pg_tag', 'pg_client');
  });

  after(async () => {
    await suite?.close();
  });

  it('saves a whole graph parent-first under real foreign keys', async () => {
    const order = new PgOrder({ Total: 120 });
    order.Client.attach(new PgClient({ Name: 'acme' }));
    (order.Items as any).Populated = true;
    order.Items.push(new PgOrderItem({ Sku: 'A' }), new PgOrderItem({ Sku: 'B' }));

    const result = await order.save();

    expect(result.Inserted).to.equal(4);
    expect((await PgOrderItem.all()).map((i) => i.order_id)).to.deep.equal([order.Id, order.Id]);
  });

  it('populates a belongsTo through a join', async () => {
    await seed();
    const order = await PgOrder.where({ Id: 1 }).populate('Client').first();

    expect(order.Client.Value!.Name).to.equal('acme');
  });

  it('populates a hasMany', async () => {
    await seed();
    const order = await PgOrder.where({ Id: 1 }).populate('Items').first();

    expect(order.Items.map((i) => i.Sku).sort()).to.deep.equal(['A', 'B']);
  });

  it('populates a many-to-many and keeps each junction row', async () => {
    await seed();
    const order = await loadOrder(1);

    expect(noteOf(order, 1)).to.equal('first red');
    expect(noteOf(order, 2)).to.equal('first blue');
  });

  it('keeps separate junction rows for one target linked by two owners', async () => {
    await seed();
    const [first, second] = await PgOrder.select().whereIn('Id', [1, 2]).orderBy('Id').populate('Tags');

    expect(noteOf(first, 1)).to.equal('first red');
    expect(noteOf(second, 1)).to.equal('second red');
  });

  it('writes the junction data of a member added to a new owner', async () => {
    await PgTag.insert({ Name: 'red' } as any);
    const red = await PgTag.where({ Id: 1 }).first();

    const order = new PgOrder({ Total: 1 });
    order.Tags.add(red, { Note: 'linked' });
    const result = await order.save();

    expect(result.JunctionInserted).to.equal(1);
    expect(await junctionRows()).to.deep.equal([{ order_id: order.Id, tag_id: 1, Note: 'linked' }]);
  });

  it('updates a changed junction column of a kept link, and nothing else', async () => {
    await seed();
    const order = await loadOrder(1);
    order.Tags.junction<PgOrderTag>(order.Tags.find((t) => t.Id === 2)!)!.Note = 'changed';

    const result = await order.save();

    expect(result.JunctionUpdated).to.equal(1);
    expect((await junctionRows()).map((r) => r.Note)).to.deep.equal(['first red', 'changed', 'second red']);
  });

  it('filters owners by existence of a relation', async () => {
    await seed();
    const ids = (await PgOrder.query().whereExist('Items')).map((o) => o.Id);

    expect(ids).to.deep.equal([1]);
  });
});
