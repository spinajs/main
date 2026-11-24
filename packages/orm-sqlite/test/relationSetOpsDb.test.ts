/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { DeleteQueryBuilder, InsertQueryBuilder, OrmException, QueryBuilder, QueryMiddleware, SelectQueryBuilder, SortOrder, UpdateQueryBuilder, WhereBoolean, extractModelDescriptor, relationSyncOf } from '@spinajs/orm';
import type { IModelDescriptor, IRelationSyncStatement } from '@spinajs/orm';
import { bootUow, captureStatements, registerUowConnection, rows, UowOrder, UowOrderItem, UowOrderTag, UowTag } from './uowFixture.js';
import { SdOwner } from './models/sd/SdOwner.js';
import { SdItem } from './models/sd/SdItem.js';
import './migrations/SdMigration_2026_08_03_00_00_00.js';
import { UkItem, UkOrder, UkOrderTag, UkTag } from './models/uk/UkModels.js';
import './migrations/UkMigration_2026_11_23_00_00_00.js';
import { SfFriendship, SfPerson } from './models/sf/SfModels.js';
import './migrations/SfMigration_2026_11_24_00_00_00.js';

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

/** Statements a sync() callback marked, as another package marks them, and the ones that ran with the mark. */
const marks = { marked: new WeakSet<object>(), seen: [] as string[] };

class MarkReader extends QueryMiddleware {
  afterQueryCreation(): void {}

