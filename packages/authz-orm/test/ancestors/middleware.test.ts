import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AuthzConfigError, ChangeBus, DecisionAudit, SYSTEM, ScopeForgetter } from '@spinajs/authz';
import type { AdminContext, AuthzChange, AuthzEvent, AuthzTx, ResourceRef } from '@spinajs/authz';
import { RecordingAudit, RecordingChangeBus, testHost } from '@spinajs/authz-testing';
import { InsertBehaviour, InsertQueryBuilder, OrmDriver, SelectQueryBuilder, WriteObserver, createQuery, writeStatementOf } from '@spinajs/orm';
import type { ModelBase, QueryBuilder, WriteStatement } from '@spinajs/orm';
import { DI } from '@spinajs/di';

import { AncestorObserver } from '../../src/ancestors/middleware.js';
import { ColumnChangeObserver } from '../../src/changelog/column-hook.js';
import { ormLog } from '../../src/host.js';
import { AccessResource, Parent } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { ancestorLinks, createAncestorTable, dropAncestorTable, insertLinks } from '../support/ancestors.js';

const expect = chai.expect;

function statementOf(query: QueryBuilder): WriteStatement {
  const statement = writeStatementOf(query);
  if (!statement) throw new Error('not a write');
  return statement;
}

type M = typeof ModelBase & { insert(v: object | object[], b?: InsertBehaviour): Promise<unknown>; update(v: object): { where(...a: unknown[]): Promise<unknown> } & Promise<unknown>; destroy(pk: unknown): Promise<unknown> };
const ticks = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

class RecordingForgetter extends ScopeForgetter {
  readonly calls: { scope: ResourceRef; reason: string | undefined; ormTx: boolean }[] = [];
  async forget(scope: ResourceRef, ctx: AdminContext, tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    this.calls.push({ scope, reason: ctx.reason, ormTx: tx.driver instanceof OrmDriver && tx.driver.CurrentTransaction !== undefined });
    return { affected: 1, tags: [`test:${scope.type}:${scope.id}`], events: [] };
  }
}

