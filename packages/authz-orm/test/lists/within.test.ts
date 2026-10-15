import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AuthzConfigError, GLOBAL, PlanTermSql, runWithPrincipal } from '@spinajs/authz';
import type { AccessPlan, AuthzService, Principal, ResourceRef } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource } from '../../src/index.js';
import { marksOf } from '../../src/marker.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { createAncestorTable, dropAncestorTable, insertLinks } from '../support/ancestors.js';
import { FlagSql } from '../support/flag-sql.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const green: AccessPlan = { kind: 'filter', permit: [{ op: 'test.flag', args: { flag: 'green' } }], deny: [] };
const T1: ResourceRef = { type: 'team', id: 't1' };
const T2: ResourceRef = { type: 'team', id: 't2' };
const G1: ResourceRef = { type: 'group', id: 'g1' };

type Refs = ResourceRef | readonly ResourceRef[];
type Q = PromiseLike<ModelBase[]> & { within(r: Refs): Q; accessible(p: string): Q; unscoped(r: string): Q; where(...a: unknown[]): Q; orWhere(...a: unknown[]): Q; clone(): Q };
type W = PromiseLike<unknown> & { within(r: Refs): W };
type M = typeof ModelBase & { query(): Q; where(...a: unknown[]): Q; update(v: object): W; destroy(pk?: unknown): W };

const ids = (rows: ModelBase[]) => rows.map((r) => String((r as unknown as { id: unknown }).id)).sort();

// d5 belongs to t3, a sub-team of t1; d4 belongs to nothing.
const LINKS = ['doc:d1>team:t1@1', 'doc:d2>group:g1@1', 'doc:d2>team:t1@2', 'doc:d3>team:t2@1', 'doc:d5>team:t3@1', 'doc:d5>team:t1@2'];
const ROWS = [
  { id: 'd1', flag: 'green', title: 'a' },
  { id: 'd2', flag: 'red', title: 'b' },
  { id: 'd3', flag: 'green', title: 'c' },
  { id: 'd4', flag: 'green', title: 'd' },
  { id: 'd5', flag: 'green', title: 'e' },
];

describe('.within()', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  let service: AuthzService;
  let plan: sinon.SinonStub;
  const undo: (() => void)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    undo.push(testHost.registerInRoot(PlanTermSql, FlagSql));
    service = await (await testHost.domains()).service('root');
    plan = sinon.stub(service, 'accessPlan').resolves(green);
  });

  afterEach(async () => {
    sinon.restore();
    testHost.config().unset(['process', 'env', 'APP_ENV']);
    for (const fn of undo.splice(0).reverse()) fn();
    await testHost.resetRoot();
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let Doc: M;
      let Plain: M;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        await createAncestorTable(db, dialect);
        Doc = (await db.define({ name: 'Doc', columns: { flag: 'TEXT', title: 'TEXT' }, rows: ROWS, decorate: (c) => AccessResource('doc')(c) }, dialect)) as M;
        Plain = (await db.define({ name: 'Plain', columns: { title: 'TEXT' } }, dialect)) as M;
        await insertLinks(db.driver(dialect), LINKS);
      });

      afterEach(async () => {
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      // Builders are thenables, not Promises.
      const as = <T>(fn: () => PromiseLike<T>) => runWithPrincipal(alice, async () => fn());
      const listed = (q: () => Q) => as(async () => ids(await q().unscoped('within test')));

      it('keeps the rows that are the ref or descend from it, whatever its type', async () => {
        expect(await listed(() => Doc.query().within(T1))).to.deep.equal(['d1', 'd2', 'd5']);
        expect(await listed(() => Doc.query().within(G1))).to.deep.equal(['d2']);
        expect(await listed(() => Doc.query().within({ type: 'doc', id: 'd4' }))).to.deep.equal(['d4']);
        expect(plan.called).to.equal(false);
      });

      it('refs of one call are OR-ed, calls are AND-ed; [] keeps nothing, GLOBAL everything', async () => {
        expect(await listed(() => Doc.query().within([G1, T2]))).to.deep.equal(['d2', 'd3']);
        expect(await listed(() => Doc.query().within([T2, { type: 'doc', id: 'd4' }]))).to.deep.equal(['d3', 'd4']);
        expect(await listed(() => Doc.query().within(T1).within(G1))).to.deep.equal(['d2']);
        expect(await listed(() => Doc.query().within([]))).to.deep.equal([]);
        expect(await listed(() => Doc.query().within(GLOBAL))).to.deep.equal(['d1', 'd2', 'd3', 'd4', 'd5']);
      });

      it("keeps the caller's where in one group: an orWhere cannot widen it", async () => {
        expect(await listed(() => Doc.where('id', 'd3').orWhere('id', 'd1').within(T1))).to.deep.equal(['d1']);
      });

      it('ANDs with .accessible(): a row must be in the scope and allowed', async () => {
        expect(ids(await as(() => Doc.query().within(T1).accessible('doc:read')))).to.deep.equal(['d1', 'd5']);
        expect(ids(await as(() => Doc.query().accessible('doc:read').within([G1, T2])))).to.deep.equal(['d3']);
        expect(plan.firstCall.args.slice(0, 3)).to.deep.equal([alice, 'doc:read', 'doc']);
      });

      it('narrows updates and deletes', async () => {
        await as(() => Doc.update({ title: 'x' }).within(T1));
        expect(
          (await db.rows(Doc))
            .filter((r) => r.title === 'x')
            .map((r) => r.id)
            .sort(),
        ).to.deep.equal(['d1', 'd2', 'd5']);
        // The ORM refuses a destroy() without primary keys; every id is listed so only .within() narrows.
        await as(() => Doc.destroy(['d1', 'd2', 'd3', 'd4', 'd5']).within(G1));
        expect((await db.rows(Doc)).map((r) => r.id).sort()).to.deep.equal(['d1', 'd3', 'd4', 'd5']);
      });

      it('is no access filter: in test the runtime guard still asks for .accessible() on a select', async () => {
        testHost.config().set(['process', 'env', 'APP_ENV'], 'test');
        let err: unknown;
        try {
          await as(async () => await Doc.query().within(T1));
        } catch (e) {
          err = e;
        }
        expect(err).to.be.instanceOf(AuthzConfigError);
        expect((err as Error).message).to.match(/\.accessible\(permission\), \.unscoped\(reason\) or runAs\(SYSTEM\)/);
      });

      it('refuses misuse at call time', () => {
        expect(() => Plain.query().within(T1)).to.throw(AuthzConfigError, /@AccessResource/);
        for (const bad of [null, {}, { type: '' }, { type: 'team', id: 5 }, [T1, 'team:t2']]) {
          expect(() => Doc.query().within(bad as never), JSON.stringify(bad)).to.throw(AuthzConfigError, /\.within\(\): a ref is \{ type, id\? \}/);
        }
      });

      it('a clone keeps the refs', () => {
        expect(marksOf(Doc.query().within(T1).within([G1, T2]).clone())).to.deep.equal({ within: [[T1], [G1, T2]] });
      });
    });
  }
});
