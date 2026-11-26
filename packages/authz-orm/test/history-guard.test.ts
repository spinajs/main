import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, ScopeForgetter } from '@spinajs/authz';
import type { AdminContext, AuthzEvent, AuthzTx, ResourceRef } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, ModelBase, OrmDriver, WriteStatement } from '@spinajs/orm';

import { ResourceHistoryGuard, UnrecordedResourceWrite, historyRequired } from '../src/history-guard.js';
import { AUTHZ_ORM_CONFIGURATION_SCHEMA, AccessResource, Owner, Parent, Relation, entryOf, reparent } from '../src/index.js';
import { createAncestorTable, dropAncestorTable } from './support/ancestors.js';
import { TestDb } from './support/db.js';

const expect = chai.expect;

type M = typeof ModelBase & { insert(v: object | object[]): Promise<unknown>; update(v: object): { where(...a: unknown[]): Promise<unknown> } & Promise<unknown>; destroy(pk: unknown): Promise<unknown> };

class NoopForgetter extends ScopeForgetter {
  async forget(_scope: ResourceRef, _ctx: AdminContext, _tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    return { affected: 0, tags: [], events: [] };
  }
}

/** Takes every write of an @AccessResource model and keeps history, as row history in full mode does. */
class FullHistory extends WriteObserver {
  public readonly keepsHistory = true;

  public interest(statement: WriteStatement): CaptureInterest | undefined {
    return entryOf(statement.model) ? { columns: '*', transactional: true } : undefined;
  }

  public observe(): Promise<void> {
    return Promise.resolve();
  }
}

/** Row history in column mode over folder_id: an update that writes no tracked column is skipped. */
class FolderHistory extends FullHistory {
  public interest(statement: WriteStatement): CaptureInterest | undefined {
    if (statement.kind === 'update' && !Object.keys(statement.query.Value ?? {}).includes('folder_id')) return undefined;
    return super.interest(statement);
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
const PHRASES = { insert: 'an insert', update: 'an update', delete: 'a delete' } as const;

const refusal = (kind: keyof typeof PHRASES, model: { readonly name: string }, type: string): string =>
  `authz-orm: ${PHRASES[kind]} of ${model.name} (resource '${type}') is not recorded by any history observer, and authz.orm.requireHistory refuses it; import @spinajs/authz-replay in this process so that it registers the model's history before the write, or opt the model out with @AccessResource('${type}', { changelog: false })`;

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
        decorate: (c, p) => {
          AccessResource('doc')(c);
          Parent('folder')(p, 'folder_id');
          Owner()(p, 'owner_id');
          Relation('editor', { typeColumn: 'editor_type' })(p, 'editor_id');
        },
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
  });
});
