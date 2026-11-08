import { DI } from '@spinajs/di';
import { ConcurrencyConflict } from '@spinajs/exceptions';
import { InvalidOperation } from '@spinajs/exceptions';
import { Archived, Connection, HasMany, InsertBehaviour, Model, ModelBase, OptimisticLockError, OrmDriver, Primary, QueryContext, Relation, SoftDelete, Version } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DateTime } from 'luxon';
import 'mocha';
import { db } from './common.js';
import { bootUow, captureStatements, registerUowConnection, rows } from './uowFixture.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

@Connection('sqlite')
@Model('ver_note')
class VerNote extends ModelBase {
  @Primary()
  public Id: number;

  public Body: string;

  public doc_id: number;

  @Version()
  public Revision: number;
}

@Connection('sqlite')
@Model('ver_doc')
class VerDoc extends ModelBase {
  @Primary()
  public Id: number;

  public Title: string;

  @Version()
  public Revision: number;

  @HasMany(VerNote, { foreignKey: 'doc_id', primaryKey: 'Id' })
  public Notes: Relation<VerNote, VerDoc>;
}

@Connection('sqlite')
@Model('ver_soft')
class VerSoft extends ModelBase {
  @Primary()
  public Id: number;

  public Title: string;

  @SoftDelete()
  public DeletedAt: DateTime;

  @Archived()
  public ArchivedAt: DateTime;

  @Version()
  public Revision: number;
}

function sqlite(): OrmDriver {
  return db().Connections.get('sqlite')!;
}

async function insertDoc(title = 'draft'): Promise<VerDoc> {
  const doc = new VerDoc({ Title: title });
  await doc.insert();
  return doc;
}

function load(id: number): Promise<VerDoc> {
  return VerDoc.where({ Id: id }).firstOrFail();
}

