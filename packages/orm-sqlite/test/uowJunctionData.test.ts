/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { QueryContext, SortOrder } from '@spinajs/orm';
import { bootUow, captureStatements, registerUowConnection, rows, UowOrder, UowOrderItem, UowOrderTag, UowTag } from './uowFixture.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

/** Runs `fn` with `model` declared on another connection, as a model of a second database would be. */
async function onOtherConnection<T>(model: { getModelDescriptor(): any }, fn: () => Promise<T>): Promise<T> {
  const descriptor = model.getModelDescriptor();
  const previous = descriptor.Connection;
  descriptor.Connection = 'other';
  try {
    return await fn();
  } finally {
    descriptor.Connection = previous;
  }
}

async function seed() {
  await UowOrder.insert({ Total: 10 });
  await UowOrder.insert({ Total: 20 });
  await UowTag.insert({ Name: 'red' });
  await UowTag.insert({ Name: 'blue' });
  await UowOrderTag.insert({ order_id: 1, tag_id: 1, Note: 'first red' } as any);
  await UowOrderTag.insert({ order_id: 1, tag_id: 2, Note: 'first blue' } as any);
  await UowOrderTag.insert({ order_id: 2, tag_id: 1, Note: 'second red' } as any);
}

const loadOrder = (id: number) => UowOrder.where({ Id: id }).populate('Tags').first();
const noteOf = (order: UowOrder, tagId: number) => order.Tags.junction<UowOrderTag>(order.Tags.find((t) => t.Id === tagId)!)?.Note;

