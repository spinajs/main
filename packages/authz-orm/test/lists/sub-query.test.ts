import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AuthzConfigError, DecisionAudit, runWithPrincipal } from '@spinajs/authz';
import type { AccessPlan, Principal } from '@spinajs/authz';
import { RecordingAudit, testHost } from '@spinajs/authz-testing';
// Values, not types: the relation decorators read the property type from the decorator metadata.
import { BelongsTo, HasMany, HasManyToMany, ModelBase, Relation, SingleRelation } from '@spinajs/orm';

import { AccessResource, PlanTermCompiler } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { FlagTerm } from '../support/flag-term.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const bob: Principal = { type: 'user', id: 'bob', authenticated: true, source: 'test', attributes: {} };
const plans: Record<string, AccessPlan> = {
  alice: { kind: 'filter', permit: [{ op: 'test.flag', args: { flag: 'green' } }], deny: [] },
  bob: { kind: 'filter', permit: [{ op: 'test.flag', args: { flag: 'red' } }], deny: [] },
};

// Builders are thenables, not Promises.
type Q = PromiseLike<ModelBase[]> & {
  accessible(p: string): Q;
  within(r: object): Q;
  withAccess(p: string[]): Q;
  withFields(p: string): Q;
  unscoped(reason: string): Q;
  select(...c: string[]): Q;
  where(fn: (this: Q) => void): Q;
  where(column: string, value: unknown): Q;
  whereIn(c: string, v: unknown): Q;
  whereNotIn(c: string, v: unknown): Q;
  whereExist(q: unknown, cb?: (this: Q) => void): Q;
  whereNotExists(q: unknown): Q;
  innerJoin(relation: string, on: (this: Q) => void): Q;
  selectCondition(alias: string, condition: (this: Q) => void): Q;
  populate(relation: string, callback: (this: Q) => void): Q;
  take(n: number): Q;
  skip(n: number): Q;
  first(): Promise<ModelBase | undefined>;
  selectCount(): Promise<number>;
  resultExists(): Promise<boolean>;
};
type Write = PromiseLike<unknown> & { whereIn(c: string, v: unknown): Write };
type M = Omit<typeof ModelBase, 'query' | 'update' | 'destroy'> & { query(): Q; update(v: object): Write; destroy(): Write };

const ids = (rows: unknown): string[] => (rows as { id: unknown }[]).map((r) => String(r.id)).sort();

/** What the call gave: the error, or the ids (or value) it returned, so a red run shows what leaked. */
async function outcome(principal: Principal, fn: () => PromiseLike<unknown>): Promise<unknown> {
  try {
    const result = await runWithPrincipal(principal, async () => fn());
    return Array.isArray(result) ? ids(result) : result;
  } catch (e) {
    return e;
  }
}

