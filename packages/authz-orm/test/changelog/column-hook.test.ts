import * as chai from 'chai';
import 'mocha';

import { ScopeForgetter, changeLog } from '@spinajs/authz';
import type { AdminContext, AuthzEvent, AuthzTx, ChangeRecord, ResourceRef } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { QueryMiddleware } from '@spinajs/orm';
import type { ModelBase, OrmDriver } from '@spinajs/orm';

import { ColumnChangeMiddleware } from '../../src/changelog/column-hook.js';
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

const summary = (rows: readonly ChangeRecord[]) => rows.map((r) => [r.op, r.key, (r.payload as { old: unknown }).old, (r.payload as { new: unknown }).new]);

describe('ColumnChangeMiddleware', function () {
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

  it('is a QueryMiddleware at order 91 and makes the column kind covered', () => {
    expect(DI.getRegisteredTypes(QueryMiddleware)).to.include(ColumnChangeMiddleware);
    expect(new ColumnChangeMiddleware().order).to.equal(91);
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
    });
  }
});
