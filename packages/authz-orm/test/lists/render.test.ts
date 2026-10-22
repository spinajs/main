import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { AccessPlan, PlanTerm } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { ModelBase, QueryBuilder } from '@spinajs/orm';

import { AccessResource, Owner, Parent, PlanTermCompiler } from '../../src/index.js';
import { entryOf } from '../../src/registry.js';
import { planFilter, planRow } from '../../src/lists/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { createAncestorTable, dropAncestorTable, insertLinks } from '../support/ancestors.js';
import { EmptyGroupTerm, FlagTerm, SilentTerm } from '../support/flag-term.js';

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

describe('planFilter', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  const undo: (() => void)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
    undo.push(testHost.registerInRoot(PlanTermCompiler, FlagTerm), testHost.registerInRoot(PlanTermCompiler, SilentTerm), testHost.registerInRoot(PlanTermCompiler, EmptyGroupTerm));
  });

  after(async () => {
    undo.forEach((u) => u());
    // Unregistering leaves the resolved instances in the cached PlanTermCompiler array.
    DI.RootContainer.uncache(PlanTermCompiler);
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

      const select = () => db.driver(dialect).select().from(db.table(Task));

      /** Ids a plain select of the table keeps under the filter. */
      async function ids(plan: AccessPlan): Promise<number[] | 'all' | 'none'> {
        const f = planFilter(plan, planRow(Task.query(), entryOf(Task)!));
        if (f.kind !== 'where') return f.kind;
        const rows = await select()
          .where(function () {
            f.apply(this);
          })
          .asRaw<{ id: number }[]>();
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

      it('the filter stays one group when AND-ed after another predicate', async () => {
        const row = planRow(Task.query(), entryOf(Task)!);
        for (const plan of [filter({ permit: [flag('green'), flag('red')] }), filter({ permit: [owner('alice', 'bob')] })]) {
          const f = planFilter(plan, row);
          if (f.kind !== 'where') throw new Error(`expected where, got ${f.kind}`);
          const rows = await select()
            .where(false)
            .where(function () {
              f.apply(this);
            })
            .asRaw();
          expect(rows).to.deep.equal([]);
        }
      });

      it('all without deny and within is no filter; none is none', async () => {
        expect(await ids(filter({}))).to.equal('all');
        expect(await ids({ kind: 'none', reason: { code: 'no_access' } })).to.equal('none');
      });

      it('refuses an op without a compiler and a compiler that adds no condition', () => {
        const row = planRow(Task.query(), entryOf(Task)!);
        const apply = (plan: AccessPlan) => () => {
          const f = planFilter(plan, row);
          if (f.kind === 'where')
            select().where(function () {
              f.apply(this);
            });
        };
        expect(apply(filter({ permit: [{ op: 'nope', args: {} }] }))).to.throw(AuthzConfigError, /no PlanTermCompiler applies op "nope"/);
        expect(apply(filter({ permit: [{ op: 'test.silent', args: {} }] }))).to.throw(AuthzConfigError, /SilentTerm\.apply\(\) for op "test\.silent" added no condition/);
        expect(apply(filter({ permit: [{ op: 'test.empty-group', args: {} }] }))).to.throw(AuthzConfigError, /EmptyGroupTerm\.apply\(\) for op "test\.empty-group" added no condition/);
        expect(apply(filter({ deny: [{ op: 'test.empty-group', args: {} }] }))).to.throw(AuthzConfigError, /added no condition/);
      });
    });
  }
});
