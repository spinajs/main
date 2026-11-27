import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { runWithPrincipal } from '@spinajs/authz';
import type { AccessPlan, AuthzService, Principal } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { Archived, RawQuery, SoftDelete } from '@spinajs/orm';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource, PlanTermCompiler } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { FlagTerm } from '../support/flag-term.js';

const expect = chai.expect;

const principal = (id: string): Principal => ({ type: 'user', id, authenticated: true, source: 'test', attributes: {} });
const alice = principal('alice');
const bob = principal('bob');
const flag = (value: string): AccessPlan => ({ kind: 'filter', permit: [{ op: 'test.flag', args: { flag: value } }], deny: [] });

type Q = PromiseLike<ModelBase[]> & { accessible(p: string): Q; where(...a: unknown[]): Q; orWhere(...a: unknown[]): Q; withDeleted(): Q };
type M = typeof ModelBase & { query(): Q; where(...a: unknown[]): Q };

const ids = (rows: ModelBase[]) => rows.map((r) => String((r as unknown as { id: unknown }).id)).sort();

// alice reads green rows, bob red ones. t4 and t5 are soft-deleted, t6 is archived.
const ROWS = [
  { id: 't1', flag: 'green', title: 'a' },
  { id: 't2', flag: 'red', title: 'b' },
  { id: 't3', flag: 'green', title: 'c' },
  { id: 't4', flag: 'red', title: 'd', deleted_at: '2026-01-01T00:00:00.000Z' },
  { id: 't5', flag: 'green', title: 'e', deleted_at: '2026-01-01T00:00:00.000Z' },
  { id: 't6', flag: 'red', title: 'f', archived_at: '2026-01-01T00:00:00.000Z' },
];

describe('.accessible() on a soft-delete and archive model: an OR reaches neither past the plan nor past the scopes', function () {
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
    undo.push(testHost.registerInRoot(PlanTermCompiler, FlagTerm));
    service = await (await testHost.domains()).service('root');
    sinon.stub(service, 'accessPlan').callsFake(async (p: Principal) => flag(p.id === 'alice' ? 'green' : 'red'));
  });

  afterEach(async () => {
    sinon.restore();
    for (const fn of undo.splice(0).reverse()) fn();
    await testHost.resetRoot();
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let Task: M;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        Task = await db.define(
          {
            name: 'Task',
            columns: { flag: 'TEXT', title: 'TEXT', deleted_at: 'TEXT', archived_at: 'TEXT' },
            rows: ROWS,
            decorate: (c, proto) => {
              AccessResource('task')(c);
              (SoftDelete() as PropertyDecorator)(proto, 'deleted_at');
              (Archived() as PropertyDecorator)(proto, 'archived_at');
            },
          },
          dialect,
        );
      });

      afterEach(async () => {
        await db.clear();
      });

      const as = <T>(who: Principal, fn: () => PromiseLike<T>) => runWithPrincipal(who, async () => fn());

      it('an orWhere on the key of a deleted row returns nothing, for either principal', async () => {
        expect(ids(await as(alice, () => Task.query().orWhere('id', 't5').accessible('task:read')))).to.deep.equal([]);
        expect(ids(await as(bob, () => Task.query().orWhere('id', 't4').accessible('task:read')))).to.deep.equal([]);
      });

      it('an orWhere between two conditions returns only live permitted rows', async () => {
        expect(ids(await as(alice, () => Task.where('title', 'a').orWhere('title', 'e').orWhere('title', 'b').accessible('task:read')))).to.deep.equal(['t1']);
        expect(ids(await as(bob, () => Task.where('title', 'b').orWhere('title', 'd').orWhere('title', 'f').orWhere('title', 'a').accessible('task:read')))).to.deep.equal(['t2']);
      });

      it('a raw OR 1 = 1 returns only live permitted rows', async () => {
        expect(ids(await as(alice, () => Task.where(RawQuery.create('1 = 0 OR 1 = 1')).accessible('task:read')))).to.deep.equal(['t1', 't3']);
        expect(ids(await as(bob, () => Task.where(RawQuery.create('1 = 0 OR 1 = 1')).accessible('task:read')))).to.deep.equal(['t2']);
      });

      it('withDeleted() lets the permitted deleted rows in, and still no forbidden one', async () => {
        expect(ids(await as(alice, () => Task.query().withDeleted().where('title', 'a').orWhere('title', 'e').orWhere('title', 'd').accessible('task:read')))).to.deep.equal(['t1', 't5']);
      });
    });
  }
});