describe('authz-orm: a marked sub-query is refused', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  const undo: (() => void)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let Task: M;
      let Plain: M;
      let Project: M;
      let TaskClass: typeof ModelBase;
      let PlainClass: typeof ModelBase;
      let executed: sinon.SinonSpy;
      let accessPlan: sinon.SinonStub;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        undo.push(testHost.registerInRoot(PlanTermCompiler, FlagTerm), testHost.registerInRoot(DecisionAudit, testHost.instance(new RecordingAudit())));
        const service = await (await testHost.domains()).service('root');
        accessPlan = sinon.stub(service, 'accessPlan').callsFake((principal: Principal) => Promise.resolve(plans[principal.id]));

        const TaskModel = await db.define(
          {
            name: 'Task',
            columns: { flag: 'TEXT', project_id: 'TEXT' },
            rows: [
              { id: 't1', flag: 'green', project_id: 'x0' },
              { id: 't2', flag: 'red', project_id: 'x1' },
            ],
            decorate: (c) => AccessResource('task')(c),
          },
          dialect,
        );
        TaskClass = TaskModel;
        Task = TaskModel as M;
        class PlainLinks extends ModelBase {
          @BelongsTo(TaskModel, 'task_id', 'id')
          public task!: SingleRelation<ModelBase>;
        }
        const PlainModel = await db.define(
          {
            base: PlainLinks,
            name: 'Plain',
            columns: { task_id: 'TEXT', note: 'TEXT' },
            rows: [
              { id: 'p1', task_id: 't1', note: 'a' },
              { id: 'p2', task_id: 't2', note: 'b' },
            ],
          },
          dialect,
        );
        PlainClass = PlainModel;
        Plain = PlainModel as M;
        const ProjectTask = await db.define(
          {
            name: 'ProjectTask',
            columns: { project_id: 'TEXT', task_id: 'TEXT' },
            rows: [
              { id: 'j1', project_id: 'x0', task_id: 't1' },
              { id: 'j2', project_id: 'x1', task_id: 't2' },
            ],
          },
          dialect,
        );
        class ProjectLinks extends ModelBase {
          @HasMany(TaskModel, { foreignKey: 'project_id', primaryKey: 'id' })
          public tasks!: Relation<ModelBase, ModelBase>;

          @HasManyToMany(ProjectTask, TaskModel, { targetModelPKey: 'id', sourceModelPKey: 'id', junctionModelTargetPk: 'task_id', junctionModelSourcePk: 'project_id' })
          public linked!: Relation<ModelBase, ModelBase>;
        }
        Project = (await db.define(
          {
            base: ProjectLinks,
            name: 'Project',
            columns: { title: 'TEXT' },
            rows: [
              { id: 'x0', title: 'zero' },
              { id: 'x1', title: 'one' },
            ],
          },
          dialect,
        )) as M;
        executed = sinon.spy(db.driver(dialect), 'execute');
      });

      afterEach(async () => {
        sinon.restore();
        for (const fn of undo.splice(0).reverse()) fn();
        await testHost.resetRoot();
        await db.clear();
      });

      const taskIds = () => Task.query().select('id');
      const readable = () => taskIds().accessible('task:read');

      /** Each form embeds `.accessible()` on Task; a dropped mark lets t2's row (or its existence) through for alice. */
      const forms: Record<string, () => PromiseLike<unknown>> = {
        'whereIn(column, query)': () => Plain.query().whereIn('task_id', readable()),
        'whereNotIn(column, query)': () => Plain.query().whereNotIn('task_id', readable()),
        'whereExist(query)': () => Plain.query().whereExist(Task.query().accessible('task:read').where('id', 't2')),
        'whereNotExists(query)': () => Plain.query().whereNotExists(Task.query().accessible('task:read').where('id', 't2')),
        "whereExist('belongsTo', callback)": () =>
          Plain.query().whereExist('task', function () {
            this.accessible('task:read');
          }),
        "whereExist('hasMany', callback)": () =>
          Project.query().whereExist('tasks', function () {
            this.accessible('task:read');
          }),
        "whereExist('manyToMany', callback) with the query inside the join": () =>
          Project.query().whereExist('linked', function () {
            this.whereIn('id', readable());
          }),
        'a nested group': () =>
          Plain.query().where(function () {
            this.whereIn('task_id', readable());
          }),
        'an unmarked sub-query holding the marked one': () => Plain.query().whereIn('task_id', taskIds().whereIn('id', readable())),
        'a join callback': () =>
          Plain.query().innerJoin('task', function () {
            this.whereIn('id', readable());
          }),
        'a condition column': () =>
          Plain.query()
            .select('*')
            .selectCondition('visible', function () {
              this.whereIn('task_id', readable());
            }),
        'a to-one populate callback': () =>
          Plain.query().populate('task', function () {
            this.whereIn('id', readable());
          }),
        'first()': () => Plain.query().where('id', 'p2').whereIn('task_id', readable()).first(),
        'selectCount()': () => Plain.query().whereIn('task_id', readable()).selectCount(),
        'resultExists()': () => Plain.query().where('id', 'p2').whereIn('task_id', readable()).resultExists(),
        'a page': () => Plain.query().whereIn('task_id', readable()).take(10).skip(0),
        '.within()': () => Plain.query().whereIn('task_id', taskIds().within({ type: 'project', id: 'x0' })),
        '.withAccess()': () => Plain.query().whereIn('task_id', taskIds().withAccess(['task:read'])),
        '.withFields()': () => Plain.query().whereIn('task_id', taskIds().withFields('task:read')),
      };

      for (const [form, run] of Object.entries(forms)) {
        it(`${form}: AuthzConfigError before any SQL is sent, for both principals`, async () => {
          for (const principal of [alice, bob]) {
            const result = await outcome(principal, run);
            expect(result, `${principal.id} got ${JSON.stringify(result)}`).to.be.instanceOf(AuthzConfigError);
            expect((result as Error).message).to.match(/on a sub-query of Task_\d+_\d+ (is not applied|has no effect)/);
            expect(executed.callCount, `${principal.id}: statements sent`).to.equal(0);
          }
        });
      }

      it('update and delete with a marked sub-query are refused and change no row', async () => {
        const before = await db.rows(PlainClass);
        for (const principal of [alice, bob]) {
          const update = await outcome(principal, () => Plain.update({ note: 'changed' }).whereIn('task_id', readable()));
          const remove = await outcome(principal, () => Plain.destroy().whereIn('task_id', readable()));
          expect(update, `update as ${principal.id}`).to.be.instanceOf(AuthzConfigError);
          expect(remove, `delete as ${principal.id}`).to.be.instanceOf(AuthzConfigError);
        }
        expect(executed.callCount).to.equal(0);
        expect(await db.rows(PlainClass)).to.deep.equal(before);
      });

      it('the message names the mark and the model, and says what to do instead', async () => {
        const result = await outcome(alice, forms['whereIn(column, query)']);
        expect((result as Error).message).to.match(/^authz-orm: \.accessible\("task:read"\) on a sub-query of Task_\d+_\d+ is not applied on this version/);
        expect((result as Error).message).to.contain('pass them to whereIn() as values');
        for (const [extra, run] of Object.entries(forms).filter(([form]) => form === '.withAccess()' || form === '.withFields()')) {
          const columns = (await outcome(alice, run)) as Error;
          expect(columns.message, extra).to.match(/on a sub-query of Task_\d+_\d+ has no effect: it adds columns/);
          expect(columns.message, extra).to.contain('Remove it from the sub-query; to filter by access, execute');
        }
      });

      it('an unmarked sub-query runs as before, with the same SQL', async () => {
        const quote = (n: string) => (dialect === 'sqlite' ? `\`${n}\`` : `"${n}"`);
        const plain = db.table(PlainClass);
        const task = db.table(TaskClass);
        expect(await outcome(alice, () => Plain.query().whereIn('task_id', taskIds().where('flag', 'red')))).to.deep.equal(['p2']);
        const sql = (executed.firstCall.args[0] as { toDB(): { expression: string } }).toDB().expression;
        expect(sql).to.equal(`SELECT * FROM ${quote(plain)} WHERE ${quote('task_id')} IN ( SELECT ${quote('id')} FROM ${quote(task)} WHERE ${quote('flag')} = ? )`);
      });

      it('.unscoped() on a sub-query is not refused: it asks for no filter', async () => {
        expect(await outcome(alice, () => Plain.query().whereIn('task_id', taskIds().unscoped('report')))).to.deep.equal(['p1', 'p2']);
      });

      it('a mark on the outer query still filters, with an unmarked sub-query inside', async () => {
        const outer = () => Task.query().accessible('task:read').whereIn('id', Plain.query().select('task_id'));
        expect(await outcome(alice, outer)).to.deep.equal(['t1']);
        expect(await outcome(bob, outer)).to.deep.equal(['t2']);
      });

      it('a marked outer query with a marked sub-query is refused before any plan is fetched', async () => {
        accessPlan.resetHistory();
        expect(await outcome(alice, () => Task.query().accessible('task:read').whereIn('id', readable()))).to.be.instanceOf(AuthzConfigError);
        expect(accessPlan.callCount).to.equal(0);
      });

      it('the alternative: the ids of an executed .accessible() select, passed as values', async () => {
        const visible = async () => {
          const permitted = ids(await Task.query().select('id').accessible('task:read'));
          return Plain.query().whereIn('task_id', permitted);
        };
        expect(await outcome(alice, visible)).to.deep.equal(['p1']);
        expect(await outcome(bob, visible)).to.deep.equal(['p2']);
      });
    });
  }
});
