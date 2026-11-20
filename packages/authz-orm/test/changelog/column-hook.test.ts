import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { SYSTEM, ScopeForgetter, changeLog, currentPrincipal, runWithPrincipal } from '@spinajs/authz';
import type { AdminContext, AuthzEvent, AuthzTx, ChangeRecord, Principal, ResourceRef } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { InsertQueryBuilder, QueryMiddleware, SelectQueryBuilder, WriteObserver, createQuery } from '@spinajs/orm';
import type { ModelBase, OrmDriver, QueryBuilder } from '@spinajs/orm';

import { ColumnChangeObserver } from '../../src/changelog/column-hook.js';
import { ormLog } from '../../src/host.js';
import { AccessResource, Owner, Parent, Relation, registerAccessResource } from '../../src/index.js';
import { createAncestorTable, dropAncestorTable } from '../support/ancestors.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';

const expect = chai.expect;

type M = typeof ModelBase & { insert(v: object | object[]): Promise<unknown>; update(v: object): { where(...a: unknown[]): Promise<unknown> } & Promise<unknown>; destroy(pk: unknown): Promise<unknown> };

class NoopForgetter extends ScopeForgetter {
  async forget(_scope: ResourceRef, _ctx: AdminContext, _tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    return { affected: 0, tags: [], events: [] };
  }
}

const DOC_COLUMNS = { folder_id: 'TEXT', owner_id: 'TEXT', editor_id: 'TEXT', editor_type: 'TEXT', title: 'TEXT' };
const D1 = { id: 'd1', folder_id: 'f1', owner_id: 'u1', editor_id: 'g1', editor_type: 'group', title: 'a' };

const ALICE: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };

const summary =(rows: readonly ChangeRecord[]) => rows.map((r) => [r.op, r.key, (r.payload as { old: unknown }).old, (r.payload as { new: unknown }).new]);

