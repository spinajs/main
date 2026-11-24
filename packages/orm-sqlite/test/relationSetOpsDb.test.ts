/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { DeleteQueryBuilder, InsertQueryBuilder, QueryBuilder, QueryMiddleware, SelectQueryBuilder, UpdateQueryBuilder, extractModelDescriptor, relationSyncOf } from '@spinajs/orm';
import { bootUow, registerUowConnection, rows, UowOrder, UowOrderItem, UowOrderTag, UowTag } from './uowFixture.js';
import { SdOwner } from './models/sd/SdOwner.js';
import { SdItem } from './models/sd/SdItem.js';
import './migrations/SdMigration_2026_08_03_00_00_00.js';
import { UkItem, UkOrder, UkOrderTag, UkTag } from './models/uk/UkModels.js';
import './migrations/UkMigration_2026_11_23_00_00_00.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const statements = { recording: false, seen: [] as string[], origins: [] as string[] };

function verbOf(query: QueryBuilder): string {
  if (query instanceof SelectQueryBuilder) return 'select';
  if (query instanceof InsertQueryBuilder) return 'insert';
  if (query instanceof UpdateQueryBuilder) return 'update';
  return query instanceof DeleteQueryBuilder ? 'delete' : query.constructor.name;
}

function statementOf(query: object): string {
  return query instanceof QueryBuilder ? `${verbOf(query)} ${query.Model?.name ?? 'no model'}` : 'not a builder';
}

function originOf(query: object): string {
  const origin = relationSyncOf(query);
  return origin ? `${origin.owner.name}.${origin.relation}` : 'none';
}

/** Every statement a write runs, with the model it was built on and what `relationSyncOf` answers for it. */
class StatementRecorder extends QueryMiddleware {
  afterQueryCreation(): void {}

