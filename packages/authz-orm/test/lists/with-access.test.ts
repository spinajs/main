import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { PlanTermSql, runWithPrincipal } from '@spinajs/authz';
import type { AccessPlan, AuthzService, Principal } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { createAncestorTable, dropAncestorTable } from '../support/ancestors.js';
import { FlagSql } from '../support/flag-sql.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const plans: Record<string, AccessPlan> = {
  'task:read': { kind: 'filter', permit: 'all', deny: [] },
  'task:update': { kind: 'filter', permit: [{ op: 'test.flag', args: { flag: "o'green" } }], deny: [] },
  'task:delete': { kind: 'none', reason: { code: 'no_access' } },
};

type Q = Promise<(ModelBase & Record<string, unknown>)[]> & { accessible(p: string): Q; unscoped(r: string): Q; withAccess(p: string[]): Q; asRaw<T>(): Promise<T> };
type M = Omit<typeof ModelBase, 'query'> & { query(): Q };

describe('.withAccess()', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  let service: AuthzService;
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
    sinon.stub(service, 'accessPlan').callsFake(async (_p, permission) => plans[permission]);
  });

  afterEach(async () => {
    sinon.restore();
    testHost.config().unset(['authz', 'orm', 'accessField']);
    for (const fn of undo.splice(0).reverse()) fn();
    DI.RootContainer.uncache(PlanTermSql);
    await testHost.resetRoot();
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let Task: M;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        await createAncestorTable(db, dialect);
        Task = (await db.define(
          {
            name: 'Task',
            columns: { flag: 'TEXT', title: 'TEXT' },
            rows: [
              { id: 't1', flag: "o'green", title: 'a' },
              { id: 't2', flag: 'red', title: 'b' },
            ],
            decorate: (c) => AccessResource('task')(c),
          },
          dialect,
        )) as M;
      });

      afterEach(async () => {
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      const as = <T>(fn: () => Promise<T>) => runWithPrincipal(alice, fn);

      it('answers each permission per row in one query; a quote in a bound value is just data', async () => {
        const rows = await as(() => Task.query().accessible('task:read').withAccess(['task:update', 'task:delete']));
        const byId = Object.fromEntries(rows.map((r) => [r.id, r.$access]));
        expect(byId).to.deep.equal({ t1: { 'task:update': true, 'task:delete': false }, t2: { 'task:update': false, 'task:delete': false } });
        expect(rows[0].title).to.be.a('string');
        expect(Object.keys(rows[0]).some((k) => k.startsWith('__authz_access_'))).to.equal(false);
      });

      it('serialises $access with the row', async () => {
        const [row] = (await as(() => Task.query().accessible('task:read').withAccess(['task:update']))).filter((r) => r.id === 't1');
        const json = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
        expect(json.$access).to.deep.equal({ 'task:update': true });
        expect((row as unknown as { dehydrateWithRelations(): Record<string, unknown> }).dehydrateWithRelations().$access).to.deep.equal({ 'task:update': true });
      });

      it('uses authz.orm.accessField', async () => {
        testHost.config().set(['authz', 'orm', 'accessField'], 'can');
        const rows = await as(() => Task.query().withAccess(['task:update']).unscoped('admin view'));
        expect(rows.find((r) => r.id === 't1')!.can).to.deep.equal({ 'task:update': true });
        expect(rows[0].$access).to.equal(undefined);
      });

      it('asRaw keeps the raw columns', async () => {
        const raw = await as(() => Task.query().withAccess(['task:update']).unscoped('raw').asRaw<Record<string, unknown>[]>());
        expect(raw.map((r) => Number(r.__authz_access_0)).sort()).to.deep.equal([0, 1]);
      });
    });
  }
});
