import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AUTHZ_CONNECTION, AuthzConfigError, DefaultAuthzService, ScopeForgetter } from '@spinajs/authz';
import type { AdminContext, AuthzEvent, AuthzTx, ResourceRef } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { InsertBehaviour, InsertQueryBuilder, TruncateTableQueryBuilder, UpdateQueryBuilder, WriteObserver, createQuery, deleteChunked, insertChunked, purgeBatch } from '@spinajs/orm';
import type { CaptureInterest, IWhereBuilder, ModelBase, OrmDriver, WriteStatement } from '@spinajs/orm';

import { ResourceHistoryGuard, UnrecordedResourceWrite, historyRequired } from '../src/history-guard.js';
import { AUTHZ_ORM_CONFIGURATION_SCHEMA, AccessResource, Owner, Parent, Relation, entryOf, registerAccessResource, reparent } from '../src/index.js';
import { createAncestorTable, dropAncestorTable } from './support/ancestors.js';
import { TestDb } from './support/db.js';

const expect = chai.expect;

type M = typeof ModelBase & { insert(v: object | object[], behaviour?: InsertBehaviour): Promise<unknown>; update(v: object): { where(...a: unknown[]): Promise<unknown> } & Promise<unknown>; destroy(pk: unknown): Promise<unknown> };

class NoopForgetter extends ScopeForgetter {
  async forget(_scope: ResourceRef, _ctx: AdminContext, _tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    return { affected: 0, tags: [], events: [] };
  }
}

/** Takes every write of an `@AccessResource` model and keeps history, as row history in full mode does. */
class FullHistory extends WriteObserver {
  public readonly keepsHistory = true;

  public interest(statement: WriteStatement): CaptureInterest | undefined {
    return entryOf(statement.model) ? { columns: '*', transactional: true, unrecorded: [] } : undefined;
  }

  public observe(): Promise<void> {
    return Promise.resolve();
  }
}

/** Takes only an update that writes folder_id, and records whole rows. */
class FolderHistory extends FullHistory {
  public interest(statement: WriteStatement): CaptureInterest | undefined {
    if (statement.kind === 'update' && !Object.keys(statement.query.Value ?? {}).includes('folder_id')) return undefined;
    return super.interest(statement);
  }
}

/** Takes every write of an `@AccessResource` model and keeps history with the given interest. */
function historyWith(interest: CaptureInterest): Class<WriteObserver> {
  return class extends FullHistory {
    public interest(statement: WriteStatement): CaptureInterest | undefined {
      return entryOf(statement.model) ? interest : undefined;
    }
  };
}

/** Keeps history of every write of an `@AccessResource` model, as an observer written before `unrecorded` existed. */
class UnstatedHistory extends FullHistory {
  public interest(statement: WriteStatement): CaptureInterest | undefined {
    return entryOf(statement.model) ? { columns: '*', transactional: true } : undefined;
  }
}

/** Takes the same writes and keeps no history, as a cache does. */
class Reader extends WriteObserver {
  public interest(statement: WriteStatement): CaptureInterest | undefined {
    return entryOf(statement.model) ? { columns: '*', transactional: false } : undefined;
  }

  public observe(): Promise<void> {
    return Promise.resolve();
  }
}

function observing(observer: Class<WriteObserver>): () => void {
  DI.register(observer).as(WriteObserver);
  DI.uncache(Array.ofType(WriteObserver));
  return () => {
    DI.unregister(observer);
    DI.uncache(Array.ofType(WriteObserver));
  };
}

const FLAG = ['authz', 'orm', 'requireHistory'];
const DOC_COLUMNS = { folder_id: 'TEXT', owner_id: 'TEXT', editor_id: 'TEXT', editor_type: 'TEXT', title: 'TEXT' };
const D1 = { id: 'd1', folder_id: 'f1', owner_id: 'u1', editor_id: 'g1', editor_type: 'group', title: 'a' };
const RELATION_COLUMNS = ['folder_id', 'owner_id', 'editor_id', 'editor_type'];

