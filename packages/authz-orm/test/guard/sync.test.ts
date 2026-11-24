import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AccessDenied, AuthzConfigError, DecisionAudit, SYSTEM, authz, authzStorage, runWithPrincipal } from '@spinajs/authz';
import type { AccessPlan, Principal } from '@spinajs/authz';
import { RecordingAudit, testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { Log, renderTemplate } from '@spinajs/log-common';
import { BelongsTo, DeleteQueryBuilder, HasMany, HasManyToMany, InsertQueryBuilder, ModelBase, QueryMiddleware, Relation, SelectQueryBuilder, SingleRelation, SoftDelete, UpdateQueryBuilder } from '@spinajs/orm';
import type { QueryBuilder } from '@spinajs/orm';

import { AccessResource, PlanTermCompiler } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import { createAncestorTable, dropAncestorTable } from '../support/ancestors.js';
import { FlagTerm } from '../support/flag-term.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const green: AccessPlan = { kind: 'filter', permit: [{ op: 'test.flag', args: { flag: 'green' } }], deny: [] };

type List = Relation<ModelBase, ModelBase>;
type Post = ModelBase & { comments: List; tags: List; notes: List; drafts: List };
type Model = Awaited<ReturnType<TestDb['define']>>;
type Callback = NonNullable<Parameters<List['sync']>[0]>;

const statementOf = (q: QueryBuilder): string => {
  if (q instanceof SelectQueryBuilder) return 'select';
  if (q instanceof InsertQueryBuilder) return 'insert';
  if (q instanceof UpdateQueryBuilder) return 'update';
  return q instanceof DeleteQueryBuilder ? 'delete' : 'other';
};

const settle = async (fn: () => PromiseLike<unknown>): Promise<unknown> => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e;
  }
};

/** One relation kind: the model its sync() writes, the list it syncs and the rows of post p1 it leaves. */
interface Kind {
  readonly title: string;
  readonly permission: string;
  readonly type: string;
  readonly relation: 'comments' | 'tags' | 'drafts';
  model(): Model;
  /** The list of p1 with its kept row, the red orphan when `keepRed`, and one new row. */
  fill(post: Post, keepRed: boolean): void;
  /** The list of p1 with every row it holds: a sync() without orphans. */
  fillAll(post: Post): void;
  /** Ids of what p1 holds: comment ids, the tag ids of its links, draft ids with `~` before a stamped one. */
  state(): Promise<string[]>;
  /** The statements on `model()` a sync() of `fill(post, false)` executes, in order; the select right before a delete is the write capture's key read (AncestorObserver). */
  readonly statements: readonly string[];
  /** A red row of p1 that only exists once the orphan statement is about to run. */
  readonly lateRow: Readonly<Record<string, unknown>>;
  readonly before: readonly string[];
  /** After a sync that removed both orphans, and after one that kept the red one. */
  readonly synced: readonly string[];
  readonly syncedKeepingRed: readonly string[];
}