describe('ModelBase.save - many-to-many junction data', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  describe('populate', () => {
    it('keeps each member junction row', async () => {
      await seed();
      const order = await loadOrder(1);

      expect(noteOf(order, 1)).to.equal('first red');
      expect(noteOf(order, 2)).to.equal('first blue');
      expect(order.Tags.junction(order.Tags[0])!.IsNew).to.equal(false);
    });

    it('keeps separate junction rows for one target linked by two owners', async () => {
      await seed();
      const [first, second] = await UowOrder.select().whereIn('Id', [1, 2]).order('Id', SortOrder.ASC).populate('Tags');

      expect(noteOf(first, 1)).to.equal('first red');
      expect(noteOf(second, 1)).to.equal('second red');
    });

    it('keeps junction rows when the relation is populated on a loaded model', async () => {
      await seed();
      const order = await UowOrder.where({ Id: 1 }).first();
      await order.Tags.populate();

      expect(noteOf(order, 2)).to.equal('first blue');
    });
  });

  describe('save', () => {
    it('writes the junction data of a member added to a new owner', async () => {
      await UowTag.insert({ Name: 'red' });
      const red = await UowTag.where({ Id: 1 }).first();

      const order = new UowOrder({ Total: 1 });
      order.Tags.add(red, { Note: 'linked' });
      const result = await order.save();

      expect(result.JunctionInserted).to.equal(1);
      expect(await rows('uow_order_tag')).to.deep.equal([{ Id: 1, order_id: order.Id, tag_id: 1, Note: 'linked' }]);
    });

    it('writes links with and without junction data in one save', async () => {
      await seed();
      await UowTag.insert({ Name: 'green' });
      const order = await loadOrder(2);
      const [blue, green] = await UowTag.select().whereIn('Id', [2, 3]).order('Id', SortOrder.ASC);

      order.Tags.add(blue, { Note: 'second blue' });
      order.Tags.push(green);
      await order.save();

      const links = (await rows('uow_order_tag')).filter((r) => r.order_id === 2);
      expect(links.map((r) => [r.tag_id, r.Note])).to.have.deep.members([
        [1, 'second red'],
        [2, 'second blue'],
        [3, null],
      ]);
    });

    it('updates a changed junction column of a kept link, and nothing else', async () => {
      await seed();
      const order = await loadOrder(1);
      order.Tags.junction<UowOrderTag>(order.Tags.find((t) => t.Id === 2)!)!.Note = 'changed';

      const capture = captureStatements();
      const result = await order.save();
      capture.restore();

      expect(result.JunctionUpdated).to.equal(1);
      expect(result.JunctionInserted + result.JunctionDeleted + result.Inserted + result.Updated).to.equal(0);
      expect(capture.statements.filter((s) => s.context === QueryContext.Update)).to.have.length(1);
      expect((await rows('uow_order_tag')).find((r) => r.order_id === 1 && r.tag_id === 2).Note).to.equal('changed');
      expect((await rows('uow_order_tag')).find((r) => r.order_id === 1 && r.tag_id === 1).Note).to.equal('first red');
    });

    it('writes nothing on a second save of the same links', async () => {
      await UowTag.insert({ Name: 'red' });
      const order = new UowOrder({ Total: 1 });
      order.Tags.add(await UowTag.where({ Id: 1 }).first(), { Note: 'linked' });
      await order.save();

      const second = await order.save();

      expect(second.JunctionInserted + second.JunctionUpdated + second.JunctionDeleted).to.equal(0);
    });

    it('refuses junction data on a relation without a junction table', () => {
      const order = new UowOrder({ Total: 1 });

      expect(() => order.Items.add(new UowOrderItem({ Sku: 'A', Qty: 1 }), { Note: 'x' })).to.throw(/junction/);
    });
  });

  describe('targets on another connection', () => {
    it('links a persisted target without collecting it', async () => {
      await UowTag.insert({ Name: 'red' });
      const red = await UowTag.where({ Id: 1 }).first();
      const order = new UowOrder({ Total: 1 });
      order.Tags.add(red, { Note: 'remote' });

      await onOtherConnection(UowTag, () => order.save());

      expect((await rows('uow_order_tag')).map((r) => [r.tag_id, r.Note])).to.deep.equal([[1, 'remote']]);
    });

    it('refuses a new target on another connection', async () => {
      const order = new UowOrder({ Total: 1 });
      order.Tags.push(new UowTag({ Name: 'fresh' }));

      await onOtherConnection(UowTag, async () => {
        await expect(order.save()).to.be.rejectedWith(/connection/);
      });
    });

    it('refuses a junction table on another connection', async () => {
      await UowTag.insert({ Name: 'red' });
      const order = new UowOrder({ Total: 1 });
      order.Tags.push(await UowTag.where({ Id: 1 }).first());

      await onOtherConnection(UowOrderTag, async () => {
        await expect(order.save()).to.be.rejectedWith(/connection/);
      });
    });
  });

  describe('new owner', () => {
    it('saves the children attached to a new owner without marking anything populated', async () => {
      const order = new UowOrder({ Total: 1 });
      order.attach(new UowOrderItem({ Sku: 'A', Qty: 1 }));
      order.attach(new UowOrderItem({ Sku: 'B', Qty: 2 }));

      const result = await order.save();

      expect(result.Inserted).to.equal(3);
      expect((await rows('uow_order_item')).map((r) => [r.Sku, r.order_id])).to.deep.equal([
        ['A', order.Id],
        ['B', order.Id],
      ]);
      expect(order.Items.Populated).to.equal(true);
    });
  });

  describe('clone', () => {
    it('copies a loaded graph: hasMany cloned, many-to-many targets linked with copies of their junction rows', async () => {
      await seed();
      await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 } as any);
      const order = await UowOrder.where({ Id: 1 }).populate('Tags').populate('Items').first();

      const copy = order.clone({ relations: ['Items', 'Tags'] });

      expect(copy.IsNew).to.equal(true);
      expect(copy.Id ?? null).to.equal(null);
      expect(copy.Total).to.equal(10);
      expect(copy.Items[0]).to.not.equal(order.Items[0]);
      expect(copy.Items[0].Id ?? null).to.equal(null);
      expect(copy.Tags[0]).to.equal(order.Tags[0]);
      expect(copy.Tags.junction<UowOrderTag>(copy.Tags[0])).to.not.equal(order.Tags.junction(order.Tags[0]));

      const result = await copy.save();

      expect(result.Inserted).to.equal(2);
      expect(result.JunctionInserted).to.equal(2);
      expect((await rows('uow_order_item')).map((r) => [r.Sku, r.order_id])).to.deep.equal([
        ['A', 1],
        ['A', copy.Id],
      ]);
      expect((await rows('uow_order_tag')).filter((r) => r.order_id === copy.Id).map((r) => [r.tag_id, r.Note])).to.have.deep.members([
        [1, 'first red'],
        [2, 'first blue'],
      ]);
      expect((await rows('uow_order_tag')).filter((r) => r.order_id === 1)).to.have.length(2);
    });

    it('leaves out the given columns', async () => {
      await UowOrder.insert({ Total: 10, client_id: 3 });
      const order = await UowOrder.where({ Id: 1 }).first();

      expect(order.clone({ omit: ['client_id'] }).client_id ?? null).to.equal(null);
    });

    it('does not copy a relation listed among the columns', async () => {
      await UowOrder.insert({ Total: 10 });
      const order = await UowOrder.where({ Id: 1 }).populate('Items').first();
      const columns = UowOrder.getModelDescriptor().Columns;
      columns.push({ ...columns[0], Name: 'Items' });

      try {
        expect(order.clone().Items).to.not.equal(order.Items);
      } finally {
        columns.pop();
      }
    });

    it('refuses a relation that was not populated', async () => {
      await UowOrder.insert({ Total: 10 });
      const order = await UowOrder.where({ Id: 1 }).first();

      expect(() => order.clone({ relations: ['Items'] })).to.throw(/not populated/);
    });

    it('refuses to descend through a many-to-many', async () => {
      await seed();
      const order = await loadOrder(1);

      expect(() => order.clone({ relations: ['Tags.Something'] })).to.throw(/many-to-many/);
    });
  });
});