describe('@Version optimistic locking on sqlite', function () {
  this.timeout(20000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
    await sqlite()
      .schema()
      .createTable('ver_doc', (t) => {
        t.int('Id').primaryKey().autoIncrement();
        t.string('Title');
        t.int('Revision').notNull();
      });
    await sqlite()
      .schema()
      .createTable('ver_note', (t) => {
        t.int('Id').primaryKey().autoIncrement();
        t.string('Body');
        t.int('doc_id');
        t.int('Revision').notNull();
      });
    await sqlite()
      .schema()
      .createTable('ver_soft', (t) => {
        t.int('Id').primaryKey().autoIncrement();
        t.string('Title');
        t.dateTime('DeletedAt');
        t.dateTime('ArchivedAt');
        t.int('Revision').notNull();
      });
    await db().reloadTableInfo();
  });
  afterEach(() => DI.clearCache());

  it('starts a new row at version 1', async () => {
    const doc = await insertDoc();

    expect(doc.Revision).to.eq(1);
    expect((await load(doc.Id)).Revision).to.eq(1);
  });

  it('update() bumps the version and refuses a stale copy', async () => {
    const doc = await insertDoc();
    const a = await load(doc.Id);
    const b = await load(doc.Id);

    a.Title = 'from a';
    await a.update();
    expect(a.Revision).to.eq(2);

    b.Title = 'from b';
    const err = await b.update().then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).to.be.instanceOf(OptimisticLockError);
    expect(err).to.be.instanceOf(ConcurrencyConflict);
    expect((err as OptimisticLockError).model).to.eq('VerDoc');
    expect((err as OptimisticLockError).key).to.eq(doc.Id);
    expect((err as OptimisticLockError).expectedVersion).to.eq(1);
    const stored = await load(doc.Id);
    expect(stored.Title).to.eq('from a');
    expect(stored.Revision).to.eq(2);
  });

  it('destroy() refuses a stale copy and deletes a current one', async () => {
    const doc = await insertDoc();
    const a = await load(doc.Id);
    const b = await load(doc.Id);
    a.Title = 'changed';
    await a.update();

    await expect(b.destroy()).to.be.rejectedWith(OptimisticLockError);
    await a.destroy();

    expect(await VerDoc.where({ Id: doc.Id }).first()).to.eq(undefined);
  });

  it('the static Model.insert() starts rows at version 1, for models and plain objects, one or many', async () => {
    await VerDoc.insert([{ Title: 'seed 1' }, { Title: 'seed 2' }]);
    await VerDoc.insert(new VerDoc({ Title: 'seed 3' }));
    await VerDoc.insert({ Title: 'seed 4' });

    const stored = await VerDoc.select().order('Id');
    expect(stored.map((d) => d.Revision)).to.deep.equal([1, 1, 1, 1]);

    const loaded = await load(stored[0].Id);
    loaded.Title = 'edited';
    await loaded.update();
    expect(loaded.Revision).to.eq(2);
  });

  it('save() starts a new model at version 1, then bumps it and refuses a stale copy', async () => {
    const doc = new VerDoc({ Title: 'new' });
    await doc.save();
    expect(doc.Revision).to.eq(1);

    const a = await load(doc.Id);
    const b = await load(doc.Id);
    a.Title = 'from a';
    await a.save();
    expect(a.Revision).to.eq(2);

    b.Title = 'from b';
    await expect(b.save()).to.be.rejectedWith(OptimisticLockError);
  });

  it('rolls the whole saved graph back when one of its rows is stale', async () => {
    const doc = await insertDoc('v1');
    await sqlite().insert().into('ver_note').values({ Body: 'n1', doc_id: doc.Id, Revision: 1 });
    const graph = await VerDoc.where({ Id: doc.Id }).populate('Notes').firstOrFail();
    const elsewhere = await VerNote.where({ doc_id: doc.Id }).firstOrFail();
    elsewhere.Body = 'changed elsewhere';
    await elsewhere.update();

    graph.Title = 'v2';
    graph.Notes[0].Body = 'changed here';
    const capture = captureStatements();
    try {
      await expect(graph.save()).to.be.rejectedWith(OptimisticLockError);
    } finally {
      capture.restore();
    }

    expect(capture.statements.filter((s) => s.context === QueryContext.Update)).to.have.length(2);
    const stored = await load(doc.Id);
    expect(stored.Title).to.eq('v1');
    expect(stored.Revision).to.eq(1);
    expect((await VerNote.where({ doc_id: doc.Id }).firstOrFail()).Body).to.eq('changed elsewhere');
  });

  it('save({ reload: true }) keeps the version a copy was read at, so a stale copy is refused', async () => {
    const doc = await insertDoc();
    const a = await load(doc.Id);
    const b = await load(doc.Id);
    a.Title = 'from a';
    await a.update();

    b.Title = 'from b';
    await expect(b.save({ reload: true })).to.be.rejectedWith(OptimisticLockError);
    const stored = await load(doc.Id);
    expect(stored.Title).to.eq('from a');
    expect(stored.Revision).to.eq(2);
  });

  it('save({ reload: true }) refuses a versioned model whose row is gone instead of inserting it again', async () => {
    const doc = await insertDoc();
    const b = await load(doc.Id);
    await (await load(doc.Id)).destroy();

    b.Title = 'resurrected';
    await expect(b.save({ reload: true })).to.be.rejectedWith(OptimisticLockError);
    expect(await VerDoc.where({ Id: doc.Id }).first()).to.eq(undefined);
  });

  it('archive() refuses a stale copy', async () => {
    const row = new VerSoft({ Title: 'a' });
    await row.insert();
    const stale = await VerSoft.where({ Id: row.Id }).firstOrFail();
    row.Title = 'b';
    await row.update();

    await expect(stale.archive()).to.be.rejectedWith(OptimisticLockError);
    expect((await rows<{ Revision: number; ArchivedAt: unknown }>('ver_soft'))[0]).to.include({ Revision: 2, ArchivedAt: null });
  });

  it('a soft destroy() refuses a stale copy and bumps the version of a current one', async () => {
    const row = new VerSoft({ Title: 'a' });
    await row.insert();
    const stale = await VerSoft.where({ Id: row.Id }).firstOrFail();
    row.Title = 'b';
    await row.update();

    await expect(stale.destroy()).to.be.rejectedWith(OptimisticLockError);
    await row.destroy();

    const [stored] = await rows<{ Revision: number; DeletedAt: unknown }>('ver_soft');
    expect(stored.Revision).to.eq(3);
    expect(stored.DeletedAt).to.not.eq(null);
    expect(row.Revision).to.eq(3);
  });

  it('refuses InsertOrReplace on a versioned model, on both insert paths', async () => {
    await expect(new VerDoc({ Title: 'r' }).insert(InsertBehaviour.InsertOrReplace)).to.be.rejectedWith(InvalidOperation);
    await expect(VerDoc.insert({ Title: 'r' }, InsertBehaviour.InsertOrReplace)).to.be.rejectedWith(InvalidOperation);
    expect(await rows('ver_doc')).to.have.length(0);
  });

  it('an upsert over an existing row leaves its version alone', async () => {
    const doc = await insertDoc();
    const current = await load(doc.Id);
    current.Title = 'v2';
    await current.update();

    await new VerDoc({ Id: doc.Id, Title: 'upserted' }).insert(InsertBehaviour.InsertOrUpdate);

    const stored = await load(doc.Id);
    expect(stored.Title).to.eq('upserted');
    expect(stored.Revision).to.eq(2);
  });

  it('a bulk Model.update() bumps the version, so outstanding copies are refused', async () => {
    const doc = await insertDoc();
    const copy = await load(doc.Id);

    await VerDoc.update({ Title: 'bulk' }).where('Id', doc.Id);

    expect((await load(doc.Id)).Revision).to.eq(2);
    copy.Title = 'stale';
    await expect(copy.update()).to.be.rejectedWith(OptimisticLockError);
  });

  it('accepts a version held as a numeric string, and only a safe integer one', async () => {
    const doc = await insertDoc();
    const a = await load(doc.Id);
    Reflect.set(a, 'Revision', '1');
    a.Title = 'from a string';
    await a.update();
    expect(a.Revision).to.eq(2);

    const b = await load(doc.Id);
    Reflect.set(b, 'Revision', '2.0');
    b.Title = 'not an integer string';
    await expect(b.update()).to.be.rejectedWith(OptimisticLockError);
  });

  it('the static Model.insert() keeps a version supplied on a plain object, and starts a model at 1', async () => {
    await VerDoc.insert({ Title: 'imported', Revision: 7 });
    await VerDoc.insert(new VerDoc({ Title: 'model', Revision: 7 }));

    const stored = await VerDoc.select().order('Id');
    expect(stored.map((d) => d.Revision)).to.deep.equal([7, 1]);
  });

  it('a failed insert() leaves the model at the version it had', async () => {
    const doc = await insertDoc();
    const duplicate = new VerDoc({ Id: doc.Id, Title: 'duplicate' });
    const before = duplicate.Revision;

    await expect(duplicate.insert()).to.be.rejected;
    expect(duplicate.Revision).to.eq(before);
    expect(duplicate.Revision).to.not.eq(1);
  });

  it('a failed save() restores the versions and snapshots of the rows it had already written, so a retry writes them', async () => {
    const doc = await insertDoc('v1');
    await sqlite().insert().into('ver_note').values({ Body: 'n1', doc_id: doc.Id, Revision: 1 });
    const graph = await VerDoc.where({ Id: doc.Id }).populate('Notes').firstOrFail();
    const elsewhere = await VerNote.where({ doc_id: doc.Id }).firstOrFail();
    elsewhere.Body = 'changed elsewhere';
    await elsewhere.update();

    graph.Title = 'v2';
    graph.Notes[0].Body = 'changed here';
    await expect(graph.save()).to.be.rejectedWith(OptimisticLockError);

    expect(graph.Revision).to.eq(1);
    expect(graph.IsDirty).to.eq(true);

    graph.Notes[0].Revision = elsewhere.Revision;
    await graph.save();
    const stored = await load(doc.Id);
    expect(stored.Title).to.eq('v2');
    expect(stored.Revision).to.eq(2);
  });
});
