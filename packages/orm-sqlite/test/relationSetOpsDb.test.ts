/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { DeleteQueryBuilder, InsertQueryBuilder, QueryMiddleware, SelectQueryBuilder, UpdateQueryBuilder, extractModelDescriptor } from '@spinajs/orm';
import type { QueryBuilder } from '@spinajs/orm';
import { bootUow, registerUowConnection, rows, UowOrder, UowOrderItem, UowOrderTag, UowTag } from './uowFixture.js';
import { SdOwner } from './models/sd/SdOwner.js';
import { SdItem } from './models/sd/SdItem.js';
import './migrations/SdMigration_2026_08_03_00_00_00.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const statements = { recording: false, seen: [] as string[] };

function verbOf(query: QueryBuilder): string {
  if (query instanceof SelectQueryBuilder) return 'select';
  if (query instanceof InsertQueryBuilder) return 'insert';
  if (query instanceof UpdateQueryBuilder) return 'update';
  return query instanceof DeleteQueryBuilder ? 'delete' : query.constructor.name;
}

/** Every statement a write runs, with the model it was built on. */
class StatementRecorder extends QueryMiddleware {
  afterQueryCreation(): void {}

  beforeQueryExecution(query: QueryBuilder): void {
    if (statements.recording) statements.seen.push(`${verbOf(query)} ${query.Model?.name ?? 'no model'}`);
  }
}