describe('AncestorObserver', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  let forgetter: RecordingForgetter;
  let bus: RecordingChangeBus;
  let audit: RecordingAudit;
  const published: { change: AuthzChange; inTx: boolean }[] = [];
  const undo: (() => void)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg, other: true });
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    forgetter = new RecordingForgetter();
    bus = new RecordingChangeBus();
    audit = new RecordingAudit();
    published.length = 0;
    undo.push(testHost.registerInRoot(ScopeForgetter, testHost.instance(forgetter)));
    undo.push(testHost.registerInRoot(ChangeBus, testHost.instance(bus)));
    undo.push(testHost.registerInRoot(DecisionAudit, testHost.instance(audit)));
    await (await testHost.domains()).service('root');
  });

  // Not resetHost: it would also empty the config TestDb put its connections in.
  afterEach(async () => {
    for (const fn of undo.splice(0).reverse()) fn();
    await testHost.resetRoot();
  });

  it('is a WriteObserver, registered before the column changelog as it ran before it at order 90', async () => {
    const observers = DI.getRegisteredTypes(WriteObserver);
    expect(observers).to.include(AncestorObserver);
    expect(observers.indexOf(AncestorObserver)).to.be.below(observers.indexOf(ColumnChangeObserver));
    expect(await import('../../src/index.js')).to.not.have.property('AncestorMiddleware');
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let Project: M;
      let Task: M;
      let driver: OrmDriver;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        driver = db.driver(dialect);
        await createAncestorTable(db, dialect);
        Project = (await db.define({ name: 'Project', columns: { org_id: 'TEXT' }, decorate: (c, p) => { AccessResource('project')(c); Parent('org')(p, 'org_id'); } }, dialect)) as M;
        Task = (await db.define({ name: 'Task', columns: { id: dialect === 'postgres' ? 'SERIAL' : 'INTEGER', project_id: 'TEXT', title: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } }, dialect)) as M;
        bus.subscribe((change) => published.push({ change, inTx: driver.CurrentTransaction !== undefined }));
        await Project.insert([{ id: 'p1', org_id: 'o1' }, { id: 'p2', org_id: 'o2' }]);
      });

      afterEach(async () => {
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      it('an insert writes the parent and its ancestors, one deeper', async () => {
        await Task.insert({ title: 'a', project_id: 'p1' });
        await Task.insert([{ id: 20, title: 'b', project_id: 'p2' }, { id: 21, title: 'c', project_id: null }]);
        const links = await ancestorLinks(driver);
        expect(links).to.include.members(['project:p1>org:o1@1', 'project:p2>org:o2@1', 'task:20>project:p2@1', 'task:20>org:o2@2']);
        const first = links.filter((l) => l.startsWith('task:') && !l.startsWith('task:20') && !l.startsWith('task:21'));
        expect(first.map((l) => l.replace(/^task:\d+/, 'task:*'))).to.deep.equal(['task:*>org:o1@2', 'task:*>project:p1@1']);
        expect(links.some((l) => l.startsWith('task:21>'))).to.equal(false);
      });

      it('an update of a @Parent column moves the row and its subtree in one transaction', async () => {
        await Task.insert({ id: 1, title: 'a', project_id: 'p1' });
        await Task.update({ project_id: 'p2' }).where('id', 1);
        expect((await ancestorLinks(driver)).filter((l) => l.startsWith('task:1>'))).to.deep.equal(['task:1>org:o2@2', 'task:1>project:p2@1']);
        await Project.update({ org_id: 'o9' }).where('id', 'p2');
        expect((await ancestorLinks(driver)).filter((l) => l.startsWith('task:1>'))).to.deep.equal(['task:1>org:o9@2', 'task:1>project:p2@1']);
      });

      it('refuses a write that would drop links to an ancestor type no @Parent names in this process, and keeps them', async () => {
        await Task.insert({ id: 1, title: 'a', project_id: 'p1' });
        // What a process that declares one more parent wrote (@spinajs/tenancy-orm/authz: the tenant of every row).
        const foreign = ['project:p1>tenant:acme@1', 'task:1>tenant:acme@2'];
        await insertLinks(driver, foreign);
        const writes = [() => Task.update({ project_id: 'p2' }).where('id', 1), () => Project.update({ org_id: 'o9' }).where('id', 'p1'), () => Project.destroy('p1')];
        for (const write of writes) {
          let err: unknown;
          try {
            await write();
          } catch (e) {
            err = e;
          }
          expect(err).to.be.instanceOf(AuthzConfigError);
          expect(String((err as Error | undefined)?.message)).to.contain('rows link to tenant, which no @Parent of');
        }
        expect(await ancestorLinks(driver)).to.include.members([...foreign, 'task:1>project:p1@1', 'task:1>org:o1@2', 'project:p1>org:o1@1']);
        const task = (await driver.select().from(db.table(Task)).where('id', 1)) as { project_id: string }[];
        expect(task[0].project_id, 'the refused update rolled back').to.equal('p1');
        expect(await driver.select().from(db.table(Project)).where('id', 'p1')).to.have.length(1);
      });

      it('an update that leaves the @Parent columns alone touches nothing and needs no transaction', async () => {
        await Task.insert({ id: 1, title: 'a', project_id: 'p1' });
        // The ORM compiles an update without a where clause to invalid SQL.
        const q = Task.update({ title: 'b' }).where('id', 1) as unknown as QueryBuilder;
        expect(new AncestorObserver().interest(statementOf(q))?.transactional ?? false).to.equal(false);
        await (q as unknown as Promise<unknown>);
        expect((await ancestorLinks(driver)).filter((l) => l.startsWith('task:1>'))).to.deep.equal(['task:1>org:o1@2', 'task:1>project:p1@1']);
      });

      it('an upsert through a unique column moves the row it updated', async () => {
        const Item = (await db.define({ name: 'Item', columns: { code: 'TEXT UNIQUE', project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('item')(c); Parent('project')(p, 'project_id'); } }, dialect)) as M;
        await Item.insert({ id: 'i1', code: 'k', project_id: 'p1' });
        // Model.insert(..., InsertOrUpdate) would target every column marked unique, the primary key with them.
        const { query } = createQuery(Item, InsertQueryBuilder);
        query.values({ id: 'i2', code: 'k', project_id: 'p2' }).onDuplicate('code').update(['project_id']);
        await query;
        expect((await ancestorLinks(driver)).filter((l) => l.startsWith('item:'))).to.deep.equal(['item:i1>org:o2@2', 'item:i1>project:p2@1']);
      });

      it('an upsert the capture cannot key still rebuilds the rows it names', async () => {
        const Item = (await db.define({ name: 'Item', columns: { code: 'TEXT', kind: 'TEXT', project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('item')(c); Parent('project')(p, 'project_id'); } }, dialect)) as M;
        await db.raw(`CREATE UNIQUE INDEX "ux_${db.table(Item)}" ON "${db.table(Item)}" ("code", "kind")`, [], dialect);
        await Item.insert({ id: 'i1', code: 'k', kind: 'a', project_id: 'p1' });
        // A target of two columns: the capture cannot read its rows and reports unknown keys.
        const { query } = createQuery(Item, InsertQueryBuilder);
        query.values({ id: 'i1', code: 'k', kind: 'a', project_id: 'p2' }).onDuplicate(['code', 'kind']).update(['project_id']);
        await query;
        expect((await ancestorLinks(driver)).filter((l) => l.startsWith('item:'))).to.deep.equal(['item:i1>org:o2@2', 'item:i1>project:p2@1']);
      });

      it('an upsert the capture cannot key links the children that already name the rows it names', async () => {
        const Box = (await db.define({ name: 'Box', columns: { code: 'TEXT', kind: 'TEXT' }, decorate: (c) => AccessResource('box')(c) }, dialect)) as M;
        const Item = (await db.define({ name: 'Item', columns: { box_id: 'TEXT' }, decorate: (c, p) => { AccessResource('item')(c); Parent('box')(p, 'box_id'); } }, dialect)) as M;
        await db.raw(`CREATE UNIQUE INDEX "ux_${db.table(Box)}" ON "${db.table(Box)}" ("code", "kind")`, [], dialect);
        await Item.insert({ id: 'i1', box_id: 'b1' });
        expect((await ancestorLinks(driver)).filter((l) => l.startsWith('item:'))).to.deep.equal([]);
        const { query } = createQuery(Box, InsertQueryBuilder);
        query.values({ id: 'b1', code: 'k', kind: 'a' }).onDuplicate(['code', 'kind']).update(['kind']);
        await query;
        expect((await ancestorLinks(driver)).filter((l) => l.startsWith('item:'))).to.deep.equal(['item:i1>box:b1@1']);
      });

      it('a replace that deletes a row through a unique column forgets it as a delete does', async function () {
        if (dialect !== 'sqlite') this.skip();
        const Item = (await db.define({ name: 'Item', columns: { code: 'TEXT UNIQUE', project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('item')(c); Parent('project')(p, 'project_id'); } }, dialect)) as M;
        await Item.insert({ id: 'i1', code: 'k', project_id: 'p1' });
        await Item.insert({ id: 'i2', code: 'k', project_id: 'p2' }, InsertBehaviour.InsertOrReplace);
        await ticks();
        expect((await ancestorLinks(driver)).filter((l) => l.startsWith('item:'))).to.deep.equal(['item:i2>org:o2@2', 'item:i2>project:p2@1']);
        expect(forgetter.calls).to.deep.equal([{ scope: { type: 'item', id: 'i1' }, reason: 'resource-deleted', ormTx: false }]);
      });

      it('warns once per model about inserts without ids, naming the commands that find and repair the rows', async () => {
        const warn = sinon.stub(ormLog(), 'warn');
        try {
          await createQuery(Task, InsertQueryBuilder).query.values([{ title: 'a', project_id: 'p1' }, { title: 'b', project_id: 'p2' }]);
          await createQuery(Task, InsertQueryBuilder).query.values([{ title: 'c', project_id: 'p1' }, { title: 'd', project_id: 'p2' }]);
          const ours = warn.getCalls().map((c) => String(c.args[1])).filter((m) => m.includes('authz_resource_ancestor'));
          expect(ours).to.have.length(1);
          expect(ours[0]).to.include('authz:ancestors-verify').and.include('authz:ancestors-rebuild');
        } finally {
          warn.restore();
        }
      });

      it('a delete runs one key select, which the column changelog shares', async () => {
        await Task.insert({ id: 1, title: 'a', project_id: 'p1' });
        const spied = driver as unknown as { execute: (this: unknown, ...args: unknown[]) => Promise<unknown> };
        const execute = spied.execute;
        let keySelects = 0;
        spied.execute = function (this: unknown, ...args: unknown[]) {
          if (args[0] instanceof SelectQueryBuilder && args[0].Model === Task) keySelects++;
          return execute.apply(this, args);
        };
        try {
          await Task.destroy(1);
        } finally {
          delete (spied as unknown as Record<string, unknown>).execute;
        }
        expect(keySelects).to.equal(1);
        expect((await ancestorLinks(driver)).filter((l) => l.startsWith('task:'))).to.deep.equal([]);
      });

      const useBackend = (name: string) => {
        testHost.config().set(['authz', 'admin', 'backend'], name);
        undo.push(() => testHost.config().unset(['authz', 'admin', 'backend']));
      };

      it('with DbAuthzAdminBackend a delete forgets in the statement transaction and publishes after the commit', async () => {
        useBackend('DbAuthzAdminBackend');
        await Task.insert({ id: 1, title: 'a', project_id: 'p1' });
        await Project.destroy('p1');
        expect(await ancestorLinks(driver)).to.deep.equal(['project:p2>org:o2@1']);
        expect(forgetter.calls).to.deep.equal([{ scope: { type: 'project', id: 'p1' }, reason: 'resource-deleted', ormTx: true }]);
        await ticks();
        expect(published).to.have.length(1);
        expect(published[0].inTx).to.equal(false);
        expect(published[0].change.tags).to.include.members(['test:project:p1', 'scope:project:p1']);
        expect(published[0].change.actor).to.deep.equal({ type: SYSTEM.type, id: SYSTEM.id });
        expect(audit.of('system')).to.deep.equal([{ kind: 'system', principal: { type: SYSTEM.type, id: SYSTEM.id }, resource: { type: 'project', id: 'p1' }, reason: 'resource-deleted' }]);
      });

      it('with the memory backend (default) the forget runs after the commit in its transaction, then publishes', async () => {
        await Task.insert({ id: 1, title: 'a', project_id: 'p1' });
        await Project.destroy('p1');
        await ticks();
        expect(await ancestorLinks(driver)).to.deep.equal(['project:p2>org:o2@1']);
        expect(forgetter.calls).to.deep.equal([{ scope: { type: 'project', id: 'p1' }, reason: 'resource-deleted', ormTx: false }]);
        expect(published).to.have.length(1);
        expect(published[0].change.tags).to.include.members(['test:project:p1', 'scope:project:p1']);
      });

      it('a rolled-back delete keeps the rows and publishes nothing', async () => {
        await Task.insert({ id: 1, title: 'a', project_id: 'p1' });
        const before = await ancestorLinks(driver);
        try {
          await driver.transaction(async () => {
            await Task.destroy(1);
            throw new Error('roll back');
          });
        } catch (e) {
          expect((e as Error).message).to.equal('roll back');
        }
        await ticks();
        expect(await ancestorLinks(driver)).to.deep.equal(before);
        expect(forgetter.calls, 'the memory backend forgets only after a commit').to.deep.equal([]);
        expect(published).to.deep.equal([]);
      });

      it('a delete that reaches nothing forgets nothing', async () => {
        await Task.destroy(999);
        await ticks();
        expect(forgetter.calls).to.deep.equal([]);
        expect(published).to.deep.equal([]);
      });

      it('refuses a @Parent update when no transaction could be opened', async () => {
        const q = Task.update({ project_id: 'p2' }) as unknown as QueryBuilder;
        let err: unknown;
        try {
          new AncestorObserver().prepare(statementOf(q));
        } catch (e) {
          err = e;
        }
        expect(err).to.be.instanceOf(AuthzConfigError);
        expect((err as Error).message).to.match(/transaction/);
      });

      it('refuses a write of a resource whose connection is not the one authz_resource_ancestor is on', async () => {
        await db.useAuthz('other');
        try {
          let err: unknown;
          try {
            await Task.insert({ id: 5, title: 'x', project_id: 'p1' });
          } catch (e) {
            err = e;
          }
          expect(err).to.be.instanceOf(AuthzConfigError);
          expect((err as Error).message).to.match(/^authz-orm: a insert of Task_\d+_\d+ \(resource 'task'\) runs on connection "(sqlite|postgres)", but authz_resource_ancestor is on connection "other" \(db\.Aliases\.authz\)$/);
          expect((await db.rows(Task)).map((r) => Number(r.id))).to.not.include(5);
        } finally {
          await db.useAuthz(dialect);
        }
      });
    });
  }
});
