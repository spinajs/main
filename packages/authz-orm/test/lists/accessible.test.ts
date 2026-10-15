import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AccessDenied, AuthzConfigError, DecisionAudit, PlanTermSql, runWithPrincipal } from '@spinajs/authz';
import type { AccessPlan, AuthzService, Principal } from '@spinajs/authz';
import { RecordingAudit, testHost } from '@spinajs/authz-testing';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource } from '../../src/index.js';
import { marksOf } from '../../src/marker.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { createAncestorTable, dropAncestorTable } from '../support/ancestors.js';
import { FlagSql } from '../support/flag-sql.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const green: AccessPlan = { kind: 'filter', permit: [{ op: 'test.flag', args: { flag: 'green' } }], deny: [] };

type Q = Promise<ModelBase[]> & { accessible(p: string, o?: object): Q; unscoped(r: string): Q; where(...a: unknown[]): Q; orWhere(...a: unknown[]): Q; clone(): Q };
type M = typeof ModelBase & { query(): Q; where(...a: unknown[]): Q; update(v: object): Promise<{ RowsAffected: number }> & { accessible(p: string): Promise<{ RowsAffected: number }> }; destroy(pk?: unknown): Promise<unknown> & { accessible(p: string): Promise<unknown> } };

const ids = (rows: ModelBase[]) => rows.map((r) => String((r as unknown as { id: unknown }).id)).sort();

describe('.accessible() and .unscoped()', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  let service: AuthzService;
  let plan: sinon.SinonStub;
  let audit: RecordingAudit;
  const undo: (() => void)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    audit = new RecordingAudit();
    undo.push(testHost.registerInRoot(PlanTermSql, FlagSql), testHost.registerInRoot(DecisionAudit, testHost.instance(audit)));
    service = await (await testHost.domains()).service('root');
    plan = sinon.stub(service, 'accessPlan').resolves(green);
  });

  afterEach(async () => {
    sinon.restore();
    for (const fn of undo.splice(0).reverse()) fn();
    await testHost.resetRoot();
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let Task: M;
      let Plain: M;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        await createAncestorTable(db, dialect);
        Task = (await db.define({ name: 'Task', columns: { flag: 'TEXT', title: 'TEXT' }, rows: [{ id: 't1', flag: 'green', title: 'a' }, { id: 't2', flag: 'red', title: 'b' }, { id: 't3', flag: 'green', title: 'c' }], decorate: (c) => AccessResource('task')(c) }, dialect)) as M;
        Plain = (await db.define({ name: 'Plain', columns: { title: 'TEXT' } }, dialect)) as M;
      });

      afterEach(async () => {
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      // Builders are thenables, not Promises.
      const as = <T>(fn: () => PromiseLike<T>) => runWithPrincipal(alice, async () => fn());

      it('filters a select by the plan, for the current principal, with the env given', async () => {
        expect(ids(await as(() => Task.query().accessible('task:read')))).to.deep.equal(['t1', 't3']);
        expect(plan.firstCall.args.slice(0, 3)).to.deep.equal([alice, 'task:read', 'task']);
        expect(plan.firstCall.args[3]).to.equal(undefined);
        await as(() => Task.query().accessible('task:read', { env: { ip: '10.0.0.1' } }));
        expect(plan.secondCall.args[3]).to.deep.equal({ ip: '10.0.0.1' });
      });

      it("keeps the caller's where in one group: an orWhere cannot widen the plan", async () => {
        const rows = await as(() => Task.where('title', 'a').orWhere('title', 'b').accessible('task:read'));
        expect(ids(rows)).to.deep.equal(['t1']);
      });

      it('filters updates and deletes the same way', async () => {
        await as(() => Task.update({ title: 'x' }).accessible('task:update'));
        expect((await db.rows(Task)).filter((r) => r.title === 'x').map((r) => r.id).sort()).to.deep.equal(['t1', 't3']);
        // The ORM refuses a destroy() without primary keys; t2 is listed so only the plan keeps it.
        await as(() => Task.destroy(['t1', 't2', 't3']).accessible('task:delete'));
        expect((await db.rows(Task)).map((r) => r.id)).to.deep.equal(['t2']);
      });

      it('a none plan is AccessDenied with its reason; an all plan filters nothing', async () => {
        plan.resolves({ kind: 'none', reason: { code: 'no_access' } });
        let err: unknown;
        try {
          await as(() => Task.query().accessible('task:read'));
        } catch (e) {
          err = e;
        }
        expect(err).to.be.instanceOf(AccessDenied);
        expect((err as AccessDenied).decision.reason).to.deep.equal({ code: 'no_access' });
        plan.resolves({ kind: 'filter', permit: 'all', deny: [] });
        expect(ids(await as(() => Task.query().accessible('task:read')))).to.deep.equal(['t1', 't2', 't3']);
      });

      it('unscoped runs unfiltered and audits once', async () => {
        expect(ids(await as(() => Task.query().unscoped('nightly export')))).to.deep.equal(['t1', 't2', 't3']);
        await new Promise((r) => setImmediate(r));
        expect(audit.of('unscoped')).to.deep.equal([{ kind: 'unscoped', principal: { type: 'user', id: 'alice' }, reason: 'nightly export', resource: { type: 'task' } }]);
        expect(plan.called).to.equal(false);
      });

      it('refuses misuse at call time', () => {
        expect(() => Plain.query().accessible('plain:read')).to.throw(AuthzConfigError, /@AccessResource/);
        expect(() => Task.query().accessible('not a permission')).to.throw(AuthzConfigError, /permission/);
        expect(() => Task.query().accessible('task:read').unscoped('x')).to.throw(AuthzConfigError, /exclude each other/);
        expect(() => Task.query().unscoped('x').accessible('task:read')).to.throw(AuthzConfigError, /exclude each other/);
        expect(() => Task.query().accessible('task:read').accessible('task:update')).to.throw(AuthzConfigError, /one permission/);
        expect(() => Task.query().unscoped('')).to.throw(AuthzConfigError, /reason/);
      });

      it('a clone keeps the marks', () => {
        const q = Task.query().accessible('task:read');
        expect(marksOf(q.clone())).to.deep.equal({ accessible: 'task:read' });
      });
    });
  }
});
