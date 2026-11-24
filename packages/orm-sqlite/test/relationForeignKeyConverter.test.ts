import { DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import { extractModelDescriptor, InsertBehaviour } from '@spinajs/orm';
import { bootUow, registerUowConnection, rows } from './uowFixture.js';
import { UkGenNote, UkGenTag, UkNote, UkOrder, UkOrderTag, UkTag } from './models/uk/UkModels.js';
import './migrations/UkMigration_2026_11_23_00_00_00.js';

const expect = chai.expect;

// UkOrderTag.tag_id and UkNote.tag_id are @Uuid(): the database holds 16 bytes, the model the dashed text.
describe('foreign keys written from a relation pass the column converter', function () {
  this.timeout(10000);

  const [a, b, c] = ['0a5e3c1e-6b1f-4c2a-9d3e-000000000001', '0a5e3c1e-6b1f-4c2a-9d3e-000000000002', '0a5e3c1e-6b1f-4c2a-9d3e-000000000003'];
  const textOf = (key: unknown) => extractModelDescriptor(UkTag)!.Columns.find((col) => col.Name === 'Id')!.Converter!.fromDB(key, {}, undefined) as string;

  /** [Id, tag] of every junction row, failing on a tag_id the converter did not write. */
  async function links(): Promise<Array<[number, string]>> {
    const stored = await rows<{ Id: number; tag_id: unknown }>('uk_order_tag');
    for (const row of stored) {
      expect(Buffer.isBuffer(row.tag_id), `tag_id of junction row ${row.Id}`).to.be.true;
    }
    return stored.map((row) => [row.Id, textOf(row.tag_id)]);
  }

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
    await UkOrder.insert({ Name: 'order' });
    for (const [Id, Name] of [[a, 'a'], [b, 'b'], [c, 'c']]) {
      await UkTag.insert({ Id, Name });
    }
    await UkOrderTag.insert({ order_id: 1, tag_id: a });
  });
  afterEach(() => DI.clearCache());

  describe('many-to-many', () => {
    it('sync() keeps the existing link and writes the new one in the same form', async () => {
      const order = await UkOrder.where({ Id: 1 }).first();
      order.Tags.push(...(await UkTag.query().whereIn('Name', ['a', 'b'])));

      await order.Tags.sync();
      expect(await links()).to.deep.eq([[1, a], [2, b]]);

      await order.Tags.sync();
      expect(await links(), 'second sync()').to.deep.eq([[1, a], [2, b]]);
    });

    it('update() writes the link of a new member in the same form as the existing ones', async () => {
      const order = await UkOrder.where({ Id: 1 }).first();
      order.Tags.push(...(await UkTag.query().whereIn('Name', ['a', 'c'])));

      await order.Tags.update();
      await order.Tags.update();

      expect(await links()).to.deep.eq([[1, a], [2, c]]);
    });

    it('save() writes the link of a new member in the same form as the existing ones', async () => {
      const order = await UkOrder.where({ Id: 1 }).populate('Tags').first();
      order.Tags.push(await UkTag.where({ Id: b }).first());

      await order.save();

      expect(await links()).to.deep.eq([[1, a], [2, b]]);
    });

    it('save() of an owner keyed by the converted column writes the junction source key in the same form', async () => {
      const tag = await UkTag.where({ Id: c }).populate('Orders').first();
      tag.Orders.push(await UkOrder.where({ Id: 1 }).first());

      await tag.save();

      expect(await links()).to.deep.eq([[1, a], [2, c]]);
    });
  });

  describe('belongsTo', () => {
    async function storedNoteKeys(): Promise<unknown[]> {
      return (await rows<{ tag_id: unknown }>('uk_note')).map((row) => row.tag_id);
    }

    async function expectFoundThroughKey(): Promise<void> {
      expect((await UkNote.where('tag_id', b)).map((n) => n.Text), 'where on the key').to.deep.eq(['note']);

      const tag = await UkTag.where({ Id: b }).first();
      await tag.Notes.populate();
      expect(tag.Notes.map((n) => n.Text), 'populate() of the parent').to.deep.eq(['note']);
    }

    it('insert() of a child with its parent set through the relation stores the key in the converted form', async () => {
      const note = new UkNote({ Text: 'note' });
      note.Tag.attach(await UkTag.where({ Id: b }).first());

      await note.insert();

      const [key] = await storedNoteKeys();
      expect(Buffer.isBuffer(key)).to.be.true;
      expect(textOf(key)).to.eq(b);
      await expectFoundThroughKey();
    });

    it('update() of a child moved to another parent through the relation stores the key in the converted form', async () => {
      const note = new UkNote({ Text: 'note' });
      note.Tag.attach(await UkTag.where({ Id: a }).first());
      await note.insert();

      note.Tag.attach(await UkTag.where({ Id: b }).first());
      await note.update();

      const [key] = await storedNoteKeys();
      expect(Buffer.isBuffer(key)).to.be.true;
      expect(textOf(key)).to.eq(b);
      await expectFoundThroughKey();
    });

    it('save() of a parent with a new child stores the key in the converted form', async () => {
      const tag = await UkTag.where({ Id: b }).populate('Notes').first();
      tag.Notes.push(new UkNote({ Text: 'note' }));

      await tag.save();

      const [key] = await storedNoteKeys();
      expect(Buffer.isBuffer(key)).to.be.true;
      expect(textOf(key)).to.eq(b);
      await expectFoundThroughKey();
    });

    it('a one-to-many sync() of the parent stores the key of a new child in the converted form', async () => {
      const tag = await UkTag.where({ Id: b }).populate('Notes').first();
      tag.Notes.push(new UkNote({ Text: 'note' }));

      await tag.Notes.sync();

      const [key] = await storedNoteKeys();
      expect(Buffer.isBuffer(key)).to.be.true;
      expect(textOf(key)).to.eq(b);
      await expectFoundThroughKey();
    });
  });

  describe('a key already in the database form', () => {
    it('insert() of a child whose relation-managed key is assigned as bytes writes those bytes', async () => {
      const tagRow = (await rows<{ Id: Buffer }>('uk_tag')).find((row) => textOf(row.Id) === b)!;
      const note = Object.assign(new UkNote({ Text: 'note' }), { tag_id: tagRow.Id });

      await note.insert();

      const [stored] = await rows<{ tag_id: unknown }>('uk_note');
      expect(stored.tag_id).to.deep.eq(tagRow.Id);
      expect((await UkNote.where('tag_id', b)).map((n) => n.Text)).to.deep.eq(['note']);
    });

    it('save() of a parent whose key the database generates writes the key of its new child as the same bytes', async () => {
      const tag = new UkGenTag({ Name: 'generated' });
      const note = new UkGenNote({ Text: 'note' });
      tag.Notes.push(note);

      await tag.save();

      const [tagRow] = await rows<{ Id: unknown }>('uk_gen_tag');
      const [noteRow] = await rows<{ tag_id: unknown }>('uk_gen_note');
      expect(Buffer.isBuffer(tagRow.Id) && tagRow.Id.length, 'generated key').to.eq(16);
      expect(noteRow.tag_id).to.deep.eq(tagRow.Id);
      expect((await UkGenNote.where('tag_id', textOf(tagRow.Id))).map((n) => n.Text)).to.deep.eq(['note']);

      expect(tag.Id, 'the key on the saved model').to.eq((await UkGenTag.where('Name', 'generated').first()).Id);
      expect(note.tag_id, 'the foreign key on the saved child').to.eq(tag.Id);
      expect(tag.IsDirty || note.IsDirty, 'a change pending after save()').to.be.false;
      expect(await tag.save(), 'a second save()').to.include({ Inserted: 0, Updated: 0 });
    });
  });
});

