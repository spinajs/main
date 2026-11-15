import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { authzStorage, rowFieldsOf, runWithPrincipal } from '@spinajs/authz';
import type { AccessPlan, AuthzService, Decision, Principal } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IWhereBuilder, ModelBase } from '@spinajs/orm';

import { AccessResource, PlanTermCompiler } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { createAncestorTable, dropAncestorTable } from '../support/ancestors.js';

const expect = chai.expect;

/** The row's `flag` is one of `args.flags`; one atom per flag, as RBAC splits one per role. */
class FlagsTerm extends PlanTermCompiler {
  readonly op = 'test.flags';

  apply(args: unknown, where: IWhereBuilder<unknown>): void {
    where.whereIn('flag', [...(args as { flags: string[] }).flags]);
  }

  atoms(args: unknown): readonly unknown[] {
    return (args as { flags: string[] }).flags.map((flag) => ({ flags: [flag] }));
  }
}

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const FIELDS: Record<string, string[]> = { t1: ['id', 'title'], t2: ['id'], t3: ['title'], t4: ['secret'] };
const plans: Record<string, AccessPlan> = {
  'task:read': { kind: 'filter', permit: [{ op: 'test.flags', args: { flags: ['green', 'red'] } }], deny: [{ op: 'test.flags', args: { flags: ['black'] } }] },
  'task:list': { kind: 'filter', permit: 'all', deny: [] },
  'task:delete': { kind: 'none', reason: { code: 'no_access' } },
};

type Row = ModelBase & Record<string, unknown>;
type Q = Promise<Row[]> & { accessible(p: string): Q; unscoped(r: string): Q; withFields(p: string): Q; where(c: string, v: unknown): Q; asRaw<T>(): Promise<T> };
type M = Omit<typeof ModelBase, 'query'> & { query(): Q };

describe('.withFields()', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  let service: AuthzService;
  let checkAll: sinon.SinonStub<Parameters<AuthzService['checkAll']>, ReturnType<AuthzService['checkAll']>>;
  const undo: (() => void)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    undo.push(testHost.registerInRoot(PlanTermCompiler, FlagsTerm));
    service = await (await testHost.domains()).service('root');
    sinon.stub(service, 'accessPlan').callsFake(async (_p, permission) => plans[permission]);
    checkAll = sinon.stub(service, 'checkAll').callsFake(async (_p, requests) => requests.map((r) => ({ allowed: r.resource.id !== 't4', fields: { read: FIELDS[r.resource.id!], write: [] } }) as unknown as Decision));
  });

  afterEach(async () => {
    sinon.restore();
    for (const fn of undo.splice(0).reverse()) fn();
    DI.RootContainer.uncache(PlanTermCompiler);
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
              { id: 't1', flag: 'green', title: 'a' },
              { id: 't2', flag: 'red', title: 'b' },
              { id: 't3', flag: 'green', title: 'c' },
              { id: 't4', flag: 'black', title: 'd' },
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
      const fieldsById = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.id as string, rowFieldsOf(r)]));

      it('decides once per group of rows matching the same atoms, in one batched call, and gives the group its field set', async () => {
        const rows = await as(() => Task.query().withFields('task:read').unscoped('test'));

        expect(checkAll.callCount).to.equal(1);
        expect(checkAll.firstCall.args[1].map((r) => r.resource.id).sort()).to.deep.equal(['t1', 't2', 't4']);
        expect(fieldsById(rows)).to.deep.equal({ t1: ['id', 'title'], t2: ['id'], t3: ['id', 'title'], t4: [] });
        expect(Object.keys(rows[0]).some((k) => k.startsWith('__authz_fields_'))).to.equal(false);
      });

      it('makes one group of a plan without terms', async () => {
        const rows = await as(() => Task.query().withFields('task:list').unscoped('test'));

        expect(checkAll.firstCall.args[1]).to.have.length(1);
        expect(new Set(rows.map((r) => JSON.stringify(rowFieldsOf(r)))).size).to.equal(1);
      });

      it('gives every row of a none plan no field, without a decision', async () => {
        const rows = await as(() => Task.query().withFields('task:delete').unscoped('test'));

        expect(checkAll.callCount).to.equal(0);
        expect(rows.map((r) => rowFieldsOf(r))).to.deep.equal([[], [], [], []]);
      });

      it('asks for no decision when no row comes back', async () => {
        expect(await as(() => Task.query().withFields('task:read').where('id', 'none').unscoped('test'))).to.have.length(0);
        expect(checkAll.callCount).to.equal(0);
      });

      it(".accessible() lists get row field sets under a fields: 'filter-rows' request (AuthzRowFields)", async () => {
        const rows = await as(() => authzStorage().run({ ...authzStorage().getStore(), AuthzRowFields: true }, async () => Task.query().accessible('task:read')));

        expect(fieldsById(rows)).to.deep.equal({ t1: ['id', 'title'], t2: ['id'], t3: ['id', 'title'] });
      });

      it('.accessible() alone attaches no field set', async () => {
        const rows = await as(() => Task.query().accessible('task:read'));

        expect(rows.map((r) => rowFieldsOf(r))).to.deep.equal([undefined, undefined, undefined]);
        expect(checkAll.callCount).to.equal(0);
      });
    });
  }
});
