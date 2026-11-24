import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AccessDenied, DecisionAudit, runWithPrincipal } from '@spinajs/authz';
import type { AccessPlan, Principal } from '@spinajs/authz';
import { RecordingAudit, testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import { HasMany, ModelBase, Relation } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';

import { AccessResource, PlanTermCompiler } from '../../src/index.js';
import { createAncestorTable, dropAncestorTable } from '../support/ancestors.js';
import { TestDb } from '../support/db.js';
import { FlagTerm } from '../support/flag-term.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const green: AccessPlan = { kind: 'filter', permit: [{ op: 'test.flag', args: { flag: 'green' } }], deny: [] };

type Post = ModelBase & { comments: Relation<ModelBase, ModelBase> };

/** A second session on the same database, outside the transaction of the sync(). */
async function secondSession(own: OrmDriver, dialect: 'mysql' | 'postgres'): Promise<OrmDriver> {
  const type = dialect === 'mysql' ? (await import('@spinajs/orm-mysql')).MySqlOrmDriver : PostgresOrmDriver;
  const driver = await DI.child().resolve<OrmDriver>(type, [{ ...own.Options, Name: `${dialect}-second-session`, Pool: { Max: 1 } }]);
  await driver.connect();
  return driver;
}

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
      let Comment: Awaited<ReturnType<TestDb['define']>>;
      let PostModel: Awaited<ReturnType<TestDb['define']>>;
      let second: OrmDriver;

      before(function () {
        if (!reachable.has(dialect)) this.skip();
      });

      beforeEach(async () => {
        undo.push(testHost.registerInRoot(PlanTermCompiler, FlagTerm), testHost.registerInRoot(DecisionAudit, testHost.instance(new RecordingAudit())));
        const service = await (await testHost.domains()).service('root');
        sinon.stub(service, 'accessPlan').resolves(green);
        testHost.config().set(['process', 'env', 'APP_ENV'], 'test');
        await createAncestorTable(db, dialect);
        const text = dialect === 'mysql' ? 'VARCHAR(64)' : 'TEXT';
        Comment = await db.define(
          {
            name: 'Comment',
            columns: { post_id: text, flag: text },
            rows: [
              { id: 'c1', post_id: 'p1', flag: 'green' },
              { id: 'c2', post_id: 'p1', flag: 'green' },
            ],
            decorate: (c) => AccessResource('comment')(c),
          },
          dialect,
        );
        const Comments = Comment;
        class PostRelations extends ModelBase {
          @HasMany(Comments, { foreignKey: 'post_id', primaryKey: 'id' })
          public comments!: Relation<ModelBase, ModelBase>;
        }
        PostModel = await db.define({ base: PostRelations, name: 'Post', columns: { title: text }, rows: [{ id: 'p1', title: 'one' }] }, dialect);
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

      const comments = async () =>
        (await db.rows(Comment))
          .filter((r) => r.post_id === 'p1')
          .map((r) => String(r.id))
          .sort();

      // Under MySQL REPEATABLE READ the app's first read fixes the snapshot; the write capture's key read before the
      // delete is FOR UPDATE, so the other session cannot commit later than here without waiting for this transaction.
      it("a denied row another session committed after the app's first read in its transaction: AccessDenied, rolled back, the row logged", async () => {
        const warn = sinon.stub(DI.resolve<Log>(Log, ['authz-orm']), 'warn');
        const make = (id: string) => new (Comment as unknown as new (d: object) => ModelBase)({ id, post_id: 'p1', flag: 'green' });

        const err = await runWithPrincipal(alice, async () =>
          db
            .driver(dialect)
            .transaction(async () => {
              const p = (await PostModel.get('p1')) as Post;
              await second.insert().into(db.table(Comment)).values({ id: 'c5', post_id: 'p1', flag: 'red' });
              p.comments.push(make('c1'), make('c9'));
              await p.comments.sync(function () {
                this.accessible('comment:delete');
              });
            })
            .then(
              () => undefined,
              (e: unknown) => e,
            ),
        );

        expect(await comments()).to.deep.equal(['c1', 'c2', 'c5']);
        expect(err).to.be.instanceOf(AccessDenied);
        expect(warn.firstCall?.args[0]).to.deep.include({ left: 1 });
      });
    });
  }
});