describe("authz-orm guard: a relation list's sync()", function () {
  this.timeout(60000);
  let db: TestDb;
  let audit: RecordingAudit;
  let plan: sinon.SinonStub;
  const undo: (() => void)[] = [];
  const appEnv = process.env.APP_ENV;
  let Comment: Model;
  let PostTag: Model;
  let Tag: Model;
  let Note: Model;
  let Draft: Model;
  let PostModel: Model;

  before(async () => {
    db = await TestDb.open();
  });

  after(async () => {
    await db?.close();
    if (appEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = appEnv;
  });

  beforeEach(async () => {
    audit = new RecordingAudit();
    undo.push(testHost.registerInRoot(PlanTermCompiler, FlagTerm), testHost.registerInRoot(DecisionAudit, testHost.instance(audit)));
    const service = await (await testHost.domains()).service('root');
    plan = sinon.stub(service, 'accessPlan').resolves(green);
    await createAncestorTable(db, 'sqlite');

    Comment = await db.define({
      name: 'Comment',
      columns: { post_id: 'TEXT', flag: 'TEXT' },
      rows: [
        { id: 'c1', post_id: 'p1', flag: 'green' },
        { id: 'c2', post_id: 'p1', flag: 'green' },
        { id: 'c3', post_id: 'p1', flag: 'red' },
        { id: 'c4', post_id: 'p2', flag: 'red' },
      ],
      decorate: (c) => AccessResource('comment')(c),
    });
    Note = await db.define({ name: 'Note', columns: { post_id: 'TEXT' }, rows: [{ id: 'n1', post_id: 'p1' }] });
    Tag = await db.define({ name: 'Tag', columns: { name: 'TEXT' }, rows: ['g1', 'r1', 'b1', 'n1'].map((id) => ({ id, name: id })) });
    const LinkedTag = Tag;
    PostTag = await db.define({
      name: 'PostTag',
      columns: { id: 'INTEGER', post_id: 'TEXT', tag_id: 'TEXT', flag: 'TEXT' },
      rows: [
        { id: 1, post_id: 'p1', tag_id: 'g1', flag: 'green' },
        { id: 2, post_id: 'p1', tag_id: 'r1', flag: 'green' },
        { id: 3, post_id: 'p1', tag_id: 'b1', flag: 'red' },
        { id: 4, post_id: 'p2', tag_id: 'g1', flag: 'red' },
      ],
      decorate: (c, proto) => {
        AccessResource('post_tag')(c);
        Reflect.defineMetadata('design:type', SingleRelation, proto, 'tag');
        (BelongsTo(LinkedTag, 'tag_id', 'id') as PropertyDecorator)(proto, 'tag');
      },
    });
    Draft = await db.define({
      name: 'Draft',
      columns: { post_id: 'TEXT', flag: 'TEXT', deleted_at: 'TEXT' },
      rows: [
        { id: 'd1', post_id: 'p1', flag: 'green' },
        { id: 'd2', post_id: 'p1', flag: 'green' },
        { id: 'd3', post_id: 'p1', flag: 'red' },
      ],
      decorate: (c, proto) => {
        AccessResource('draft')(c);
        (SoftDelete() as PropertyDecorator)(proto, 'deleted_at');
      },
    });
    const Junction = PostTag;
    const Comments = Comment;
    const Notes = Note;
    const Drafts = Draft;
    class PostRelations extends ModelBase {
      @HasMany(Comments, { foreignKey: 'post_id', primaryKey: 'id' })
      public comments!: Relation<ModelBase, ModelBase>;

      @HasMany(Notes, { foreignKey: 'post_id', primaryKey: 'id' })
      public notes!: Relation<ModelBase, ModelBase>;

      @HasMany(Drafts, { foreignKey: 'post_id', primaryKey: 'id' })
      public drafts!: Relation<ModelBase, ModelBase>;

      @HasManyToMany(Junction, LinkedTag, { targetModelPKey: 'id', sourceModelPKey: 'id', junctionModelTargetPk: 'tag_id', junctionModelSourcePk: 'post_id' })
      public tags!: Relation<ModelBase, ModelBase>;
    }
    PostModel = await db.define({
      base: PostRelations,
      name: 'Post',
      columns: { title: 'TEXT' },
      rows: [{ id: 'p1', title: 'one' }],
      // The junction's belongsTo to the owner needs the owner's final class, which exists only here.
      decorate: (c) => {
        Reflect.defineMetadata('design:type', SingleRelation, Junction.prototype, 'post');
        (BelongsTo(c, 'post_id', 'id') as PropertyDecorator)(Junction.prototype, 'post');
      },
    });
  });

  afterEach(async () => {
    testHost.config().unset(['process', 'env', 'APP_ENV']);
    sinon.restore();
    for (const fn of undo.splice(0).reverse()) fn();
    await testHost.resetRoot();
    await db.clear();
    await dropAncestorTable(db, 'sqlite');
  });

  const env = (value: string) => testHost.config().set(['process', 'env', 'APP_ENV'], value);
  const as = <T>(fn: () => PromiseLike<T>) => runWithPrincipal(alice, async () => fn());
  const post = async () => (await as(() => PostModel.get('p1'))) as Post;
  const register = (middleware: new () => QueryMiddleware) => {
    DI.register(middleware).as(QueryMiddleware);
    DI.uncache(Array.ofType(QueryMiddleware));
    // The DI registry and cache key a class by its name, and every test defines its middleware under the same one.
    undo.push(() => {
      DI.unregister(middleware);
      DI.uncache(middleware);
      DI.uncache(Array.ofType(QueryMiddleware));
    });
  };
  /** The statements on `model` that executed, in order. */
  const record = (model: Model): string[] => {
    const executed: string[] = [];
    class Recorder extends QueryMiddleware {
      afterQueryCreation(): void {}
      beforeQueryExecution(): void {}
      afterQueryExecution(query: QueryBuilder): void {
        if (query.Model === model) executed.push(statementOf(query));
      }
    }
    register(Recorder);
    return executed;
  };
  /** The row lock of every select on `model` that executed, in order. */
  const recordLocks = (model: Model): string[] => {
    const locks: string[] = [];
    class LockRecorder extends QueryMiddleware {
      afterQueryCreation(): void {}
      beforeQueryExecution(): void {}
      afterQueryExecution(query: QueryBuilder): void {
        if (query.Model === model && query instanceof SelectQueryBuilder) locks.push(query.RowLock ?? 'none');
      }
    }
    register(LockRecorder);
    return locks;
  };

  const kinds: readonly Kind[] = [
    {
      title: 'one-to-many list of an @AccessResource target',
      permission: 'comment:delete',
      type: 'comment',
      relation: 'comments',
      model: () => Comment,
      fill: (p, keepRed) => {
        const make = (id: string, flag: string) => new (Comment as unknown as new (d: object) => ModelBase)({ id, post_id: 'p1', flag });
        p.comments.push(make('c1', 'green'), ...(keepRed ? [make('c3', 'red')] : []), make('c9', 'green'));
      },
      fillAll: (p) => {
        const make = (id: string, flag: string) => new (Comment as unknown as new (d: object) => ModelBase)({ id, post_id: 'p1', flag });
        p.comments.push(make('c1', 'green'), make('c2', 'green'), make('c3', 'red'));
      },
      state: async () =>
        (await db.rows(Comment))
          .filter((r) => r.post_id === 'p1')
          .map((r) => String(r.id))
          .sort(),
      before: ['c1', 'c2', 'c3'],
      synced: ['c1', 'c9'],
      syncedKeepingRed: ['c1', 'c3', 'c9'],
      statements: ['insert', 'insert', 'select', 'delete'],
      lateRow: { id: 'c5', post_id: 'p1', flag: 'red' },
    },
    {
      title: 'many-to-many list of an @AccessResource junction model',
      permission: 'post_tag:delete',
      type: 'post_tag',
      relation: 'tags',
      model: () => PostTag,
      fill: (p, keepRed) => {
        const tag = (id: string) => new (Tag as unknown as new (d: object) => ModelBase)({ id, name: id });
        p.tags.push(tag('g1'), ...(keepRed ? [tag('b1')] : []), tag('n1'));
      },
      fillAll: (p) => {
        const tag = (id: string) => new (Tag as unknown as new (d: object) => ModelBase)({ id, name: id });
        p.tags.push(tag('g1'), tag('r1'), tag('b1'));
      },
      state: async () =>
        (await db.rows(PostTag))
          .filter((r) => r.post_id === 'p1')
          .map((r) => String(r.tag_id))
          .sort(),
      before: ['b1', 'g1', 'r1'],
      synced: ['g1', 'n1'],
      syncedKeepingRed: ['b1', 'g1', 'n1'],
      statements: ['select', 'insert', 'select', 'delete'],
      lateRow: { id: 50, post_id: 'p1', tag_id: 'x1', flag: 'red' },
    },
    {
      title: 'one-to-many list of a @SoftDelete @AccessResource target',
      permission: 'draft:delete',
      type: 'draft',
      relation: 'drafts',
      model: () => Draft,
      fill: (p, keepRed) => {
        const make = (id: string, flag: string) => new (Draft as unknown as new (d: object) => ModelBase)({ id, post_id: 'p1', flag });
        p.drafts.push(make('d1', 'green'), ...(keepRed ? [make('d3', 'red')] : []), make('d9', 'green'));
      },
      fillAll: (p) => {
        const make = (id: string, flag: string) => new (Draft as unknown as new (d: object) => ModelBase)({ id, post_id: 'p1', flag });
        p.drafts.push(make('d1', 'green'), make('d2', 'green'), make('d3', 'red'));
      },
      state: async () =>
        (await db.rows(Draft))
          .filter((r) => r.post_id === 'p1')
          .map((r) => `${r.deleted_at === null ? '' : '~'}${String(r.id)}`)
          .sort(),
      before: ['d1', 'd2', 'd3'],
      synced: ['d1', 'd9', '~d2', '~d3'],
      syncedKeepingRed: ['d1', 'd3', 'd9', '~d2'],
      statements: ['insert', 'insert', 'update'],
      lateRow: { id: 'd5', post_id: 'p1', flag: 'red' },
    },
  ];

  const within = (kind: Kind) => `authz-orm: .within() left ${kind.model().name} rows behind in sync() of ${PostModel.name}.${kind.relation}; a sync() is never partial`;

  for (const kind of kinds) {
    describe(kind.title, () => {
      const sync = async (keepRed: boolean, callback?: Callback) => {
        const p = await post();
        kind.fill(p, keepRed);
        await p[kind.relation].sync(callback);
      };
      const message = () => `authz-orm: sync() of ${PostModel.name}.${kind.relation} writes ${kind.model().name} (@AccessResource '${kind.type}') without .accessible(permission), .unscoped(reason) or runAs(SYSTEM)`;

      it('unmarked in the test env: AuthzConfigError with the owner, the relation and the model, nothing written', async () => {
        env('test');
        const err = await as(() => settle(() => sync(false)));

        expect(err).to.be.instanceOf(AuthzConfigError);
        expect((err as Error).message).to.equal(message());
        expect(await kind.state()).to.deep.equal(kind.before);
      });

      it('unmarked in production: runs', async () => {
        env('production');
        await as(() => sync(false));

        expect(await kind.state()).to.deep.equal(kind.synced);
      });

      it('unmarked under runAs(SYSTEM) and in a route marked @Unscoped: runs', async () => {
        env('test');
        await as(() => authz().runAs(SYSTEM, 'nightly import', () => sync(true)));
        expect(await kind.state()).to.deep.equal(kind.syncedKeepingRed);

        await authzStorage().run({ Principal: alice, Unscoped: 'import route' }, () => sync(false));
        expect(await kind.state()).to.deep.equal(kind.synced);
      });

      it('.accessible(p) with a plan that allows every orphan: runs, the orphans are gone', async () => {
        env('test');
        const permission = kind.permission;
        await as(() =>
          sync(true, function () {
            this.accessible(permission);
          }),
        );

        expect(await kind.state()).to.deep.equal(kind.syncedKeepingRed);
        expect(plan.firstCall.args.slice(0, 3)).to.deep.equal([alice, permission, kind.type]);
      });

      it('.accessible(p) with a plan that allows every row: runs the statements of an unguarded sync() and no count', async () => {
        env('test');
        plan.resolves({ kind: 'filter', permit: 'all', deny: [] });
        const executed = record(kind.model());
        const permission = kind.permission;
        await as(() =>
          sync(false, function () {
            this.accessible(permission);
          }),
        );

        expect(await kind.state()).to.deep.equal(kind.synced);
        expect(executed).to.deep.equal(kind.statements);
      });

      it('.accessible(p) with a plan that leaves one orphan out: AccessDenied after the write, rolled back, the rows left logged', async () => {
        env('test');
        const warn = sinon.stub(DI.resolve<Log>(Log, ['authz-orm']), 'warn');
        const executed = record(kind.model());
        const locks = recordLocks(kind.model());
        const permission = kind.permission;
        const err = await as(() =>
          settle(() =>
            sync(false, function () {
              this.accessible(permission);
            }),
          ),
        );

        expect(err).to.be.instanceOf(AccessDenied);
        // a plain read of a REPEATABLE READ snapshot misses rows committed since
        expect(locks.slice(-2)).to.deep.equal(['share', 'share']);
        expect((err as Error).message).to.equal(`Access denied: ${permission} on ${kind.type} (no_access)`);
        expect((err as AccessDenied).decision.permission).to.equal(permission);
        expect((err as AccessDenied).decision.reason).to.deep.equal({ code: 'no_access' });
        expect(await kind.state()).to.deep.equal(kind.before);
        // the one-row check, then the read of every row left for the log
        expect(executed).to.deep.equal([...kind.statements, 'select', 'select']);
        expect(warn.callCount).to.equal(1);
        expect(warn.firstCall.args[0]).to.deep.equal({ owner: PostModel.name, relation: kind.relation, model: kind.model().name, permission, left: 1 });
      });

      it('.accessible(p) with a plan that leaves one orphan out: the check ignores what a middleware adds to selects at creation', async () => {
        env('test');
        const target = kind.model();
        class GreenSelects extends QueryMiddleware {
          afterQueryCreation(query: QueryBuilder): void {
            if (query instanceof SelectQueryBuilder && query.Model === target) query.where('flag', 'green');
          }
          beforeQueryExecution(): void {}
        }
        register(GreenSelects);
        const permission = kind.permission;
        const err = await as(() =>
          settle(() =>
            sync(false, function () {
              this.accessible(permission);
            }),
          ),
        );

        expect(err).to.be.instanceOf(AccessDenied);
        expect(await kind.state()).to.deep.equal(kind.before);
      });

      it('.accessible(p) with a plan that allows every orphan, and a denied row written after the filter was added: AccessDenied, rolled back', async () => {
        env('test');
        const target = kind.model();
        const late = kind.lateRow;
        // Stands in for another transaction that commits a row between the filter and the write.
        class LateRow extends QueryMiddleware {
          public order = 101;
          afterQueryCreation(): void {}
          async beforeQueryExecution(query: QueryBuilder): Promise<void> {
            if (query.Model === target && (query instanceof DeleteQueryBuilder || query instanceof UpdateQueryBuilder)) await db.insertRaw(target, late);
          }
        }
        register(LateRow);
        const permission = kind.permission;
        const err = await as(() =>
          settle(() =>
            sync(true, function () {
              this.accessible(permission);
            }),
          ),
        );

        expect(err).to.be.instanceOf(AccessDenied);
        expect(await kind.state()).to.deep.equal(kind.before);
      });

      for (const onNone of [undefined, 'empty'] as const) {
        it(`.accessible(p${onNone ? ", { onNone: 'empty' }" : ''}) with a none plan: AccessDenied before the write`, async () => {
          env('test');
          plan.resolves({ kind: 'none', reason: { code: 'no_access' } });
          const executed = record(kind.model());
          const permission = kind.permission;
          const err = await as(() =>
            settle(() =>
              sync(false, function () {
                this.accessible(permission, onNone ? { onNone } : undefined);
              }),
            ),
          );

          expect(err).to.be.instanceOf(AccessDenied);
          expect((err as Error).message).to.equal(`Access denied: ${permission} on ${kind.type} (no_access)`);
          expect(await kind.state()).to.deep.equal(kind.before);
          expect(executed).to.deep.equal(kind.statements.slice(0, -1));
        });
      }

      it(".accessible(p, { onNone: 'empty' }) with a none plan and no orphans: AccessDenied", async () => {
        env('test');
        plan.resolves({ kind: 'none', reason: { code: 'no_access' } });
        const permission = kind.permission;
        const err = await as(async () => {
          const p = await post();
          kind.fillAll(p);
          return settle(() =>
            p[kind.relation].sync(function () {
              this.accessible(permission, { onNone: 'empty' });
            }),
          );
        });

        expect(err).to.be.instanceOf(AccessDenied);
        expect((err as Error).message).to.equal(`Access denied: ${permission} on ${kind.type} (no_access)`);
      });

      it('.unscoped(reason): runs unfiltered and audits the statement once', async () => {
        env('test');
        await as(() =>
          sync(false, function () {
            this.unscoped('replace the list');
          }),
        );
        await new Promise((resolve) => setImmediate(resolve));

        expect(await kind.state()).to.deep.equal(kind.synced);
        expect(audit.of('unscoped')).to.deep.equal([{ kind: 'unscoped', principal: { type: 'user', id: 'alice' }, reason: 'replace the list', resource: { type: kind.type } }]);
        expect(plan.called).to.equal(false);
      });

      it('.within() that would keep an orphan: AuthzConfigError, nothing written', async () => {
        env('production');
        const err = await as(() =>
          settle(() =>
            sync(false, function () {
              this.within({ type: 'project', id: 'p9' });
            }),
          ),
        );

        expect(err).to.be.instanceOf(AuthzConfigError);
        expect((err as Error).message).to.equal(within(kind));
        expect(await kind.state()).to.deep.equal(kind.before);
      });
    });
  }

  describe('unmarked in development', () => {
    let warn: sinon.SinonStub;
    const texts = () => warn.getCalls().map((c) => renderTemplate(c.args[1] as string, c.args[0] as unknown as Record<string, unknown>));
    const prefix = (kind: Kind) => `authz-orm: sync() of ${PostModel.name}.${kind.relation} writes ${kind.model().name} (@AccessResource '${kind.type}') without .accessible(permission), .unscoped(reason) or runAs(SYSTEM) (`;
    const filled = async (kind: Kind) => {
      const p = await post();
      kind.fill(p, false);
      return p;
    };

    beforeEach(() => {
      env('development');
      process.env.APP_ENV = 'development';
      warn = sinon.stub(DI.resolve<Log>(Log, ['authz-orm']), 'warn');
    });

    // warnOnce remembers a call site for the process, so every sync() below has a line of its own. Inside the app's
    // transaction each sync() takes a savepoint, whose awaits keep the app's async function on the stack.
    it('warns once per call site, names the app line, and the sync runs', async () => {
      const tx = (fn: () => Promise<void>) => as(() => db.driver().transaction(fn));
      for (let i = 0; i < 2; i++) {
        const p = await filled(kinds[0]);
        await tx(async () => {
          await p.comments.sync();
        });
      }
      const again = await filled(kinds[0]);
      await tx(async () => {
        await again.comments.sync();
      });
      const tags = await filled(kinds[1]);
      await tx(async () => {
        await tags.tags.sync();
      });

      const all = texts();
      expect(all.map((t, i) => t.startsWith(prefix(kinds[i < 2 ? 0 : 1])))).to.deep.equal([true, true, true]);
      for (const t of all) expect(t, t).to.match(/guard[\\/]sync\.test\.ts:\d+:\d+/);
      expect(new Set(all).size).to.equal(3);
      expect(await kinds[0].state()).to.deep.equal(kinds[0].synced);
      expect(await kinds[1].state()).to.deep.equal(kinds[1].synced);
    });

    it("warns once per relation where a driver's transaction queue hides the app line", async () => {
      for (const kind of kinds) {
        for (let i = 0; i < 2; i++) {
          const p = await filled(kind);
          await as(() => p[kind.relation].sync());
        }
      }

      expect(texts()).to.deep.equal(kinds.map((kind) => `${prefix(kind)}"unknown call site")`));
      expect(await kinds[0].state()).to.deep.equal(kinds[0].synced);
    });
  });

  it('.accessible(p) whose plan allows every row, with a .within() that would keep an orphan: AuthzConfigError', async () => {
    env('test');
    plan.resolves({ kind: 'filter', permit: 'all', deny: [] });
    const p = await post();
    kinds[0].fill(p, false);
    const err = await as(() =>
      settle(() =>
        p.comments.sync(function () {
          this.accessible('comment:delete').within({ type: 'project', id: 'p9' });
        }),
      ),
    );

    expect(err).to.be.instanceOf(AuthzConfigError);
    expect((err as Error).message).to.equal(within(kinds[0]));
    expect(await kinds[0].state()).to.deep.equal(kinds[0].before);
  });

  it('.accessible(p) whose plan narrows, with a .within(): AccessDenied', async () => {
    env('test');
    const p = await post();
    kinds[0].fill(p, false);
    const err = await as(() =>
      settle(() =>
        p.comments.sync(function () {
          this.accessible('comment:delete').within({ type: 'project', id: 'p9' });
        }),
      ),
    );

    expect(err).to.be.instanceOf(AccessDenied);
    expect((err as Error).message).to.equal('Access denied: comment:delete on comment (no_access)');
    expect(await kinds[0].state()).to.deep.equal(kinds[0].before);
  });

  it('update() of a many-to-many list with an @AccessResource junction model runs in the test env', async () => {
    env('test');
    const p = await post();
    kinds[1].fill(p, false);
    await as(() => p.tags.update());

    expect(await kinds[1].state()).to.deep.equal(['b1', 'g1', 'n1', 'r1']);
  });

  it('updates and deletes the application builds are not flagged', async () => {
    env('test');
    // The model is defined at run time, so its columns are not in its type.
    const Comments = Comment as unknown as { update(v: object): { where(c: string, v: unknown): PromiseLike<unknown> } };
    await as(() => Comments.update({ flag: 'blue' }).where('post_id', 'p2'));
    await as(() => Comment.destroy(['c4']));

    expect((await db.rows(Comment)).map((r) => String(r.id)).sort()).to.deep.equal(['c1', 'c2', 'c3']);
  });

  it('a sync() whose statement model is not an @AccessResource is never flagged', async () => {
    env('test');
    const p = await post();
    await as(() => p.notes.sync());

    expect(await db.rows(Note)).to.deep.equal([]);
  });
});
