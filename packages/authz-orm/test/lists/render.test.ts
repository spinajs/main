import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, GLOBAL, PlanTermSql } from '@spinajs/authz';
import type { AccessPlan, PlanTerm } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { RawQuery } from '@spinajs/orm';
import type { ModelBase, QueryBuilder } from '@spinajs/orm';

import { AccessResource, Owner, Parent } from '../../src/index.js';
import { entryOf } from '../../src/registry.js';
import { renderPlan, rowContext } from '../../src/lists/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { createAncestorTable, dropAncestorTable, insertLinks } from '../support/ancestors.js';
import { BrokenSql, FlagSql } from '../support/flag-sql.js';

const expect = chai.expect;

const flag = (f: string): PlanTerm => ({ op: 'test.flag', args: { flag: f } });
const owner = (...ids: string[]): PlanTerm => ({ op: 'relation.owner', args: { principals: ids.map((id) => ({ type: 'user', id })) } });
const filter = (p: Partial<Extract<AccessPlan, { kind: 'filter' }>>): AccessPlan => ({ kind: 'filter', permit: 'all', deny: [], ...p });

const ROWS = [
  { id: 1, flag: 'green', owner: 'alice', project_id: 'p1' },
  { id: 2, flag: 'green', owner: 'bob', project_id: 'p2' },
  { id: 3, flag: 'red', owner: 'alice', project_id: 'p1' },
  { id: 4, flag: null, owner: null, project_id: null },
];

describe('renderPlan', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  const undo: (() => void)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
    undo.push(testHost.registerInRoot(PlanTermSql, FlagSql), testHost.registerInRoot(PlanTermSql, BrokenSql));
  });

  after(async () => {
    undo.forEach((u) => u());
    // Unregistering leaves the resolved instances in the cached PlanTermSql array.
    DI.RootContainer.uncache(PlanTermSql);
    await db?.close();
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let Task: { query(): QueryBuilder } & typeof ModelBase;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        await createAncestorTable(db, dialect);
        Task = (await db.define(
          {
            name: 'Task',
            columns: { id: 'INTEGER', flag: 'TEXT', owner: 'TEXT', project_id: 'TEXT' },
            rows: ROWS,
            decorate: (c, p) => {
              AccessResource('task')(c);
              Parent('project')(p, 'project_id');
              Owner()(p, 'owner');
            },
          },
          dialect,
        )) as never;
        await insertLinks(db.driver(dialect), ['task:1>project:p1@1', 'task:1>org:o1@2', 'task:2>project:p2@1', 'task:3>project:p1@1', 'task:3>org:o1@2']);
      });

      afterEach(async () => {
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      /** Ids the rendered plan keeps, through a plain select of the table. */
      async function ids(plan: AccessPlan): Promise<number[] | 'all' | 'none'> {
        const query = Task.query();
        const row = rowContext(query, entryOf(Task)!, new Date());
        const r = renderPlan(plan, row);
        if (r.kind !== 'sql') return r.kind;
        const rows = (await db
          .driver(dialect)
          .select()
          .from(db.table(Task))
          .where(RawQuery.create(r.sql, [...r.bindings]))) as { id: number }[];
        return rows.map((x) => Number(x.id)).sort();
      }

      it('permit terms are OR-ed', async () => {
        expect(await ids(filter({ permit: [flag('green')] }))).to.deep.equal([1, 2]);
        expect(await ids(filter({ permit: [flag('red'), owner('bob')] }))).to.deep.equal([2, 3]);
        expect(await ids(filter({ permit: [] }))).to.deep.equal([]);
      });

      it('deny terms subtract; a NULL leaves the row out', async () => {
        expect(await ids(filter({ permit: [flag('green'), flag('red')], deny: [owner('bob')] }))).to.deep.equal([1, 3]);
        expect(await ids(filter({ deny: [owner('alice')] }))).to.deep.equal([2]);
      });

      it('within keeps rows that are, or descend from, a ceiling resource', async () => {
        expect(await ids(filter({ within: [{ type: 'org', id: 'o1' }] }))).to.deep.equal([1, 3]);
        expect(
          await ids(
            filter({
              within: [
                { type: 'task', id: '2' },
                { type: 'project', id: 'p1' },
              ],
            }),
          ),
        ).to.deep.equal([1, 2, 3]);
        expect(await ids(filter({ within: [{ type: 'project' }] }))).to.deep.equal([1, 2, 3]);
        expect(await ids(filter({ within: [{ type: 'task' }] }))).to.deep.equal([1, 2, 3, 4]);
        expect(await ids(filter({ within: [GLOBAL] }))).to.deep.equal([1, 2, 3, 4]);
        expect(await ids(filter({ within: [] }))).to.deep.equal([]);
        expect(await ids(filter({ permit: [flag('green')], within: [{ type: 'project', id: 'p1' }] }))).to.deep.equal([1]);
      });

      it('the sql is self-contained when AND-ed after another predicate', async () => {
        const row = rowContext(Task.query(), entryOf(Task)!, new Date());
        for (const plan of [filter({ permit: [flag('green'), flag('red')] }), filter({ permit: [owner('alice', 'bob')] })]) {
          const r = renderPlan(plan, row);
          if (r.kind !== 'sql') throw new Error(`expected sql, got ${r.kind}`);
          const rows = await db
            .driver(dialect)
            .select()
            .from(db.table(Task))
            .where(RawQuery.create(`1 = 0 AND ${r.sql}`, [...r.bindings]));
          expect(rows).to.deep.equal([]);
        }
      });

      it('all without deny and within is no filter; none is none', async () => {
        expect(await ids(filter({}))).to.equal('all');
        expect(await ids({ kind: 'none', reason: { code: 'no_access' } })).to.equal('none');
      });

      it('refuses an op without a compiler and a malformed compiler answer', async () => {
        const row = rowContext(Task.query(), entryOf(Task)!, new Date());
        expect(() => renderPlan(filter({ permit: [{ op: 'nope', args: {} }] }), row)).to.throw(AuthzConfigError, /no PlanTermSql renders op "nope"/);
        expect(() => renderPlan(filter({ permit: [{ op: 'test.broken', args: {} }] }), row)).to.throw(AuthzConfigError, /BrokenSql/);
      });

      it('the row context quotes the ancestor table and casts the id', () => {
        const row = rowContext(Task.query(), entryOf(Task)!, new Date(5));
        // orm-sqlite quotes with backticks, orm-postgres with double quotes.
        const q = (name: string) => (dialect === 'sqlite' ? `\`${name}\`` : `"${name}"`);
        expect(row.type).to.equal('task');
        expect(row.dialect).to.equal(dialect);
        expect(row.ancestorTable).to.equal(q('authz_resource_ancestor'));
        expect(row.rowId).to.equal(`CAST(${q(db.table(Task))}.${q('id')} AS TEXT)`);
        expect(row.now.getTime()).to.equal(5);
        expect(row.relation('owner')).to.deep.equal({ column: 'owner' });
        expect(row.relation('self')).to.equal(undefined);
      });
    });
  }
});