describe('ColumnChangeObserver', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  const undo: (() => void)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    undo.push(testHost.registerInRoot(ScopeForgetter, testHost.instance(new NoopForgetter())));
    await (await testHost.domains()).service('root');
  });

  afterEach(async () => {
    for (const fn of undo.splice(0).reverse()) fn();
    await testHost.resetRoot();
  });

  it('is a WriteObserver and makes the column kind covered', async () => {
    expect(DI.getRegisteredTypes(WriteObserver)).to.include(ColumnChangeObserver);
    expect(await import('../../src/index.js')).to.not.have.property('ColumnChangeMiddleware');
    expect(changeLog().covers('column')).to.equal(true);
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let Doc: M;
      let driver: OrmDriver;
      const logged = () => changeLog().since(0, { kinds: ['column'] });

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        driver = db.driver(dialect);
        await createAncestorTable(db, dialect);
        Doc = (await db.define(
          {
            name: 'Doc',
            columns: DOC_COLUMNS,
            decorate: (c, p) => {
              AccessResource('doc')(c);
              Parent('folder')(p, 'folder_id');
              Owner()(p, 'owner_id');
              Relation('editor', { typeColumn: 'editor_type' })(p, 'editor_id');
            },
          },
          dialect,
        )) as M;
      });

      afterEach(async () => {
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      it('an insert logs every relation column it set, keyed type:id#relation', async () => {
        await Doc.insert(D1);
        expect(summary(await logged())).to.deep.equal([
          ['add', 'doc:d1#parent', null, { type: 'folder', id: 'f1' }],
          ['add', 'doc:d1#owner', null, { type: 'user', id: 'u1' }],
          ['add', 'doc:d1#editor', null, { type: 'group', id: 'g1' }],
        ]);
        expect((await logged())[0].payload).to.deep.include({ column: 'folder_id' });
      });

      it('an update logs the old and new value of each relation column it changed, and nothing for other columns', async () => {
        await Doc.insert(D1);
        const seq = (await logged()).at(-1)!.seq;
        await Doc.update({ title: 'b' }).where('id', 'd1');
        await Doc.update({ folder_id: 'f2', editor_type: 'team' }).where('id', 'd1');

        expect(summary(await changeLog().since(seq))).to.deep.equal([
          ['put', 'doc:d1#parent', { type: 'folder', id: 'f1' }, { type: 'folder', id: 'f2' }],
          ['put', 'doc:d1#editor', { type: 'group', id: 'g1' }, { type: 'team', id: 'g1' }],
        ]);
      });

      it('a delete logs the values the row held', async () => {
        await Doc.insert(D1);
        const seq = (await logged()).at(-1)!.seq;
        await Doc.destroy('d1');

        expect(summary(await changeLog().since(seq))).to.deep.equal([
          ['remove', 'doc:d1#parent', { type: 'folder', id: 'f1' }, null],
          ['remove', 'doc:d1#owner', { type: 'user', id: 'u1' }, null],
          ['remove', 'doc:d1#editor', { type: 'group', id: 'g1' }, null],
        ]);
      });

      it('a write that rolls back logs nothing', async () => {
        await Doc.insert(D1);
        const seq = (await logged()).at(-1)!.seq;
        await driver
          .transaction(async () => {
            await Doc.update({ folder_id: 'f2' }).where('id', 'd1');
            throw new Error('roll back');
          })
          .catch(() => undefined);

        expect(await changeLog().since(seq)).to.deep.equal([]);
      });

      it('a model opted out with changelog: false logs nothing, decorated or registered', async () => {
        const Quiet = (await db.define({ name: 'Quiet', columns: { folder_id: 'TEXT' }, decorate: (c, p) => { AccessResource('quiet', { changelog: false })(c); Parent('folder')(p, 'folder_id'); } }, dialect)) as M;
        const Legacy = (await db.define({ name: 'Legacy', columns: { owner_id: 'TEXT' }, decorate: (c) => registerAccessResource(c, 'legacy', { owner: 'owner_id', changelog: false }) }, dialect)) as M;
        await Quiet.insert({ id: 'q1', folder_id: 'f1' });
        await Legacy.insert({ id: 'l1', owner_id: 'u1' });

        expect(await logged()).to.deep.equal([]);
        expect(changeLog().covers('column', 'quiet')).to.equal(false);
        expect(changeLog().covers('column', 'legacy')).to.equal(false);
        expect(changeLog().covers('column', 'doc')).to.equal(true);
        expect(changeLog().covers('column', 'unknown')).to.equal(false);
      });

      it('an upsert through a unique column logs the put of the row it updated, with its old values', async () => {
        const Coded = (await db.define({ name: 'Coded', columns: { code: 'TEXT UNIQUE', folder_id: 'TEXT' }, decorate: (c, p) => { AccessResource('coded')(c); Parent('folder')(p, 'folder_id'); } }, dialect)) as M;
        await Coded.insert({ id: 'c1', code: 'k', folder_id: 'f1' });
        const seq = (await logged()).at(-1)!.seq;
        // Model.insert(..., InsertOrUpdate) would target every column marked unique, the primary key with them.
        const { query } = createQuery(Coded, InsertQueryBuilder);
        query.values({ id: 'c2', code: 'k', folder_id: 'f2' }).onDuplicate('code').update(['folder_id']);
        await query;

        expect(summary(await changeLog().since(seq))).to.deep.equal([['put', 'coded:c1#parent', { type: 'folder', id: 'f1' }, { type: 'folder', id: 'f2' }]]);
      });

      it('an insert whose ids the driver did not report logs nothing and warns once', async () => {
        const Counted = (await db.define({ name: 'Counted', columns: { id: dialect === 'postgres' ? 'SERIAL' : 'INTEGER', folder_id: 'TEXT' }, decorate: (c, p) => { AccessResource('counted')(c); Parent('folder')(p, 'folder_id'); } }, dialect)) as M;
        const warn = sinon.stub(ormLog(), 'warn');
        try {
          // Built without ModelBase.insert, so no RETURNING is added.
          await createQuery(Counted, InsertQueryBuilder).query.values([{ folder_id: 'f1' }, { folder_id: 'f2' }]);
          await createQuery(Counted, InsertQueryBuilder).query.values([{ folder_id: 'f3' }, { folder_id: 'f4' }]);
          // The ancestor table warns about the same inserts.
          expect(warn.getCalls().filter((c) => String(c.args[1]).includes('the changelog misses their relation columns'))).to.have.length(1);
        } finally {
          warn.restore();
        }

        expect(await logged()).to.deep.equal([]);
        expect(await db.rows(Counted)).to.have.length(4);
      });

      it('a bulk update logs every row it moved', async () => {
        await Doc.insert([D1, { ...D1, id: 'd2' }, { ...D1, id: 'd3', folder_id: 'f3' }]);
        const seq = (await logged()).at(-1)!.seq;
        await Doc.update({ folder_id: 'f9' }).where('folder_id', 'f1');

        expect(summary(await changeLog().since(seq)).sort((a, b) => String(a[1]).localeCompare(String(b[1])))).to.deep.equal([
          ['put', 'doc:d1#parent', { type: 'folder', id: 'f1' }, { type: 'folder', id: 'f9' }],
          ['put', 'doc:d2#parent', { type: 'folder', id: 'f1' }, { type: 'folder', id: 'f9' }],
        ]);
      });

      it('logs the change of a row the writing principal cannot read: the key select runs as SYSTEM', async () => {
        await Doc.insert(D1);
        const seq = (await logged()).at(-1)!.seq;
        const hidden = Doc;
        class HideDocs extends QueryMiddleware {
          public order = 50;
          afterQueryCreation(): void {}
          async beforeQueryExecution(query: QueryBuilder): Promise<void> {
            if (query instanceof SelectQueryBuilder && query.Model === hidden && currentPrincipal() !== SYSTEM) query.where('id', '__nobody__');
          }
        }
        DI.register(HideDocs).as(QueryMiddleware);
        DI.uncache(Array.ofType(QueryMiddleware));
        try {
          await runWithPrincipal(ALICE, () => Doc.update({ folder_id: 'f2' }).where('id', 'd1'));
        } finally {
          DI.unregister(HideDocs);
          DI.uncache(Array.ofType(QueryMiddleware));
        }

        expect(summary(await changeLog().since(seq))).to.deep.equal([['put', 'doc:d1#parent', { type: 'folder', id: 'f1' }, { type: 'folder', id: 'f2' }]]);
      });
    });
  }
});
