import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, ChangeBus, DecisionAudit, SYSTEM, ScopeForgetter } from '@spinajs/authz';
import type { AdminContext, AuthzChange, AuthzEvent, AuthzTx, ResourceRef } from '@spinajs/authz';
import { RecordingAudit, RecordingChangeBus, testHost } from '@spinajs/authz-testing';
import { InsertBehaviour, OrmDriver, QueryMiddleware } from '@spinajs/orm';
import type { ModelBase } from '@spinajs/orm';
import { DI } from '@spinajs/di';

import { AncestorMiddleware } from '../../src/ancestors/middleware.js';
import { AccessResource, Parent } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { ancestorLinks, createAncestorTable, dropAncestorTable } from '../support/ancestors.js';

const expect = chai.expect;

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

describe('AncestorMiddleware', function () {
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
    db = await TestDb.open({ postgres: pg });
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

  it('is a QueryMiddleware at order 90', () => {
    expect(DI.getRegisteredTypes(QueryMiddleware)).to.include(AncestorMiddleware);
    expect(new AncestorMiddleware().order).to.equal(90);
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
        Task = (await db.define({ name: 'Task', columns: { id: 'INTEGER', project_id: 'TEXT', title: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } }, dialect)) as M;
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

      it('an update that leaves the @Parent columns alone touches nothing and needs no transaction', async () => {
        await Task.insert({ id: 1, title: 'a', project_id: 'p1' });
        const mw = new AncestorMiddleware();
        // The ORM compiles an update without a where clause to invalid SQL.
        const q = Task.update({ title: 'b' }).where('id', 1) as unknown as Parameters<AncestorMiddleware['transactional']>[0];
        expect(mw.transactional(q)).to.equal(false);
        await (q as unknown as Promise<unknown>);
        expect((await ancestorLinks(driver)).filter((l) => l.startsWith('task:1>'))).to.deep.equal(['task:1>org:o1@2', 'task:1>project:p1@1']);
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
        const mw = new AncestorMiddleware();
        const q = Task.update({ project_id: 'p2' }) as unknown as Parameters<AncestorMiddleware['beforeQueryExecution']>[0];
        let err: unknown;
        try {
          await mw.beforeQueryExecution(q);
        } catch (e) {
          err = e;
        }
        expect(err).to.be.instanceOf(AuthzConfigError);
        expect((err as Error).message).to.match(/transaction/);
      });
    });
  }
});
