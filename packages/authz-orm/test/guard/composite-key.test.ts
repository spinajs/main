import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, TRUE, authzStorage } from '@spinajs/authz';
import type { Decision, Principal } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { SoftDelete } from '@spinajs/orm';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };

type W = PromiseLike<ModelBase[]> & { first(): Promise<ModelBase | undefined>; selectCount(): Promise<number>; where(...a: unknown[]): W; whereIn(...a: unknown[]): W; orWhere(...a: unknown[]): W };
type M = typeof ModelBase & { query(): W; where(...a: unknown[]): W; get(pk: unknown): Promise<ModelBase>; findOrFail(pks: unknown[]): Promise<ModelBase[]> };

// The route's check-before allowed alice to read one line unconditionally; o1/l2 is bob's.
const decided = { allowed: true, permission: 'line:read', resource: { type: 'line', id: 'o1' }, residual: TRUE } as unknown as Decision;
const inRoute = <T>(fn: () => PromiseLike<T>) => authzStorage().run({ Principal: alice, AuthzDecision: decided }, async () => fn());

const settle = async (fn: () => PromiseLike<unknown>): Promise<unknown> => {
  try {
    return await inRoute(fn);
  } catch (e) {
    return e;
  }
};

const keysOf = (columns: readonly string[]) => (rows: unknown): string[] => (Array.isArray(rows) ? rows : [rows]).map((r: Record<string, unknown>) => columns.map((c) => String(r[c])).join('/')).sort();
const lineKeys = keysOf(['order_id', 'id']);
const cellKeys = keysOf(['sheet', 'col', 'id']);

describe('authz-orm guard: a composite key is a single-object load only when every key column is bound', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let Line: M;
      let Cell: M;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        Line = await db.define(
          {
            name: 'Line',
            columns: { order_id: 'TEXT', owner: 'TEXT', deleted_at: 'TEXT' },
            primary: ['order_id', 'id'],
            rows: [
              { order_id: 'o1', id: 'l1', owner: 'alice' },
              { order_id: 'o1', id: 'l2', owner: 'bob' },
              { order_id: 'o2', id: 'l1', owner: 'alice' },
            ],
            decorate: (c, proto) => {
              AccessResource('line')(c);
              (SoftDelete() as PropertyDecorator)(proto, 'deleted_at');
            },
          },
          dialect,
        );
        Cell = await db.define(
          {
            name: 'Cell',
            columns: { sheet: 'TEXT', col: 'TEXT' },
            primary: ['sheet', 'col', 'id'],
            rows: [
              { sheet: 's1', col: 'c1', id: 'r1' },
              { sheet: 's1', col: 'c1', id: 'r2' },
              { sheet: 's1', col: 'c2', id: 'r1' },
            ],
            decorate: (c) => AccessResource('cell')(c),
          },
          dialect,
        );
        testHost.config().set(['process', 'env', 'APP_ENV'], 'test');
      });

      afterEach(async () => {
        testHost.config().unset(['process', 'env', 'APP_ENV']);
        await db.clear();
      });

      it("flags a select that binds only the first key column: it would read bob's line of the same order", async () => {
        expect(await settle(() => Line.where('order_id', 'o1'))).to.be.instanceOf(AuthzConfigError);
        expect(await settle(() => Line.query().whereIn('order_id', ['o1']))).to.be.instanceOf(AuthzConfigError);
      });

      it('flags a select that binds only the second key column', async () => {
        expect(await settle(() => Line.where('id', 'l1'))).to.be.instanceOf(AuthzConfigError);
      });

      it('lets a select that binds every key column through, in any order, with exactly that row', async () => {
        expect(lineKeys(await inRoute(() => Line.where('order_id', 'o1').where('id', 'l2')))).to.deep.equal(['o1/l2']);
        expect(lineKeys(await inRoute(() => Line.where('id', 'l1').where('order_id', 'o2')))).to.deep.equal(['o2/l1']);
        expect(lineKeys(await inRoute(() => Line.query().whereIn('order_id', ['o1']).where('id', 'l1')))).to.deep.equal(['o1/l1']);
      });

      it('flags a whole key widened by an orWhere', async () => {
        expect(await settle(() => Line.where('order_id', 'o1').where('id', 'l1').orWhere('id', 'l2'))).to.be.instanceOf(AuthzConfigError);
        expect(await settle(() => Line.where('order_id', 'o1').orWhere('id', 'l1'))).to.be.instanceOf(AuthzConfigError);
      });

      it('flags a whole key whose second column is bound by IN with two values or by >', async () => {
        expect(await settle(() => Line.where('order_id', 'o1').whereIn('id', ['l1', 'l2']))).to.be.instanceOf(AuthzConfigError);
        expect(await settle(() => Line.where('order_id', 'o1').where('id', '>', 'l0'))).to.be.instanceOf(AuthzConfigError);
      });

      it('applies the same rule to first() and selectCount()', async () => {
        expect(await settle(() => Line.where('order_id', 'o1').first())).to.be.instanceOf(AuthzConfigError);
        expect(await settle(() => Line.where('order_id', 'o1').selectCount())).to.be.instanceOf(AuthzConfigError);
        expect(lineKeys(await inRoute(() => Line.where('order_id', 'o1').where('id', 'l2').first()))).to.deep.equal(['o1/l2']);
        expect(await inRoute(() => Line.where('order_id', 'o1').where('id', 'l2').selectCount())).to.equal(1);
      });

      it('keeps get() and findOrFail() of a composite key a list: the ORM binds the key inside a nested group', async () => {
        expect(await settle(() => Line.get(['o1', 'l2']))).to.be.instanceOf(AuthzConfigError);
        expect(await settle(() => Line.get({ order_id: 'o1', id: 'l2' }))).to.be.instanceOf(AuthzConfigError);
        expect(await settle(() => Line.findOrFail([['o1', 'l2']]))).to.be.instanceOf(AuthzConfigError);
      });

      it('flags two bound columns of a three-column key and lets all three through', async () => {
        expect(await settle(() => Cell.where('sheet', 's1').where('col', 'c1'))).to.be.instanceOf(AuthzConfigError);
        expect(await settle(() => Cell.where('sheet', 's1').where('id', 'r1'))).to.be.instanceOf(AuthzConfigError);
        expect(cellKeys(await inRoute(() => Cell.where('sheet', 's1').where('col', 'c1').where('id', 'r2')))).to.deep.equal(['s1/c1/r2']);
      });
    });
  }
});