describe('Relation set operations against the database', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  async function seededOrder() {
    await UowOrder.insert({ Total: 10 });
    await UowTag.insert({ Name: 'red' }); // 1
    await UowTag.insert({ Name: 'blue' }); // 2
    await UowOrderTag.insert({ order_id: 1, tag_id: 1 });
    await UowOrderTag.insert({ order_id: 1, tag_id: 2 });
  }

  describe('lazy many-to-many populate', () => {
    it('loads members through a junction whose relation properties are not named after the target class', async () => {
      await seededOrder();

      // No eager .populate('Tags') — force the lazy ManyToManyRelationList.populate() path.
      const order = await UowOrder.where({ Id: 1 }).first();
      expect(order.Tags.length).to.eq(0);

      await order.Tags.populate();

      expect(order.Tags.Populated).to.be.true;
      expect(order.Tags.map((t: any) => t.Id).sort()).to.deep.eq([1, 2]);
      expect(order.Tags.map((t: any) => t.Name).sort()).to.deep.eq(['blue', 'red']);
    });
  });

  describe('many-to-many sync', () => {
    it('keeps the junction row of a member whose primary key is 0', async () => {
      await UowOrder.insert({ Total: 10 });
      await UowTag.insert({ Id: 0, Name: 'zero' } as any);
      await UowOrderTag.insert({ order_id: 1, tag_id: 0 });

      const order = await UowOrder.where({ Id: 1 }).populate('Tags').first();
      expect(order.Tags.map((t: any) => t.Id)).to.deep.eq([0]);

      await order.Tags.sync();

      const links = await rows('uow_order_tag');
      expect(links).to.have.length(1);
      expect(links[0].tag_id).to.eq(0);
    });

    it('is idempotent — syncing an unchanged relation does not duplicate junction rows', async () => {
      await seededOrder();

      const order = await UowOrder.where({ Id: 1 }).populate('Tags').first();
      await order.Tags.sync();
      await order.Tags.sync();

      const links = await rows('uow_order_tag');
      expect(links).to.have.length(2);
      expect(links.map((l: any) => l.tag_id).sort()).to.deep.eq([1, 2]);
    });

    it('counts junction rows that the soft-delete or archive filter of the junction model hides as links', async () => {
      await seededOrder();
      await UowOrderTag.update({ Note: 'hidden' }).where('Id', '>', 0);
      const descriptor = extractModelDescriptor(UowOrderTag)!;
      // Not populated, so the list holds no junction rows of its own and relies on the select of existing links.
      const order = await UowOrder.where({ Id: 1 }).first();
      order.Tags.push(...(await UowTag.where('Id', '>', 0)));

      for (const marker of [{ SoftDelete: { DeletedAt: 'Note' } }, { Archived: { ArchivedAt: 'Note' } }]) {
        const saved = { SoftDelete: descriptor.SoftDelete, Archived: descriptor.Archived };
        Object.assign(descriptor, marker);
        try {
          await order.Tags.sync();
        } finally {
          Object.assign(descriptor, saved);
        }

        const links = await rows<{ tag_id: number; Note: string | null }>('uow_order_tag');
        expect(links.map((l) => [l.tag_id, l.Note]), Object.keys(marker)[0]).to.deep.eq([[1, 'hidden'], [2, 'hidden']]);
      }
    });

    it('persists an unsaved target model before writing its junction row', async () => {
      await seededOrder();

      const order = await UowOrder.where({ Id: 1 }).populate('Tags').first();
      order.Tags.push(new UowTag({ Name: 'green' }));

      await order.Tags.sync();

      const tags = await rows('uow_tag');
      const green = tags.find((t: any) => t.Name === 'green');
      expect(green, 'the fresh tag row must be inserted').to.not.be.undefined;

      const links = await rows('uow_order_tag');
      expect(links.map((l: any) => l.tag_id).sort()).to.deep.eq([1, 2, green.Id].sort());
      expect(links.every((l: any) => l.tag_id !== null && l.tag_id !== undefined)).to.be.true;
    });
  });

  describe('statements of sync() and update()', () => {
    before(() => DI.register(StatementRecorder).as(QueryMiddleware));
    after(() => DI.unregister(StatementRecorder));

    async function recorded(write: () => Promise<void>): Promise<string[]> {
      statements.recording = true;
      statements.seen = [];
      try {
        await write();
      } finally {
        statements.recording = false;
      }
      return statements.seen;
    }

    it('builds every statement of a one-to-many sync() and update() on the target model', async () => {
      await UowOrder.insert({ Total: 10 });
      await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
      await UowOrderItem.insert({ Sku: 'B', Qty: 2, order_id: 1 });
      const order = await UowOrder.where({ Id: 1 }).populate('Items').first();

      order.Items.remove((i) => i.Sku === 'B');
      order.Items.push(new UowOrderItem({ Sku: 'C', Qty: 3 }));
      expect(await recorded(() => order.Items.sync())).to.deep.eq(['insert UowOrderItem', 'delete UowOrderItem']);

      order.Items.push(new UowOrderItem({ Sku: 'D', Qty: 4 }));
      expect(await recorded(() => order.Items.update())).to.deep.eq(['insert UowOrderItem']);

      expect((await rows<{ Sku: string }>('uow_order_item')).map((r) => r.Sku)).to.deep.eq(['A', 'C', 'D']);
    });

    it('builds every statement of a many-to-many sync() and update() on the junction or the target model', async () => {
      await seededOrder();
      const order = await UowOrder.where({ Id: 1 }).populate('Tags').first();

      order.Tags.remove((t) => t.Name === 'blue');
      order.Tags.push(new UowTag({ Name: 'green' }));
      expect(await recorded(() => order.Tags.sync())).to.deep.eq(['select UowOrderTag', 'insert UowTag', 'insert UowOrderTag', 'delete UowOrderTag']);

      order.Tags.push(new UowTag({ Name: 'black' }));
      expect(await recorded(() => order.Tags.update())).to.deep.eq(['select UowOrderTag', 'insert UowTag', 'insert UowOrderTag']);

      expect((await rows<{ tag_id: number }>('uow_order_tag')).map((l) => l.tag_id)).to.deep.eq([1, 3, 4]);
    });
  });

  describe('one-to-many sync with a soft-delete target', () => {
    async function seededOwner() {
      await SdOwner.insert({ Name: 'owner' });
      await SdItem.insert({ owner_id: 1, Val: 'a' });
      await SdItem.insert({ owner_id: 1, Val: 'b' });
      await SdItem.insert({ owner_id: 1, Val: 'c' });
      return await SdOwner.where({ Id: 1 }).populate('Items').first();
    }

    it('stamps DeletedAt on orphans instead of hard-deleting them', async () => {
      const owner = await seededOwner();
      expect(owner.Items.length).to.eq(3);

      owner.Items.remove(owner.Items[1]);
      await owner.Items.sync();

      const all = await rows('sd_item');
      expect(all, 'no row may be hard-deleted').to.have.length(3);

      const stamped = all.filter((r: any) => r.DeletedAt !== null && r.DeletedAt !== undefined);
      expect(stamped).to.have.length(1);
      expect(stamped[0].Val).to.eq('b');
    });

    it('leaves kept members unstamped', async () => {
      const owner = await seededOwner();

      owner.Items.remove((i: any) => i.Val === 'c');
      await owner.Items.sync();

      const all = await rows('sd_item');
      const kept = all.filter((r: any) => r.DeletedAt === null || r.DeletedAt === undefined);
      expect(kept.map((r: any) => r.Val).sort()).to.deep.eq(['a', 'b']);
    });
  });
});
