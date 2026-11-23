import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AccessDenied, AuthzConfigError, DecisionAudit, SYSTEM, authz, authzStorage, runWithPrincipal } from '@spinajs/authz';
import type { AccessPlan, Principal } from '@spinajs/authz';
import { RecordingAudit, testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { Log, renderTemplate } from '@spinajs/log-common';
import { BelongsTo, HasMany, HasManyToMany, ModelBase, Relation, SingleRelation } from '@spinajs/orm';

import { AccessResource, PlanTermCompiler } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import { createAncestorTable, dropAncestorTable } from '../support/ancestors.js';
import { FlagTerm } from '../support/flag-term.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const green: AccessPlan = { kind: 'filter', permit: [{ op: 'test.flag', args: { flag: 'green' } }], deny: [] };

type List = Relation<ModelBase, ModelBase>;
type Post = ModelBase & { comments: List; tags: List; notes: List };
type Model = Awaited<ReturnType<TestDb['define']>>;
type Callback = NonNullable<Parameters<List['sync']>[0]>;

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
  readonly relation: 'comments' | 'tags';
  model(): Model;
  /** The list of p1 with its kept row, the red orphan when `keepRed`, and one new row. */
  fill(post: Post, keepRed: boolean): void;
  /** Ids of what p1 holds: comment ids, or the tag ids of its links. */
  state(): Promise<string[]>;
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
    const Junction = PostTag;
    const Comments = Comment;
    const Notes = Note;
    class PostRelations extends ModelBase {
      @HasMany(Comments, { foreignKey: 'post_id', primaryKey: 'id' })
      public comments!: Relation<ModelBase, ModelBase>;

      @HasMany(Notes, { foreignKey: 'post_id', primaryKey: 'id' })
      public notes!: Relation<ModelBase, ModelBase>;

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
      state: async () =>
        (await db.rows(Comment))
          .filter((r) => r.post_id === 'p1')
          .map((r) => String(r.id))
          .sort(),
      before: ['c1', 'c2', 'c3'],
      synced: ['c1', 'c9'],
      syncedKeepingRed: ['c1', 'c3', 'c9'],
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
      state: async () =>
        (await db.rows(PostTag))
          .filter((r) => r.post_id === 'p1')
          .map((r) => String(r.tag_id))
          .sort(),
      before: ['b1', 'g1', 'r1'],
      synced: ['g1', 'n1'],
      syncedKeepingRed: ['b1', 'g1', 'n1'],
    },
  ];

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

      it('.accessible(p) with a plan that allows every row: runs', async () => {
        env('test');
        plan.resolves({ kind: 'filter', permit: 'all', deny: [] });
        const permission = kind.permission;
        await as(() =>
          sync(false, function () {
            this.accessible(permission);
          }),
        );

        expect(await kind.state()).to.deep.equal(kind.synced);
      });

      it('.accessible(p) with a plan that leaves one orphan out: AccessDenied, nothing deleted or inserted', async () => {
        env('test');
        const permission = kind.permission;
        const err = await as(() =>
          settle(() =>
            sync(false, function () {
              this.accessible(permission);
            }),
          ),
        );

        expect(err).to.be.instanceOf(AccessDenied);
        expect((err as Error).message).to.equal(`Access denied: ${permission} on ${kind.type}: sync() of ${PostModel.name}.${kind.relation} reaches 2 ${kind.model().name} rows and ${permission} allows 1 of them; a sync() is never partial`);
        expect((err as AccessDenied).decision.permission).to.equal(permission);
        expect(await kind.state()).to.deep.equal(kind.before);
      });

      for (const onNone of [undefined, 'empty'] as const) {
        it(`.accessible(p${onNone ? ", { onNone: 'empty' }" : ''}) with a none plan: AccessDenied`, async () => {
          env('test');
          plan.resolves({ kind: 'none', reason: { code: 'no_access' } });
          const permission = kind.permission;
          const err = await as(() =>
            settle(() =>
              sync(false, function () {
                this.accessible(permission, onNone ? { onNone } : undefined);
              }),
            ),
          );

          expect(err).to.be.instanceOf(AccessDenied);
          expect((err as AccessDenied).decision.reason).to.deep.equal({ code: 'no_access' });
          expect(await kind.state()).to.deep.equal(kind.before);
        });
      }

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
        expect((err as Error).message).to.equal(`authz-orm: sync() of ${PostModel.name}.${kind.relation} reaches 2 ${kind.model().name} rows and .within() keeps 0 of them; a sync() is never partial`);
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

  it('.accessible(p) with a .within() that would keep an orphan: AccessDenied that names both', async () => {
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

    expect(err).to.be.instanceOf(AccessDenied);
    expect((err as Error).message).to.equal(`Access denied: comment:delete on comment: sync() of ${PostModel.name}.comments reaches 2 ${Comment.name} rows and comment:delete with .within() allows 0 of them; a sync() is never partial`);
    expect(await kinds[0].state()).to.deep.equal(kinds[0].before);
  });

  it('the many-to-many link select is not flagged when the junction model is an @AccessResource', async () => {
    env('test');
    const p = await post();
    kinds[1].fill(p, true);
    await as(() =>
      p.tags.sync(function () {
        this.accessible('post_tag:delete');
      }),
    );

    expect(await kinds[1].state()).to.deep.equal(['b1', 'g1', 'n1']);
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