function decorateDoc(c: typeof ModelBase, p: object): void {
  AccessResource('doc')(c);
  Parent('folder')(p, 'folder_id');
  Owner()(p, 'owner_id');
  Relation('editor', { typeColumn: 'editor_type' })(p, 'editor_id');
}
const PHRASES = { insert: 'an insert', update: 'an update', delete: 'a delete' } as const;

const refusal = (kind: keyof typeof PHRASES, model: { readonly name: string }, type: string): string =>
  `authz-orm: ${PHRASES[kind]} of ${model.name} (resource '${type}') is not recorded by any history observer, and authz.orm.requireHistory refuses it; import @spinajs/authz-replay in this process so that it registers the model's history before the write, or opt the model out with @AccessResource('${type}', { changelog: false })`;

const gap = (kind: keyof typeof PHRASES, model: { readonly name: string }, type: string, columns: readonly string[]): string =>
  `authz-orm: ${PHRASES[kind]} of ${model.name} (resource '${type}') is kept by a history observer that does not record ${columns.join(', ')}, and authz.orm.requireHistory refuses it; make the model's history record every relation and type column, or opt the model out with @AccessResource('${type}', { changelog: false })`;

const unstated = (kind: keyof typeof PHRASES, model: { readonly name: string }, type: string, observer: { readonly name: string }): string =>
  `authz-orm: ${PHRASES[kind]} of ${model.name} (resource '${type}') is taken by the history observer ${observer.name}, which does not say which columns it records, and authz.orm.requireHistory refuses it; make its interest() set unrecorded to the columns it reads but does not keep ([] when it keeps them all), or opt the model out with @AccessResource('${type}', { changelog: false })`;

const past = (phrase: string, table: string, model: { readonly name: string }, type: string, columns: readonly string[]): string =>
  `authz-orm: ${phrase} of ${table} (resource '${type}') goes past its model ${model.name}, so no history observer records ${columns.join(', ')}, and authz.orm.requireHistory refuses it; write it through the model in a process that imports @spinajs/authz-replay, or with raw SQL where it must not be recorded`;

// rejectedWith(Class, text) matches a fragment; the messages are asserted whole.
async function rejection(write: PromiseLike<unknown>): Promise<unknown> {
  try {
    await write;
  } catch (err) {
    return err;
  }
  throw new Error('expected the write to be refused');
}