  beforeQueryExecution(query: QueryBuilder): void {
    if (marks.marked.has(query)) marks.seen.push(statementOf(query));
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

    /** Runs `fn` with the junction descriptor changed as `patch` says, restored afterwards. */
    async function withJunctionDescriptor<T>(patch: (descriptor: IModelDescriptor) => () => void, fn: () => Promise<T>): Promise<T> {
      const restore = patch(extractModelDescriptor(UowOrderTag)!);
      try {
        return await fn();
      } finally {
        restore();
      }
    }

    const versionedOnNote = (descriptor: IModelDescriptor) => {
      descriptor.VersionColumn = 'Note';
      return () => Reflect.deleteProperty(descriptor, 'VersionColumn');
    };

    const assignedKey = (descriptor: IModelDescriptor) => {
      const previous = descriptor.PrimaryKeyGeneration;
      descriptor.PrimaryKeyGeneration = new Map([['Id', 'assigned' as const]]);
      return () => {
        descriptor.PrimaryKeyGeneration = previous;
      };
    };

    it('starts the version of a @Version junction model given as data, on the row and on the model the list holds', async () => {
      const { order, green } = await orderWithGreen();
      order.Tags.add(green, {});

      await withJunctionDescriptor(versionedOnNote, () => order.Tags.update());

      // Note has text affinity in SQLite, so the version reads back as text.
      expect((await linkOf(3))!.Note).to.eq('1');
      expect(order.Tags.junction<UowOrderTag>(green)!.Note).to.eq(1);
    });

    it('starts the version of a @Version junction model on the row of a member added without junction data', async () => {
      const { order, green } = await orderWithGreen();
      order.Tags.push(green);

      await withJunctionDescriptor(versionedOnNote, () => order.Tags.sync());

      expect((await linkOf(3))!.Note).to.eq('1');
    });

    it('refuses a given junction model with an assigned key and no value before the database', async () => {
      const { order, green } = await orderWithGreen();
      order.Tags.add(green, { Note: 'given' });

      await expect(withJunctionDescriptor(assignedKey, () => order.Tags.update())).to.be.rejectedWith(OrmException, 'must be assigned before insert');
      expect(await linkOf(3)).to.eq(undefined);
    });

    it('refuses an assigned junction key for a member added without junction data before the database', async () => {
      const { order, green } = await orderWithGreen();
      order.Tags.push(green);

      await expect(withJunctionDescriptor(assignedKey, () => order.Tags.update())).to.be.rejectedWith(OrmException, 'must be assigned before insert');
      expect(await linkOf(3)).to.eq(undefined);
    });

    it('puts the version of a given @Version junction model back when its insert is rejected', async () => {
      const { order, green } = await orderWithGreen();
      // An assigned key the table already holds, so the database rejects the insert.
      order.Tags.add(green, { Id: 1 });
      const junction = order.Tags.junction<UowOrderTag>(green)!;
      const before = junction.Note;

      const versionedWithAssignedKey = (descriptor: IModelDescriptor) => {
        const restoreVersion = versionedOnNote(descriptor);
        const restoreKey = assignedKey(descriptor);
        return () => {
          restoreKey();
          restoreVersion();
        };
      };
      await expect(withJunctionDescriptor(versionedWithAssignedKey, () => order.Tags.update())).to.be.rejectedWith(/UNIQUE constraint failed/);

      expect(junction.Note).to.eq(before);
      expect(await linkOf(3)).to.eq(undefined);
    });

    it('points the relations the junction model declares at the owner and the member', async () => {
      const { order, green } = await orderWithGreen();
      order.Tags.add(green, { Note: 'linked' });

      await order.Tags.update();

      const junction = order.Tags.junction<UowOrderTag>(green)!;
      expect(junction.Order.Value).to.eq(order);
      expect(junction.Tag.Value).to.eq(green);
      expect(junction.IsDirty).to.eq(false);
    });

    describe('on a self-referencing junction model with a third relation', () => {
      async function people() {
        for (const Name of ['ann', 'bob', 'cid']) await SfPerson.insert({ Name });
        const [ann, bob, cid] = await SfPerson.select().whereIn('Id', [1, 2, 3]).order('Id', SortOrder.ASC);
        return { ann, bob, cid };
      }

      for (const write of ['update', 'sync'] as const) {
        it(`points each side by its column, copies every relation key back, and leaves the junction clean through ${write}()`, async () => {
          const { ann, bob, cid } = await people();
          const given = new SfFriendship();
          given.Approver.Value = cid;
          ann.Friends.add(bob, given);

          await ann.Friends[write]();

          expect(await rows('sf_friendship')).to.deep.eq([{ Id: 1, person_id: 1, friend_id: 2, approver_id: 3 }]);
          expect(given.Person.Value).to.eq(ann);
          expect(given.Friend.Value).to.eq(bob);
          expect([given.person_id, given.friend_id, given.approver_id]).to.deep.eq([1, 2, 3]);
          expect(given.IsDirty).to.eq(false);
          expect((await given.update()).RowsAffected).to.eq(0);
        });
      }
    });

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

  describe('the conditions of a sync() callback', () => {
    before(() => DI.register(MarkReader).as(QueryMiddleware));
    after(() => DI.unregister(MarkReader));

    /** The compiled statements of `write` that start with `verb`. */
    async function compiled(verb: string, write: () => Promise<void>): Promise<string[]> {
      const capture = captureStatements();
      try {
        await write();
      } finally {
        capture.restore();
      }
      return capture.statements.filter((s) => s.expression.startsWith(verb)).map((s) => s.expression);
    }

    /** Order 1 has items A and B, order 2 has X and Y; B and X share `Qty` 9. Order 1 drops B. */
    async function twoOrders() {
      await UowOrder.insert({ Total: 10 });
      await UowOrder.insert({ Total: 20 });
      for (const [Sku, Qty, order_id] of [['A', 1, 1], ['B', 9, 1], ['X', 9, 2], ['Y', 1, 2]] as const) await UowOrderItem.insert({ Sku, Qty, order_id });
      const order = await UowOrder.where({ Id: 1 }).populate('Items').first();
      order.Items.remove((i) => i.Sku === 'B');
      return order;
    }

    const items = async () => (await rows<{ Sku: string; order_id: number }>('uow_order_item')).map((r) => `${r.order_id}:${r.Sku}`);

    it('keeps an orWhere of a one-to-many orphan delete inside the owner', async () => {
      const order = await twoOrders();

      const sql = await compiled('DELETE', () =>
        order.Items.sync(function () {
          this.orWhere('Qty', 9);
        }),
      );

      expect(sql).to.deep.eq(['DELETE FROM `uow_order_item` WHERE `order_id` = ? AND `Id` NOT IN (?) AND ( `Qty` = ? )']);
      expect(await items()).to.deep.eq(['1:A', '2:X', '2:Y']);
    });

    it('groups a where followed by an orWhere, inside the owner', async () => {
      const order = await twoOrders();

      const sql = await compiled('DELETE', () =>
        order.Items.sync(function () {
          this.where('Sku', 'B').orWhere('Qty', 9);
        }),
      );

      expect(sql).to.deep.eq(['DELETE FROM `uow_order_item` WHERE `order_id` = ? AND `Id` NOT IN (?) AND ( `Sku` = ? OR `Qty` = ? )']);
      expect(await items()).to.deep.eq(['1:A', '2:X', '2:Y']);
    });

    it('keeps an orWhere of the soft-delete stamp inside the owner', async () => {
      await SdOwner.insert({ Name: 'one' });
      await SdOwner.insert({ Name: 'two' });
      for (const [Val, owner_id] of [['a', 1], ['b', 1], ['x', 2], ['y', 2]] as const) await SdItem.insert({ Val, owner_id });
      const owner = await SdOwner.where({ Id: 1 }).populate('Items').first();
      owner.Items.remove((i) => i.Val === 'b');

      const sql = await compiled('UPDATE', () =>
        owner.Items.sync(function () {
          this.where('Val', 'b').orWhere('Val', 'x');
        }),
      );

      expect(sql).to.deep.eq(['UPDATE `sd_item` SET `DeletedAt` = ? WHERE `owner_id` = ? AND `DeletedAt` IS NULL AND `Id` NOT IN (?) AND ( `Val` = ? OR `Val` = ? )']);
      const stamped = (await rows<{ Val: string; owner_id: number; DeletedAt: string | null }>('sd_item')).filter((r) => r.DeletedAt !== null).map((r) => `${r.owner_id}:${r.Val}`);
      expect(stamped).to.deep.eq(['1:b']);
    });

    it('keeps an orWhere of a many-to-many junction delete inside the owner', async () => {
      await seededOrder();
      await UowOrder.insert({ Total: 20 });
      await UowOrderTag.insert({ order_id: 2, tag_id: 1 });
      await UowOrderTag.insert({ order_id: 2, tag_id: 2 });
      const order = await UowOrder.where({ Id: 1 }).populate('Tags').first();
      order.Tags.remove((t) => t.Name === 'blue');

      const sql = await compiled('DELETE', () =>
        order.Tags.sync(function () {
          this.orWhere('tag_id', 2);
        }),
      );

      expect(sql).to.deep.eq(['DELETE FROM `uow_order_tag` WHERE `order_id` = ? AND `tag_id` NOT IN (?) AND ( `tag_id` = ? )']);
      expect((await rows<{ order_id: number; tag_id: number }>('uow_order_tag')).map((l) => `${l.order_id}:${l.tag_id}`)).to.deep.eq(['1:1', '2:1', '2:2']);
    });

    it('compiles the orphan delete as before when the callback adds no condition, or there is no callback', async () => {
      const today = ['DELETE FROM `uow_order_item` WHERE `order_id` = ? AND `Id` NOT IN (?)'];
      const order = await twoOrders();

      expect(await compiled('DELETE', () => order.Items.sync()), 'no callback').to.deep.eq(today);
      expect(await compiled('DELETE', () => order.Items.sync(function () {})), 'an empty callback').to.deep.eq(today);
      expect(
        await compiled('DELETE', () =>
          order.Items.sync(function () {
            this.where(function () {});
          }),
        ),
        'an empty group',
      ).to.deep.eq(today);
      expect(await items()).to.deep.eq(['1:A', '2:X', '2:Y']);
    });

    it('runs the statement the callback marked, with no condition added', async () => {
      const order = await twoOrders();
      marks.seen = [];

      const sql = await compiled('DELETE', () =>
        order.Items.sync(function () {
          marks.marked.add(this);
        }),
      );

      expect(marks.seen).to.deep.eq(['delete UowOrderItem']);
      expect(sql).to.deep.eq(['DELETE FROM `uow_order_item` WHERE `order_id` = ? AND `Id` NOT IN (?)']);
      expect(await items()).to.deep.eq(['1:A', '2:X', '2:Y']);
    });

    it('keeps the owner key and the keep list when the callback removes the statements it was handed', async () => {
      const order = await twoOrders();
      const grouped = ['DELETE FROM `uow_order_item` WHERE `order_id` = ? AND `Id` NOT IN (?) AND ( `Qty` = ? )'];

      const spliced = await compiled('DELETE', () =>
        order.Items.sync(function () {
          this.Statements.splice(0).reverse().forEach((s) => this.Statements.push(s));
          this.Statements.splice(0, 1);
          this.orWhere('Qty', 9);
        }),
      );
      expect(spliced, 'reordered and spliced').to.deep.eq(grouped);
      expect(await items()).to.deep.eq(['1:A', '2:X', '2:Y']);

      const cleared = await compiled('DELETE', () =>
        order.Items.sync(function () {
          this.clearWhere().orWhere('Qty', 9);
        }),
      );
      expect(cleared, 'clearWhere()').to.deep.eq(grouped);
      expect(await items()).to.deep.eq(['1:A', '2:X', '2:Y']);

      const reconnected = await compiled('DELETE', () =>
        order.Items.sync(function () {
          this.Statements[1].Boolean = WhereBoolean.OR;
          this.orWhere('Qty', 9);
        }),
      );
      expect(reconnected, 'the keep list joined by OR').to.deep.eq(grouped);
      expect(await items()).to.deep.eq(['1:A', '2:X', '2:Y']);
    });

    it('groups the conditions of a callback that returns the statement, which is a thenable but not a promise', async () => {
      const order = await twoOrders();

      const sql = await compiled('DELETE', () =>
        order.Items.sync(function () {
          return this.where('Sku', 'B').orWhere('Qty', 9);
        }),
      );

      expect(sql).to.deep.eq(['DELETE FROM `uow_order_item` WHERE `order_id` = ? AND `Id` NOT IN (?) AND ( `Sku` = ? OR `Qty` = ? )']);
      expect(await items()).to.deep.eq(['1:A', '2:X', '2:Y']);
    });

    describe('an async callback', () => {
      const refused = 'the sync() callback must be synchronous: it returned a promise, and conditions added after an await would not be confined to the owner';
      const unhandled: unknown[] = [];
      const record = (reason: unknown) => unhandled.push(reason);
      before(() => process.on('unhandledRejection', record));
      after(() => process.off('unhandledRejection', record));
      beforeEach(() => (unhandled.length = 0));

      // The compiler accepts an async callback for a `void` return, and lint's no-misused-promises refuses it; this is
      // what a caller lint does not see passes (JavaScript, an `any`).
      const unchecked = (callback: (this: IRelationSyncStatement) => unknown): ((this: IRelationSyncStatement) => void) => callback;

      it('is refused before the orphan delete runs, and the one-to-many sync() changes no row of either owner', async () => {
        const order = await twoOrders();
        order.Items.push(new UowOrderItem({ Sku: 'C', Qty: 3 }));

        const sql = await compiled('DELETE', async () => {
          const err = await order.Items.sync(
            unchecked(async function () {
              await Promise.resolve();
              this.orWhere('Qty', 9);
            }),
          ).catch((e: unknown) => e);
          expect(err).to.be.instanceOf(OrmException).with.property('message', refused);
        });

        expect(sql, 'no delete runs').to.deep.eq([]);
        expect(await items(), 'the insert of C rolls back').to.deep.eq(['1:A', '1:B', '2:X', '2:Y']);
      });

      it('is refused when its own promise rejects, without an unhandled rejection', async () => {
        const order = await twoOrders();

        await expect(
          order.Items.sync(
            unchecked(async function () {
              await Promise.resolve();
              throw new Error('the callback failed');
            }),
          ),
        ).to.be.rejectedWith(OrmException, refused);
        await new Promise((resolve) => setImmediate(resolve));

        expect(unhandled).to.deep.eq([]);
        expect(await items()).to.deep.eq(['1:A', '1:B', '2:X', '2:Y']);
      });

      it('is refused by the soft-delete stamp and the many-to-many junction delete, which change nothing', async () => {
        const late = unchecked(async function () {
          await Promise.resolve();
          this.orWhere('Id', '>', 0);
        });

        await SdOwner.insert({ Name: 'one' });
        await SdOwner.insert({ Name: 'two' });
        for (const [Val, owner_id] of [['a', 1], ['b', 1], ['x', 2]] as const) await SdItem.insert({ Val, owner_id });
        const owner = await SdOwner.where({ Id: 1 }).populate('Items').first();
        owner.Items.remove((i) => i.Val === 'b');
        await expect(owner.Items.sync(late)).to.be.rejectedWith(OrmException, refused);
        expect((await rows<{ DeletedAt: string | null }>('sd_item')).filter((r) => r.DeletedAt !== null), 'no row stamped').to.deep.eq([]);

        await seededOrder();
        await UowOrder.insert({ Total: 20 });
        await UowOrderTag.insert({ order_id: 2, tag_id: 1 });
        const order = await UowOrder.where({ Id: 1 }).populate('Tags').first();
        order.Tags.remove((t) => t.Name === 'blue');
        order.Tags.push(new UowTag({ Name: 'green' }));
        await expect(order.Tags.sync(late)).to.be.rejectedWith(OrmException, refused);
        expect((await rows<{ order_id: number; tag_id: number }>('uow_order_tag')).map((l) => `${l.order_id}:${l.tag_id}`)).to.deep.eq(['1:1', '1:2', '2:1']);
        expect((await rows<{ Name: string }>('uow_tag')).map((t) => t.Name), 'the insert of green rolls back').to.deep.eq(['red', 'blue']);
      });
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