describe('a key the database generates reaches the model in the model form', function () {
  this.timeout(10000);

  const freshKey = async (Name: string) => (await UkGenTag.where('Name', Name).first()).Id;

  before(() => registerUowConnection());
  beforeEach(() => bootUow());
  afterEach(() => DI.clearCache());

  it('insert() of one model', async () => {
    const tag = new UkGenTag({ Name: 'one' });

    await tag.insert();

    expect(tag.Id).to.eq(await freshKey('one'));
    expect(tag.IsDirty).to.be.false;
  });

  it('insert(InsertOrIgnore) of one model', async () => {
    const tag = new UkGenTag({ Name: 'one' });

    await tag.insert(InsertBehaviour.InsertOrIgnore);

    expect(tag.Id).to.eq(await freshKey('one'));
  });

  it('insert(InsertOrUpdate) of one model', async () => {
    const tag = new UkGenTag({ Name: 'one' });

    await tag.insert(InsertBehaviour.InsertOrUpdate);

    expect(tag.Id).to.eq(await freshKey('one'));
  });

  it('the static insert() of one model', async () => {
    const tag = new UkGenTag({ Name: 'one' });

    await UkGenTag.insert(tag);

    expect(tag.Id).to.eq(await freshKey('one'));
    expect(tag.IsDirty).to.be.false;
  });

  for (const behaviour of [InsertBehaviour.InsertOrIgnore, InsertBehaviour.InsertOrUpdate]) {
    it(`the static insert() of one model with ${InsertBehaviour[behaviour]}`, async () => {
      const tag = new UkGenTag({ Name: 'one' });

      await UkGenTag.insert(tag, behaviour);

      expect(tag.Id).to.eq(await freshKey('one'));
    });
  }

  it('the static insert() of several models', async () => {
    const tags = [new UkGenTag({ Name: 'one' }), new UkGenTag({ Name: 'two' })];

    await UkGenTag.insert(tags);

    expect(tags.map((t) => t.Id)).to.deep.eq([await freshKey('one'), await freshKey('two')]);
  });

  it('a key the caller supplied is written and kept as it is', async () => {
    const supplied = '0a5e3c1e-6b1f-4c2a-9d3e-0000000000aa';
    const tag = new UkGenTag({ Id: supplied, Name: 'one' });

    await tag.insert();

    expect(tag.Id).to.eq(supplied);
    expect(await freshKey('one')).to.eq(supplied);
  });
});
