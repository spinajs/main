import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AccessDenied, DecisionAudit, runWithPrincipal } from '@spinajs/authz';
import type { AccessPlan, Principal } from '@spinajs/authz';
import { RecordingAudit, testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import { DeleteQueryBuilder, HasMany, ModelBase, QueryMiddleware, Relation, SelectQueryBuilder } from '@spinajs/orm';
import type { QueryBuilder } from '@spinajs/orm';

import { AccessResource, PlanTermCompiler } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import { createAncestorTable, dropAncestorTable } from '../support/ancestors.js';
import { FlagTerm } from '../support/flag-term.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const green: AccessPlan = { kind: 'filter', permit: [{ op: 'test.flag', args: { flag: 'green' } }], deny: [] };

type Model = Awaited<ReturnType<TestDb['define']>>;
type Post = ModelBase & { comments: Relation<ModelBase, ModelBase> };
type Row = Readonly<Record<string, unknown>>;

const settle = async (fn: () => PromiseLike<unknown>): Promise<unknown> => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e;
  }
};

// The model's table is in `main`, the connection's own database; `s` is attached next to it with a table of the same name.
describe('authz-orm guard: a sync() statement that names a database', function () {
  this.timeout(60000);
  let db: TestDb;
  let plan: sinon.SinonStub;
  const undo: (() => void)[] = [];
  let Comment: Model;
  let PostModel: Model;

  before(async () => {
    db = await TestDb.open();
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    undo.push(testHost.registerInRoot(PlanTermCompiler, FlagTerm), testHost.registerInRoot(DecisionAudit, testHost.instance(new RecordingAudit())));
    const service = await (await testHost.domains()).service('root');
    plan = sinon.stub(service, 'accessPlan').resolves(green);
    testHost.config().set(['process', 'env', 'APP_ENV'], 'test');
    await createAncestorTable(db, 'sqlite');

    Comment = await db.define({
      name: 'Comment',
      columns: { post_id: 'TEXT', flag: 'TEXT' },
      rows: [{ id: 'c1', post_id: 'p1', flag: 'green' }],
      decorate: (c) => AccessResource('comment')(c),
    });
    const Comments = Comment;
    class PostRelations extends ModelBase {
      @HasMany(Comments, { foreignKey: 'post_id', primaryKey: 'id' })
      public comments!: Relation<ModelBase, ModelBase>;
    }
    PostModel = await db.define({ base: PostRelations, name: 'Post', columns: { title: 'TEXT' }, rows: [{ id: 'p1', title: 'one' }] });

    await db.raw("ATTACH DATABASE ':memory:' AS s");
    await db.raw(`CREATE TABLE s."${db.table(Comment)}" ("id" TEXT PRIMARY KEY, "post_id" TEXT, "flag" TEXT)`);
  });

  afterEach(async () => {
    testHost.config().unset(['process', 'env', 'APP_ENV']);
    sinon.restore();
    for (const fn of undo.splice(0).reverse()) fn();
    await testHost.resetRoot();
    await db.raw('DETACH DATABASE s');
    await db.clear();
    await dropAncestorTable(db, 'sqlite');
  });

  const inMain = async (rows: readonly Row[]) => {
    for (const row of rows) await db.insertRaw(Comment, row);
  };
  const inS = async (rows: readonly Row[]) => {
    for (const row of rows) await db.raw(`INSERT INTO s."${db.table(Comment)}" ("id", "post_id", "flag") VALUES (?, ?, ?)`, [row.id, row.post_id, row.flag]);
  };
  const ids = (rows: Record<string, unknown>[]) => rows.map((r) => String(r.id)).sort();
  const mainIds = async () => ids(await db.rows(Comment));
  const sIds = async () => ids((await db.raw(`SELECT * FROM s."${db.table(Comment)}"`)) as Record<string, unknown>[]);

  /** The SQL of every statement on Comment that executed, in order. */
  const record = (): string[] => {
    const executed: string[] = [];
    const target = Comment;
    class SqlRecorder extends QueryMiddleware {
      afterQueryCreation(): void {}
      beforeQueryExecution(): void {}
      afterQueryExecution(query: QueryBuilder): void {
        if (query.Model === target && (query instanceof SelectQueryBuilder || query instanceof DeleteQueryBuilder)) executed.push(query.toDB().expression ?? '');
      }
    }
    DI.register(SqlRecorder).as(QueryMiddleware);
    DI.uncache(Array.ofType(QueryMiddleware));
    undo.push(() => {
      DI.unregister(SqlRecorder);
      DI.uncache(SqlRecorder);
      DI.uncache(Array.ofType(QueryMiddleware));
    });
    return executed;
  };
  /** The statements after the sync's delete: the check's reads. */
  const afterDelete = (executed: readonly string[]) => executed.slice(executed.findIndex((sql) => sql.startsWith('DELETE')) + 1);

  /** sync() of p1's comments keeping c1, under .accessible('comment:delete'), the orphan delete on `database` when given. */
  const sync = (database?: string) =>
    runWithPrincipal(alice, async () => {
      const post = (await PostModel.get('p1')) as Post;
      post.comments.push(new (Comment as unknown as new (d: object) => ModelBase)({ id: 'c1', post_id: 'p1', flag: 'green' }));
      await post.comments.sync(function () {
        this.accessible('comment:delete');
        if (database !== undefined && this instanceof DeleteQueryBuilder) this.database(database);
      });
    });

  it(".database('s') that removed every orphan in s: runs, though main still holds rows of p1", async () => {
    await inMain([
      { id: 'c2', post_id: 'p1', flag: 'green' },
      { id: 'c3', post_id: 'p1', flag: 'red' },
    ]);
    await inS([
      { id: 'c1', post_id: 'p1', flag: 'green' },
      { id: 'c2', post_id: 'p1', flag: 'green' },
    ]);
    const executed = record();

    await sync('s');

    expect(await sIds()).to.deep.equal(['c1']);
    expect(await mainIds()).to.deep.equal(['c1', 'c2', 'c3']);
    expect(afterDelete(executed)).to.deep.equal([`SELECT \`id\` FROM \`s\`.\`${db.table(Comment)}\` WHERE \`post_id\` = ? AND \`id\` NOT IN (?) LIMIT ?`]);
  });

  it(".database('s') that left a denied orphan in s: AccessDenied, rolled back, the row in s logged, though main holds none", async () => {
    await inS([
      { id: 'c1', post_id: 'p1', flag: 'green' },
      { id: 'c2', post_id: 'p1', flag: 'green' },
      { id: 'c3', post_id: 'p1', flag: 'red' },
    ]);
    const warn = sinon.stub(DI.resolve<Log>(Log, ['authz-orm']), 'warn');

    const err = await settle(() => sync('s'));

    expect(await sIds()).to.deep.equal(['c1', 'c2', 'c3']);
    expect(await mainIds()).to.deep.equal(['c1']);
    expect(err).to.be.instanceOf(AccessDenied);
    expect(warn.callCount).to.equal(1);
    expect(warn.firstCall.args[0]).to.deep.include({ model: Comment.name, permission: 'comment:delete', left: 1 });
  });

  it('without .database(): the check reads the model database, its SQL unchanged', async () => {
    await inMain([
      { id: 'c2', post_id: 'p1', flag: 'green' },
      { id: 'c3', post_id: 'p1', flag: 'red' },
    ]);
    await inS([{ id: 'c2', post_id: 'p1', flag: 'green' }]);
    const executed = record();

    const err = await settle(() => sync());

    expect(err).to.be.instanceOf(AccessDenied);
    expect(await mainIds()).to.deep.equal(['c1', 'c2', 'c3']);
    expect(await sIds()).to.deep.equal(['c2']);
    const table = db.table(Comment);
    expect(afterDelete(executed)).to.deep.equal([`SELECT \`id\` FROM \`${table}\` WHERE \`post_id\` = ? AND \`id\` NOT IN (?) LIMIT ?`, `SELECT \`id\` FROM \`${table}\` WHERE \`post_id\` = ? AND \`id\` NOT IN (?)`]);
    expect(plan.called).to.equal(true);
  });
});
