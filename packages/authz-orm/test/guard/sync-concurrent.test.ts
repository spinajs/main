import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AccessDenied, DecisionAudit, runWithPrincipal } from '@spinajs/authz';
import type { AccessPlan, Principal } from '@spinajs/authz';
import { RecordingAudit, testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import { BelongsTo, HasMany, HasManyToMany, ModelBase, QueryMiddleware, Relation, SelectQueryBuilder, SingleRelation } from '@spinajs/orm';
import type { OrmDriver, QueryBuilder } from '@spinajs/orm';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';

import { AccessResource, PlanTermCompiler } from '../../src/index.js';
import { createAncestorTable, dropAncestorTable } from '../support/ancestors.js';
import { TestDb } from '../support/db.js';
import { FlagTerm } from '../support/flag-term.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const green: AccessPlan = { kind: 'filter', permit: [{ op: 'test.flag', args: { flag: 'green' } }], deny: [] };

type List = Relation<ModelBase, ModelBase>;
type Post = ModelBase & { comments: List; tags: List };
type Model = Awaited<ReturnType<TestDb['define']>>;

/** A second session on the same database, outside the transaction of the sync(). */
async function secondSession(own: OrmDriver, dialect: 'mysql' | 'postgres'): Promise<OrmDriver> {
  const type = dialect === 'mysql' ? (await import('@spinajs/orm-mysql')).MySqlOrmDriver : PostgresOrmDriver;
  const driver = await DI.child().resolve<OrmDriver>(type, [{ ...own.Options, Name: `${dialect}-second-session`, Pool: { Max: 1 } }]);
  await driver.connect();
  return driver;
}

const settle = (p: PromiseLike<unknown>): Promise<unknown> =>
  Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );

describe("authz-orm guard: a relation list's sync() beside a concurrent transaction", function () {
  this.timeout(60000);
  let db: TestDb;
  const reachable = new Set<'mysql' | 'postgres'>();
  const undo: (() => void)[] = [];

  before(async function () {
    if (await TestDb.mysqlReachable()) reachable.add('mysql');
    if (await TestDb.postgresReachable()) reachable.add('postgres');
    if (reachable.size === 0) return this.skip();
    db = await TestDb.open({ mysql: reachable.has('mysql'), postgres: reachable.has('postgres') });
  });

  after(async () => {
    await db?.close();
  });

  for (const dialect of ['mysql', 'postgres'] as const) {
    describe(dialect, () => {
      let Comment: Model;
      let PostTag: Model;
      let Tag: Model;
      let PostModel: Model;
      let second: OrmDriver;
      let warn: sinon.SinonStub;

      before(function () {
        if (!reachable.has(dialect)) this.skip();
      });

      beforeEach(async () => {
        undo.push(testHost.registerInRoot(PlanTermCompiler, FlagTerm), testHost.registerInRoot(DecisionAudit, testHost.instance(new RecordingAudit())));
        const service = await (await testHost.domains()).service('root');
        sinon.stub(service, 'accessPlan').resolves(green);
        warn = sinon.stub(DI.resolve<Log>(Log, ['authz-orm']), 'warn');
        testHost.config().set(['process', 'env', 'APP_ENV'], 'test');
        await createAncestorTable(db, dialect);
        const text = dialect === 'mysql' ? 'VARCHAR(64)' : 'TEXT';
        const comment = (id: string) => ({ id, post_id: 'p1', flag: 'green' });
        Comment = await db.define({ name: 'Comment', columns: { post_id: text, flag: text }, rows: [comment('c1'), comment('c2')], decorate: (c) => AccessResource('comment')(c) }, dialect);
        Tag = await db.define({ name: 'Tag', columns: { name: text }, rows: ['g1', 'r1', 'n1', 'x1'].map((id) => ({ id, name: id })) }, dialect);
        const LinkedTag = Tag;
        PostTag = await db.define(
          {
            name: 'PostTag',
            columns: { id: dialect === 'mysql' ? 'INT AUTO_INCREMENT' : 'SERIAL', post_id: text, tag_id: text, flag: text },
            rows: [
              { id: 101, post_id: 'p1', tag_id: 'g1', flag: 'green' },
              { id: 102, post_id: 'p1', tag_id: 'r1', flag: 'green' },
            ],
            decorate: (c, proto) => {
              AccessResource('post_tag')(c);
              Reflect.defineMetadata('design:type', SingleRelation, proto, 'tag');
              (BelongsTo(LinkedTag, 'tag_id', 'id') as PropertyDecorator)(proto, 'tag');
            },
          },
          dialect,
        );
        const Comments = Comment;
        const Junction = PostTag;
        class PostRelations extends ModelBase {
          @HasMany(Comments, { foreignKey: 'post_id', primaryKey: 'id' })
          public comments!: Relation<ModelBase, ModelBase>;

          @HasManyToMany(Junction, LinkedTag, { targetModelPKey: 'id', sourceModelPKey: 'id', junctionModelTargetPk: 'tag_id', junctionModelSourcePk: 'post_id' })
          public tags!: Relation<ModelBase, ModelBase>;
        }
        PostModel = await db.define(
          {
            base: PostRelations,
            name: 'Post',
            columns: { title: text },
            rows: [{ id: 'p1', title: 'one' }],
            decorate: (c) => {
              Reflect.defineMetadata('design:type', SingleRelation, Junction.prototype, 'post');
              (BelongsTo(c, 'post_id', 'id') as PropertyDecorator)(Junction.prototype, 'post');
            },
          },
          dialect,
        );
        second = await secondSession(db.driver(dialect), dialect);
      });

      afterEach(async () => {
        testHost.config().unset(['process', 'env', 'APP_ENV']);
        sinon.restore();
        for (const fn of undo.splice(0).reverse()) fn();
        await second?.disconnect();
        await testHost.resetRoot();
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      const ofP1 = async (model: Model, column: string) =>
        (await db.rows(model))
          .filter((r) => r.post_id === 'p1')
          .map((r) => String(Reflect.get(r, column)))
          .sort();

      // The app's read fixes the snapshot of a REPEATABLE READ transaction; the other session commits after it.
      it("one-to-many: a denied row another session committed after the app's first read in its transaction: AccessDenied, rolled back, the row logged", async () => {
        const make = (id: string) => new (Comment as unknown as new (d: object) => ModelBase)({ id, post_id: 'p1', flag: 'green' });
        const isolation = dialect === 'mysql' ? 'REPEATABLE READ' : 'READ COMMITTED';

        const err = await runWithPrincipal(alice, () =>
          settle(
            db.driver(dialect).transaction(async () => {
              const p = (await PostModel.get('p1')) as Post;
              await second.insert().into(db.table(Comment)).values({ id: 'c5', post_id: 'p1', flag: 'red' });
              p.comments.push(make('c1'), make('c9'));
              await p.comments.sync(function () {
                this.accessible('comment:delete');
              });
            }, { isolation }),
          ),
        );

        expect(await ofP1(Comment, 'id')).to.deep.equal(['c1', 'c2', 'c5']);
        expect(err).to.be.instanceOf(AccessDenied);
        expect(warn.firstCall?.args[0]).to.deep.include({ left: 1 });
      });

      // No app transaction: the sync()'s own plain select of the existing links fixes the snapshot, and nothing
      // locks the owner's junction rows until the write capture's key read before the delete.
      it('many-to-many: a denied link another session committed after the sync() read the existing links: AccessDenied, rolled back, the row logged', async function () {
        if (dialect === 'mysql') {
          const [{ iso }] = (await db.raw('SELECT @@GLOBAL.transaction_isolation AS iso', [], 'mysql')) as { iso: string }[];
          if (iso !== 'REPEATABLE-READ') return this.skip();
        }
        const junction = PostTag;
        const table = db.table(PostTag);
        const other = second;
        let committed = false;
        class OtherSession extends QueryMiddleware {
          afterQueryCreation(): void {}
          beforeQueryExecution(): void {}
          async afterQueryExecution(query: QueryBuilder): Promise<void> {
            if (committed || query.Model !== junction || !(query instanceof SelectQueryBuilder)) return;
            committed = true;
            await other.insert().into(table).values({ id: 150, post_id: 'p1', tag_id: 'x1', flag: 'red' });
          }
        }
        DI.register(OtherSession).as(QueryMiddleware);
        DI.uncache(Array.ofType(QueryMiddleware));
        undo.push(() => {
          DI.unregister(OtherSession);
          DI.uncache(OtherSession);
          DI.uncache(Array.ofType(QueryMiddleware));
        });
        const p = (await runWithPrincipal(alice, async () => PostModel.get('p1'))) as Post;
        const tag = (id: string) => new (Tag as unknown as new (d: object) => ModelBase)({ id, name: id });
        p.tags.push(tag('g1'), tag('n1'));

        const err = await runWithPrincipal(alice, () =>
          settle(
            p.tags.sync(function () {
              this.accessible('post_tag:delete');
            }),
          ),
        );

        expect(committed).to.equal(true);
        expect(await ofP1(PostTag, 'tag_id')).to.deep.equal(['g1', 'r1', 'x1']);
        expect(err).to.be.instanceOf(AccessDenied);
        expect(warn.firstCall?.args[0]).to.deep.include({ left: 1 });
      });
    });
  }
});