describe('ResourceHistoryGuard', function () {
  this.timeout(60000);
  let db: TestDb;
  const undo: (() => void)[] = [];

  before(async () => {
    db = await TestDb.open();
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    undo.push(testHost.registerInRoot(ScopeForgetter, testHost.instance(new NoopForgetter())));
    await (await testHost.domains()).service('root');
  });

  afterEach(async () => {
    testHost.config().unset(FLAG);
    for (const fn of undo.splice(0).reverse()) fn();
    await testHost.resetRoot();
  });

  it('is a WriteObserver that keeps no history itself', () => {
    expect(DI.getRegisteredTypes(WriteObserver)).to.include(ResourceHistoryGuard);
    expect(new ResourceHistoryGuard().keepsHistory).to.equal(undefined);
  });

  it('declares authz.orm.requireHistory, off by default, in a section that keeps no undeclared key', () => {
    // null stays in the type: the configuration would coerce it to false, and the guard must see it to refuse it.
    expect(AUTHZ_ORM_CONFIGURATION_SCHEMA.properties.requireHistory).to.deep.equal({ type: ['boolean', 'null'], default: false });
    expect(AUTHZ_ORM_CONFIGURATION_SCHEMA.additionalProperties).to.equal(false);
  });

  it('reads the key as off only while it is unset or false, and refuses a value that is not a boolean', () => {
    expect(historyRequired(undefined)).to.equal(false);
    expect(historyRequired(false)).to.equal(false);
    expect(historyRequired(true)).to.equal(true);
    for (const value of ['true', 1, null, {}]) {
      expect(() => historyRequired(value)).to.throw(AuthzConfigError, 'authz-orm: authz.orm.requireHistory must be a boolean');
    }
  });

  describe('sqlite', () => {
    let DocClass: Awaited<ReturnType<TestDb['define']>>;
    let Doc: M;
    let driver: OrmDriver;

    beforeEach(async () => {
      driver = db.driver('sqlite');
      await createAncestorTable(db, 'sqlite');
      DocClass = await db.define({
        name: 'Doc',
        columns: DOC_COLUMNS,
        decorate: decorateDoc,
      });
      Doc = DocClass as M;
    });

    afterEach(async () => {
      await db.clear();
      await dropAncestorTable(db, 'sqlite');
    });

    it('changes nothing while the key is unset or false: an insert, an update and a delete no history observer takes all run', async () => {
      await Doc.insert(D1);
      await Doc.update({ folder_id: 'f2' }).where('id', 'd1');
      testHost.config().set(FLAG, false);
      await Doc.update({ owner_id: 'u2' }).where('id', 'd1');
      expect(await db.rows(Doc)).to.deep.equal([{ ...D1, folder_id: 'f2', owner_id: 'u2' }]);

      await Doc.destroy('d1');
      expect(await db.rows(Doc)).to.deep.equal([]);
    });

    it('refuses an insert, an update of a relation column and a delete that no history observer takes, before the statement runs', async () => {
      testHost.config().set(FLAG, true);
      expect(await rejection(Doc.insert(D1))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', refusal('insert', Doc, 'doc'));
      expect(await rejection(Doc.insert(D1, InsertBehaviour.InsertOrUpdate))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', refusal('insert', Doc, 'doc'));
      expect(await db.rows(Doc)).to.deep.equal([]);

      await db.insertRaw(Doc, D1);
      expect(await rejection(Doc.update({ folder_id: 'f2' }).where('id', 'd1'))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', refusal('update', Doc, 'doc'));
      expect(await rejection(Doc.destroy('d1'))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', refusal('delete', Doc, 'doc'));
      expect(await db.rows(Doc)).to.deep.equal([D1]);
    });

    it('counts a type column and the primary key like a relation column, and lets an update of any other column through', async () => {
      testHost.config().set(FLAG, true);
      await db.insertRaw(Doc, D1);
      await Doc.update({ title: 'b' }).where('id', 'd1');
      expect(await rejection(Doc.update({ editor_type: 'team' }).where('id', 'd1'))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', refusal('update', Doc, 'doc'));
      expect(await rejection(Doc.update({ id: 'd9' }).where('id', 'd1'))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', refusal('update', Doc, 'doc'));
      expect(await db.rows(Doc)).to.deep.equal([{ ...D1, title: 'b' }]);
    });

    it('refuses reparent(), and inside a caller transaction leaves the rollback of what ran before to the caller', async () => {
      testHost.config().set(FLAG, true);
      await db.insertRaw(Doc, D1);
      expect(await rejection(reparent(DocClass, ['d1'], 'f2'))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', refusal('update', Doc, 'doc'));

      const moved = driver.transaction(async () => {
        await Doc.update({ title: 'b' }).where('id', 'd1');
        await Doc.update({ folder_id: 'f2' }).where('id', 'd1');
      });
      expect(await rejection(moved)).to.be.instanceOf(UnrecordedResourceWrite);
      expect(await db.rows(Doc)).to.deep.equal([D1]);
    });

    it('leaves alone a model that is no resource, one opted out with changelog: false and one without relation columns', async () => {
      testHost.config().set(FLAG, true);
      const Note = (await db.define({ name: 'Note', columns: { title: 'TEXT' } })) as M;
      const Quiet = (await db.define({
        name: 'Quiet',
        columns: { folder_id: 'TEXT' },
        decorate: (c, p) => {
          AccessResource('quiet', { changelog: false })(c);
          Parent('folder')(p, 'folder_id');
        },
      })) as M;
      const Plain = (await db.define({
        name: 'Plain',
        columns: { title: 'TEXT' },
        decorate: (c) => {
          AccessResource('plain')(c);
        },
      })) as M;

      await Note.insert({ id: 'n1', title: 'a' });
      await Quiet.insert({ id: 'q1', folder_id: 'f1' });
      await Plain.insert({ id: 'p1', title: 'a' });
      expect(await db.rows(Note)).to.have.length(1);
      expect(await db.rows(Quiet)).to.have.length(1);
      expect(await db.rows(Plain)).to.have.length(1);
    });

    it('lets through every write a history-keeping observer takes', async () => {
      undo.push(observing(FullHistory));
      testHost.config().set(FLAG, true);
      await Doc.insert(D1);
      await Doc.update({ folder_id: 'f2' }).where('id', 'd1');
      expect(await reparent(DocClass, ['d1'], 'f3')).to.equal(1);
      expect(await db.rows(Doc)).to.deep.equal([{ ...D1, folder_id: 'f3' }]);

      await Doc.destroy('d1');
      expect(await db.rows(Doc)).to.deep.equal([]);
    });

    it('refuses a write the history-keeping observer skips, as column mode skips an update of a column it does not track', async () => {
      undo.push(observing(FolderHistory));
      testHost.config().set(FLAG, true);
      await db.insertRaw(Doc, D1);
      await Doc.update({ folder_id: 'f2' }).where('id', 'd1');
      expect(await rejection(Doc.update({ owner_id: 'u2' }).where('id', 'd1'))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', refusal('update', Doc, 'doc'));
      expect(await db.rows(Doc)).to.deep.equal([{ ...D1, folder_id: 'f2' }]);
    });

    it('refuses a write a history takes without recording a relation or type column: column mode, exclude, a masked @Hidden() column', async () => {
      testHost.config().set(FLAG, true);
      undo.push(observing(historyWith({ columns: ['title'], transactional: true, unrecorded: [] })));
      expect(await rejection(Doc.insert(D1))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', gap('insert', Doc, 'doc', RELATION_COLUMNS));
      await db.insertRaw(Doc, D1);
      expect(await rejection(Doc.update({ title: 'b', owner_id: 'u2' }).where('id', 'd1'))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', gap('update', Doc, 'doc', RELATION_COLUMNS));
      undo.pop()?.();

      // HistoryObserver names a column that exclude or a masked @Hidden() leaves out in unrecorded.
      undo.push(observing(historyWith({ columns: '*', transactional: true, unrecorded: ['secret', 'owner_id'] })));
      expect(await rejection(Doc.update({ owner_id: 'u2' }).where('id', 'd1'))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', gap('update', Doc, 'doc', ['owner_id']));
      expect(await rejection(Doc.destroy('d1'))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', gap('delete', Doc, 'doc', ['owner_id']));
      expect(await db.rows(Doc)).to.deep.equal([D1]);
    });

    it('refuses a write a history-keeping observer takes without stating unrecorded, which makes no claim about the columns it records', async () => {
      testHost.config().set(FLAG, true);
      undo.push(observing(UnstatedHistory));
      expect(await rejection(Doc.insert(D1))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', unstated('insert', Doc, 'doc', UnstatedHistory));
      await db.insertRaw(Doc, D1);
      expect(await rejection(Doc.update({ owner_id: 'u2' }).where('id', 'd1'))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', unstated('update', Doc, 'doc', UnstatedHistory));
      expect(await db.rows(Doc)).to.deep.equal([D1]);
    });

    it("lets through a history whose columns name every relation and type column, and one that masks only a column replay does not read", async () => {
      testHost.config().set(FLAG, true);
      undo.push(observing(historyWith({ columns: RELATION_COLUMNS, transactional: true, unrecorded: [] })));
      await Doc.insert(D1);
      await Doc.update({ title: 'b', owner_id: 'u2' }).where('id', 'd1');
      undo.pop()?.();

      undo.push(observing(historyWith({ columns: '*', transactional: true, unrecorded: ['secret'] })));
      await Doc.update({ editor_type: 'team' }).where('id', 'd1');
      expect(await db.rows(Doc)).to.deep.equal([{ ...D1, title: 'b', owner_id: 'u2', editor_type: 'team' }]);
    });

    it('judges a model registered with registerAccessResource() by the same rule', async () => {
      testHost.config().set(FLAG, true);
      const Job = (await db.define({ name: 'Job', columns: { owner_id: 'TEXT', title: 'TEXT' } })) as M;
      registerAccessResource(Job, 'job', { owner: 'owner_id' });
      expect(await rejection(Job.insert({ id: 'j1', owner_id: 'u1', title: 'a' }))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', refusal('insert', Job, 'job'));
      undo.push(observing(historyWith({ columns: ['owner_id'], transactional: true, unrecorded: [] })));
      await Job.insert({ id: 'j1', owner_id: 'u1', title: 'a' });
      expect(await db.rows(Job)).to.have.length(1);
    });

    it('does not count an observer that takes the write but keeps no history', async () => {
      undo.push(observing(Reader));
      testHost.config().set(FLAG, true);
      expect(await rejection(Doc.insert(D1))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', refusal('insert', Doc, 'doc'));
      expect(await db.rows(Doc)).to.deep.equal([]);
    });

    it('refuses every resource write while the key holds a value that is not a boolean', async () => {
      testHost.config().set(FLAG, 'yes');
      expect(await rejection(Doc.insert(D1))).to.be.instanceOf(AuthzConfigError).with.property('message', 'authz-orm: authz.orm.requireHistory must be a boolean');
      expect(await db.rows(Doc)).to.deep.equal([]);
    });

    const aliased = (): OrmDriver => db.orm.Connections.get(AUTHZ_CONNECTION) ?? expect.fail(`no connection alias ${AUTHZ_CONNECTION}`);

    /** Every way to write Doc's table past its model. Run in order on the row D1, each one changes the table. */
    const pastWrites = (table: string, Note: typeof ModelBase): [string, () => PromiseLike<unknown>][] => [
      ['an insert', () => driver.insert().into(table).values({ ...D1, id: 'd2' })],
      ['an insert', () => driver.insert().into(table).values(D1).onDuplicate('id').update(['folder_id'])],
      ['an update', () => driver.update().in(table).update({ folder_id: 'f2' }).where('id', 'd1')],
      ['an update', () => driver.update().in(table).increment('owner_id').where('id', 'd1')],
      ['an update', () => driver.update().in(table).update({ id: 'd9' }).where('id', 'd1')],
      ['a delete', () => driver.del().from(table).where('id', 'd2')],
      ['a delete', () => aliased().del().from(table, 'x').where('id', 'd9')],
      ['an insert', () => insertChunked(driver, table, [{ ...D1, id: 'd3' }])],
      ['a delete', () => deleteChunked(driver, table, 'id', ['d3'])],
      ['a truncate', () => driver.truncate(table)],
      // What Doc.truncate() builds (orm/src/model.ts:1199): ModelBase types the static truncate() as void.
      ['a truncate', () => createQuery(DocClass, TruncateTableQueryBuilder, false).query],
      ['an insert', () => createQuery(Note, InsertQueryBuilder).query.into(table).values({ ...D1, id: 'd4' })],
    ];

    async function sent(fn: () => Promise<void>): Promise<number> {
      const execute = sinon.spy(driver, 'execute');
      try {
        await fn();
        return execute.callCount;
      } finally {
        execute.restore();
      }
    }

    async function refusedPast(table: string, writes: [string, () => PromiseLike<unknown>][]): Promise<void> {
      for (const [phrase, write] of writes) expect(await rejection(write()), phrase).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', past(phrase, table, Doc, 'doc', RELATION_COLUMNS));
    }

    it('refuses every write of a resource table that goes past its model while the key is on, before it sends a statement', async () => {
      testHost.config().set(FLAG, true);
      await db.insertRaw(Doc, D1);
      const table = db.table(Doc);
      const writes = pastWrites(table, await db.define({ name: 'Note', columns: { title: 'TEXT' } }));
      expect(await sent(() => refusedPast(table, writes))).to.equal(0);
      // Its one statement is the select of the keys to delete.
      const purged = sent(async () => {
        expect(await rejection(purgeBatch(driver, { table, key: 'id', where: function (this: IWhereBuilder<unknown>) { this.where('folder_id', 'f1'); } }))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', past('a delete', table, Doc, 'doc', RELATION_COLUMNS));
      });
      expect(await purged).to.equal(1);
      expect(await db.rows(Doc)).to.deep.equal([D1]);
    });

    // FullHistory records every column of every model write: a guard that asked it about the table's model would pass these.
    it('refuses them whatever history is registered, and lets the model write the same row', async () => {
      undo.push(observing(FullHistory));
      testHost.config().set(FLAG, true);
      await db.insertRaw(Doc, D1);
      const table = db.table(Doc);
      await refusedPast(table, pastWrites(table, await db.define({ name: 'Note', columns: { title: 'TEXT' } })));
      expect(await db.rows(Doc)).to.deep.equal([D1]);
      await Doc.update({ folder_id: 'f2' }).where('id', 'd1');
      expect(await db.rows(Doc)).to.deep.equal([{ ...D1, folder_id: 'f2' }]);
    });

    it('runs every write past the model while the key is unset or false', async () => {
      const table = db.table(Doc);
      const writes = pastWrites(table, await db.define({ name: 'Note', columns: { title: 'TEXT' } }));
      for (const value of [undefined, false]) {
        if (value !== undefined) testHost.config().set(FLAG, value);
        await db.insertRaw(Doc, D1);
        expect(await sent(async () => {
          for (const [, write] of writes) await write();
        })).to.equal(writes.length);
        expect(await db.rows(Doc)).to.deep.equal([{ ...D1, id: 'd4' }]);
      }
    });

    it('leaves alone a write past the model of a table no resource uses, and every read, without reading the key', async () => {
      // Reading a key that is no boolean throws.
      testHost.config().set(FLAG, 'yes');
      const notes = db.table(await db.define({ name: 'Note', columns: { title: 'TEXT' } }));
      const writes = sent(async () => {
        await driver.insert().into(notes).values({ id: 'n1', title: 'a' });
        await driver.update().in(notes).update({ title: 'b' }).where('id', 'n1');
        await driver.del().from(notes).where('id', 'n1');
        await driver.truncate(notes);
      });
      expect(await writes).to.equal(4);
      await db.insertRaw(Doc, D1);
      expect(await driver.select().from(db.table(Doc))).to.deep.equal([D1]);
      testHost.config().set(FLAG, true);
      expect(await driver.select().from(db.table(Doc)).where('id', 'd1')).to.deep.equal([D1]);
    });

    it('judges a model update by the columns it increments and by its key, for each refusal of a model write', async () => {
      testHost.config().set(FLAG, true);
      await db.insertRaw(Doc, D1);
      const cases: [Class<WriteObserver> | undefined, string][] = [
        [undefined, refusal('update', Doc, 'doc')],
        [historyWith({ columns: ['title'], transactional: true, unrecorded: [] }), gap('update', Doc, 'doc', RELATION_COLUMNS)],
        [UnstatedHistory, unstated('update', Doc, 'doc', UnstatedHistory)],
      ];
      for (const [observer, message] of cases) {
        if (observer) undo.push(observing(observer));
        expect(await rejection(createQuery(DocClass, UpdateQueryBuilder).query.increment('owner_id').where('id', 'd1'))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', message);
        expect(await rejection(Doc.update({ id: 'd9' }).where('id', 'd1'))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', message);
        await Doc.update({ title: 'b' }).where('id', 'd1');
        if (observer) undo.pop()?.();
      }
      expect(await db.rows(Doc)).to.deep.equal([{ ...D1, title: 'b' }]);
    });

    it('judges a write past the model of a table whose model became a resource after the builder was made', async () => {
      testHost.config().set(FLAG, true);
      const Job = await db.define({ name: 'Job', columns: { owner_id: 'TEXT', title: 'TEXT' } });
      const jobs = db.table(Job);
      await driver.insert().into(jobs).values({ id: 'j1', owner_id: 'u1', title: 'a' });
      const late = driver.del().from(jobs).where('id', 'j1');
      registerAccessResource(Job, 'job', { owner: 'owner_id' });
      expect(await rejection(late)).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', past('a delete', jobs, Job, 'job', ['owner_id']));
      expect(await db.rows(Job)).to.have.length(1);
    });

    // @spinajs/users discards a half-created account this way (discardInsertedUser), so it is refused there when the
    // application's user model is a resource with a relation column, and the account row stays.
    it('refuses a bare delete of a resource row by its model table name, and the row stays', async () => {
      testHost.config().set(FLAG, true);
      await db.insertRaw(Doc, D1);
      const table = DocClass.getModelDescriptor().TableName;
      expect(await rejection(driver.del().from(table).where('id', 'd1'))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', past('a delete', table, Doc, 'doc', RELATION_COLUMNS));
      expect(await db.rows(Doc)).to.deep.equal([D1]);
    });

    it('leaves alone a write past the model while the key is off, one of a column replay does not read, one of an opted-out resource, and raw SQL', async () => {
      const table = db.table(Doc);
      await driver.insert().into(table).values(D1);
      testHost.config().set(FLAG, true);
      await driver.update().in(table).update({ title: 'b' }).where('id', 'd1');
      expect(await db.rows(Doc)).to.deep.equal([{ ...D1, title: 'b' }]);
      const Quiet = await db.define({
        name: 'Quiet',
        columns: { folder_id: 'TEXT' },
        decorate: (c, p) => {
          AccessResource('quiet', { changelog: false })(c);
          Parent('folder')(p, 'folder_id');
        },
      });
      await driver.insert().into(db.table(Quiet)).values({ id: 'q1', folder_id: 'f1' });
      expect(await db.rows(Quiet)).to.have.length(1);
      await driver.schema().raw(`DELETE FROM ${table}`, []);
      expect(await db.rows(Doc)).to.deep.equal([]);
    });
  });
});

describe('ResourceHistoryGuard in a process that boots no authz domain', function () {
  this.timeout(60000);
  let db: TestDb;
  let Doc: M;
  const undo: (() => void)[] = [];

  before(async () => {
    db = await TestDb.open();
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await testHost.resetRoot();
    await createAncestorTable(db, 'sqlite');
    Doc = (await db.define({ name: 'Doc', columns: DOC_COLUMNS, decorate: decorateDoc })) as M;
  });

  afterEach(async () => {
    testHost.config().unset(FLAG);
    for (const fn of undo.splice(0).reverse()) fn();
    await db.clear();
    await dropAncestorTable(db, 'sqlite');
  });

  it('refuses and lets through a write as a worker that only imports its models does', async () => {
    testHost.config().set(FLAG, true);
    expect(await rejection(Doc.insert(D1))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', refusal('insert', Doc, 'doc'));
    undo.push(observing(historyWith({ columns: ['title'], transactional: true, unrecorded: [] })));
    expect(await rejection(Doc.insert(D1))).to.be.instanceOf(UnrecordedResourceWrite).with.property('message', gap('insert', Doc, 'doc', RELATION_COLUMNS));
    undo.push(observing(FullHistory));
    await Doc.insert(D1);
    expect(await db.rows(Doc)).to.deep.equal([D1]);
    expect(DI.RootContainer.Cache.has(DefaultAuthzService)).to.equal(false);
  });
});