  beforeQueryExecution(query: QueryBuilder): void {
    if (!statements.recording) return;
    statements.seen.push(statementOf(query));
    statements.origins.push(`${statementOf(query)}: ${originOf(query)}`);
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
        const saved = Object.keys(marker).map((key) => [key, Object.getOwnPropertyDescriptor(descriptor, key)] as const);
        Object.assign(descriptor, marker);
        try {
          await order.Tags.sync();
        } finally {
          for (const [key, property] of saved) {
            if (property) Object.defineProperty(descriptor, key, property);
            else Reflect.deleteProperty(descriptor, key);
          }
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

  describe('junction rows that update() and sync() write', () => {
    interface LinkRow {
      Id: number;
      order_id: number;
      tag_id: number;
      Note: string | null;
    }

    async function orderWithGreen() {
      await seededOrder();
      await UowTag.insert({ Name: 'green' }); // 3
      const order = await UowOrder.where({ Id: 1 }).populate('Tags').first();
      const green = await UowTag.where({ Id: 3 }).first();
      return { order, green };
    }

    const linkOf = async (tagId: number) => (await rows<LinkRow>('uow_order_tag')).find((l) => l.tag_id === tagId);

    it('writes the columns given as plain data, and the list keeps the written junction model clean', async () => {
      const { order, green } = await orderWithGreen();
      order.Tags.add(green, { Note: 'from data' });

      await order.Tags.update();

      const link = await linkOf(3);
      expect(link).to.deep.include({ order_id: 1, tag_id: 3, Note: 'from data' });
      const junction = order.Tags.junction<UowOrderTag>(green)!;
      expect([junction.Id, junction.order_id, junction.tag_id, junction.Note]).to.deep.eq([link!.Id, 1, 3, 'from data']);
      expect(junction.IsDirty).to.eq(false);
    });

    it('writes the columns of a given junction model and keeps that instance', async () => {
      const { order, green } = await orderWithGreen();
      const given = new UowOrderTag({ Note: 'from model' });
      order.Tags.add(green, given);

      await order.Tags.sync();

      const link = await linkOf(3);
      expect(link).to.deep.include({ order_id: 1, tag_id: 3, Note: 'from model' });
      expect(order.Tags.junction(green)).to.eq(given);
      expect([given.Id, given.order_id, given.tag_id]).to.deep.eq([link!.Id, 1, 3]);
      expect(given.IsDirty).to.eq(false);
    });

    async function withNoteDefault<T>(fn: () => Promise<T>): Promise<T> {
      const note = extractModelDescriptor(UowOrderTag)!.Columns.find((c) => c.Name === 'Note')!;
      const previous = note.DefaultValue;
      note.DefaultValue = 'default note';
      try {
        return await fn();
      } finally {
        note.DefaultValue = previous;
      }
    }

    for (const write of ['update', 'sync'] as const) {
      it(`writes what a new junction model is constructed with for a member added without junction data through ${write}(), and holds none for it`, async () => {
        const { order, green } = await orderWithGreen();
        order.Tags.push(green);

        await withNoteDefault(() => order.Tags[write]());

        expect(await linkOf(3)).to.deep.include({ order_id: 1, tag_id: 3, Note: 'default note' });
        expect(order.Tags.junction(green)).to.eq(undefined);
      });
    }

    it('writes the two keys alone for a member added without junction data through save()', async () => {
      const { order, green } = await orderWithGreen();
      order.Tags.push(green);

      await withNoteDefault(() => order.save());

      expect(await linkOf(3)).to.deep.include({ order_id: 1, tag_id: 3, Note: null });
    });

    it('writes nothing for the same member on a second sync()', async () => {
      const { order, green } = await orderWithGreen();
      order.Tags.add(green, { Note: 'once' });

      await order.Tags.sync();
      const first = await rows<LinkRow>('uow_order_tag');
      await order.Tags.sync();
      await order.Tags.update();

      expect(await rows<LinkRow>('uow_order_tag')).to.deep.eq(first);
      expect(first.filter((l) => l.tag_id === 3)).to.have.length(1);
    });
  });

  describe('statements of sync() and update()', () => {
    before(() => DI.register(StatementRecorder).as(QueryMiddleware));
    after(() => DI.unregister(StatementRecorder));

    async function recorded(write: () => Promise<void>): Promise<string[]> {
      statements.recording = true;
      statements.seen = [];
      statements.origins = [];
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

    it('names the relation and the owner of every statement that sync() and update() build themselves', async () => {
      await seededOrder();
      await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
      const order = await UowOrder.where({ Id: 1 }).populate('Items').populate('Tags').first();

      order.Items.remove((i) => i.Sku === 'A');
      order.Items.push(new UowOrderItem({ Sku: 'B', Qty: 2 }));
      await recorded(() => order.Items.sync());
      expect(statements.origins).to.deep.eq(['insert UowOrderItem: none', 'delete UowOrderItem: UowOrder.Items']);

      order.Tags.remove((t) => t.Name === 'blue');
      order.Tags.push(new UowTag({ Name: 'green' }));
      await recorded(() => order.Tags.sync());
      expect(statements.origins).to.deep.eq(['select UowOrderTag: UowOrder.Tags', 'insert UowTag: none', 'insert UowOrderTag: none', 'delete UowOrderTag: UowOrder.Tags']);

      await recorded(() => order.Tags.update());
      expect(statements.origins).to.deep.eq(['select UowOrderTag: UowOrder.Tags']);

      await recorded(async () => {
        await UowOrder.where({ Id: 1 });
      });
      expect(statements.origins).to.deep.eq(['select UowOrder: none']);
    });

    it('names the relation and the owner of the soft-delete stamp of a one-to-many sync()', async () => {
      await SdOwner.insert({ Name: 'owner' });
      await SdItem.insert({ owner_id: 1, Val: 'a' });
      const owner = await SdOwner.where({ Id: 1 }).populate('Items').first();
      owner.Items.empty();

      await recorded(() => owner.Items.sync());
      expect(statements.origins).to.deep.eq(['update SdItem: SdOwner.Items']);
    });
  });

  describe('the callback of sync()', () => {
    it('receives the orphan delete of a one-to-many sync(), already named by relationSyncOf, and not its inserts', async () => {
      await UowOrder.insert({ Total: 10 });
      await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
      await UowOrderItem.insert({ Sku: 'B', Qty: 2, order_id: 1 });
      const order = await UowOrder.where({ Id: 1 }).populate('Items').first();
      order.Items.remove((i) => i.Sku === 'B');
      order.Items.push(new UowOrderItem({ Sku: 'C', Qty: 3 }));

      const received: Array<[string, ReturnType<typeof relationSyncOf>]> = [];
      await order.Items.sync(function () {
        received.push([statementOf(this), relationSyncOf(this)]);
      });

      expect(received).to.deep.eq([['delete UowOrderItem', { relation: 'Items', owner: UowOrder }]]);
    });

    it('receives the soft-delete stamp of a one-to-many sync() when the target is @SoftDelete', async () => {
      await SdOwner.insert({ Name: 'owner' });
      await SdItem.insert({ owner_id: 1, Val: 'a' });
      const owner = await SdOwner.where({ Id: 1 }).populate('Items').first();
      owner.Items.empty();
      owner.Items.push(new SdItem({ Val: 'b' }));

      const received: string[] = [];
      await owner.Items.sync(function () {
        received.push(statementOf(this));
      });

      expect(received).to.deep.eq(['update SdItem']);
    });

    it('receives the junction orphan delete of a many-to-many sync(), and not the link select or an insert', async () => {
      await seededOrder();
      const order = await UowOrder.where({ Id: 1 }).populate('Tags').first();
      order.Tags.remove((t) => t.Name === 'blue');
      order.Tags.push(new UowTag({ Name: 'green' }));

      const received: string[] = [];
      await order.Tags.sync(function () {
        received.push(statementOf(this));
      });

      expect(received).to.deep.eq(['delete UowOrderTag']);
    });

    it('narrows the statement by the condition the callback adds', async () => {
      await seededOrder();
      for (const Sku of ['A', 'B', 'C']) await UowOrderItem.insert({ Sku, Qty: 1, order_id: 1 });
      const order = await UowOrder.where({ Id: 1 }).populate('Items').populate('Tags').first();

      order.Items.set((items) => items.filter((i) => i.Sku === 'A'));
      await order.Items.sync(function () {
        this.where('Sku', '<>', 'C');
      });
      expect((await rows<{ Sku: string }>('uow_order_item')).map((r) => r.Sku)).to.deep.eq(['A', 'C']);

      order.Tags.empty();
      await order.Tags.sync(function () {
        this.where('tag_id', 2);
      });
      expect((await rows<{ tag_id: number }>('uow_order_tag')).map((l) => l.tag_id)).to.deep.eq([1]);
    });

    it('rejects sync() when the callback throws, and writes nothing', async () => {
      await seededOrder();
      await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
      const order = await UowOrder.where({ Id: 1 }).populate('Items').populate('Tags').first();
      const refuse = () => {
        throw new Error('refused by the callback');
      };

      order.Items.empty();
      order.Items.push(new UowOrderItem({ Sku: 'B', Qty: 2 }));
      await expect(order.Items.sync(refuse)).to.be.rejectedWith('refused by the callback');
      expect((await rows<{ Sku: string }>('uow_order_item')).map((r) => r.Sku)).to.deep.eq(['A']);

      order.Tags.remove((t) => t.Name === 'blue');
      order.Tags.push(new UowTag({ Name: 'green' }));
      await expect(order.Tags.sync(refuse)).to.be.rejectedWith('refused by the callback');
      expect((await rows<{ Name: string }>('uow_tag')).map((t) => t.Name)).to.deep.eq(['red', 'blue']);
      expect((await rows<{ tag_id: number }>('uow_order_tag')).map((l) => l.tag_id)).to.deep.eq([1, 2]);
    });
  });

  describe('sync() of keys that pass a column converter', () => {
    const [a, b, c] = ['0a5e3c1e-6b1f-4c2a-9d3e-000000000001', '0a5e3c1e-6b1f-4c2a-9d3e-000000000002', '0a5e3c1e-6b1f-4c2a-9d3e-000000000003'];
    const keyOf = (key: unknown) => extractModelDescriptor(UkTag)!.Columns.find((col) => col.Name === 'Id')!.Converter!.fromDB(key, {}, undefined) as string;

    async function seededUkOrder() {
      await UkOrder.insert({ Name: 'order' });
      for (const [Id, Name] of [[a, 'a'], [b, 'b'], [c, 'c']]) {
        await UkTag.insert({ Id, Name });
        await UkOrderTag.insert({ order_id: 1, tag_id: Id });
        await UkItem.insert({ Id, Name, order_id: 1 });
      }
    }

    it('keeps the members of a many-to-many sync(), deletes the orphans and links each member once', async () => {
      await seededUkOrder();
      // Not populated, so the list holds no junction rows of its own and relies on the select of existing links.
      const order = await UkOrder.where({ Id: 1 }).first();
      order.Tags.push(...(await UkTag.query().whereIn('Name', ['a', 'b'])));
      const links = async () => (await rows<{ Id: number; tag_id: Buffer }>('uk_order_tag')).map((l) => [l.Id, Buffer.isBuffer(l.tag_id) ? keyOf(l.tag_id) : `not bytes: ${String(l.tag_id)}`]);

      await order.Tags.sync();
      expect(await links(), 'sync()').to.deep.eq([[1, a], [2, b]]);

      await order.Tags.sync();
      await order.Tags.update();
      expect(await links(), 'sync() and update() again').to.deep.eq([[1, a], [2, b]]);
    });

    it('keeps the members of a one-to-many sync() and deletes the orphans', async () => {
      await seededUkOrder();
      const order = await UkOrder.where({ Id: 1 }).populate('Items').first();
      order.Items.remove((i) => i.Name === 'c');

      for (const run of ['first', 'second']) {
        await order.Items.sync();
        const items = await rows<{ Id: Buffer }>('uk_item');
        expect(items.map((i) => keyOf(i.Id)).sort(), run).to.deep.eq([a, b]);
      }
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
