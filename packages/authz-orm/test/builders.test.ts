import * as chai from 'chai';
import 'mocha';

import { AccessDenied, AuthorizationModel, DecisionAudit, runWithPrincipal } from '@spinajs/authz';
import type { ModelCapabilities, Principal, ResourceFilter } from '@spinajs/authz';
import { RecordingAudit, StaticModel, testHost } from '@spinajs/authz-testing';
import type { VoteTable } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { BelongsTo, HasMany, HasManyToMany, ManyToManyRelationList, ModelBase, OneToManyRelationList } from '@spinajs/orm';
import type { IWhereBuilder, OrmDriver } from '@spinajs/orm';

import { AccessResource, Owner } from '../src/index.js';
import '../src/middleware.js';
import { TestDb } from './support/db.js';
import type { Dialect } from './support/db.js';
import { asSystem } from './support/system.js';

const expect = chai.expect;

const user = (id: string): Principal => ({ type: 'user', id, authenticated: true, source: 'test', attributes: {} });
const bob = user('bob');
const rel = (relation: string): ResourceFilter => ({ op: 'relation', relation });
const cmp = (field: string, op: string, value?: unknown): ResourceFilter => ({ op: 'cmp', field, cmp: op, value } as ResourceFilter);
const permit = (when: ResourceFilter = { op: 'true' }) => ({ permitWhen: when });
const as = <T>(p: Principal, fn: () => T | Promise<T>): Promise<T> => runWithPrincipal(p, async () => fn());
const fails = (p: PromiseLike<unknown>) =>
  Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );

const TASK = 'bltask';
const TAG = 'bltag';
const LINK = 'bllink';
const TYPES = [TASK, TAG, LINK];
const READ = { task: `${TASK}:read`, tag: `${TAG}:read`, link: `${LINK}:read` };

type Static = typeof ModelBase & { query(): any; where(...a: unknown[]): any; populate(relation: string, id: unknown): any };
const idsOf = (rows: readonly unknown[]): string[] => rows.map((r) => String((r as { id: unknown }).id)).sort();

interface Executed {
  readonly sql: string;
  readonly bindings: readonly unknown[];
}

/** Every statement `fn` sends to `driver`, as the driver receives it. */
async function captured<T>(driver: OrmDriver, fn: () => Promise<T>): Promise<{ result: T; executed: Executed[] }> {
  const d = driver as unknown as { executeOnDb(sql: string, bindings: unknown[], ctx: unknown): Promise<unknown> };
  const executeOnDb = d.executeOnDb;
  const executed: Executed[] = [];
  d.executeOnDb = function (this: unknown, sql: string, bindings: unknown[], ctx: unknown) {
    executed.push({ sql, bindings: [...(bindings ?? [])] });
    return executeOnDb.call(this, sql, bindings, ctx);
  };
  try {
    return { result: await fn(), executed };
  } finally {
    d.executeOnDb = executeOnDb;
  }
}

describe('authz-orm junction, populate and cloned builders', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  const undo: (() => void | Promise<void>)[] = [];
  let domainSeq = 0;

  const setConfig = (path: string[], value: unknown) => {
    const config = testHost.config();
    const before = config.get<unknown>(path);
    config.set(path, value);
    undo.push(() => (before === undefined ? config.unset(path) : config.set(path, before)));
  };

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
    await (await testHost.domains()).service('root');
  });

  after(async () => {
    await db?.close();
  });

  afterEach(async () => {
    for (const fn of undo.splice(0).reverse()) await fn();
    await db.clear();
  });

  async function host(votes: VoteTable, opts: { sync?: ModelCapabilities['sync'] } = {}) {
    const ds = await testHost.domains();
    const name = `bl${++domainSeq}`;
    const permissions = Object.fromEntries(TYPES.flatMap((t) => ['read', 'create', 'update', 'delete'].map((a) => [`${t}:${a}`, { types: [t] }])));
    setConfig(['authz', 'domains', name], { permissions, combine: { default: { algorithm: 'deny-overrides', models: ['m1'] } }, cache: { maxEntries: 0 } });
    setConfig(['authz', 'orm', 'domain'], name);
    const container: IContainer = ds.create(name, 'root');
    undo.push(() => (ds.names().includes(name) ? container.dispose() : undefined));
    container.register(testHost.instance(new StaticModel({ name: 'm1', votes, ...(opts.sync ? { capabilities: { sync: opts.sync } } : {}) }))).as(AuthorizationModel);
    container.register(testHost.instance(new RecordingAudit())).as(DecisionAudit);
    await ds.service(name);
  }

  const rewire = () => (db.orm as unknown as { wireRelations(): void }).wireRelations();

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      /** Post (not scoped) has many Tags (scoped, owner) through PostTag; p2 links alice's tag only, p3 none. */
      async function posts(opts: { relationScope?: 'where' | 'join'; scopedJunction?: boolean } = {}) {
        const Tag = (await db.define(
          {
            name: 'Tag',
            columns: { title: 'TEXT', owner: 'TEXT' },
            rows: [
              { id: 'g1', title: 'a', owner: 'alice' },
              { id: 'g2', title: 'b', owner: 'bob' },
              { id: 'g3', title: 'c', owner: 'bob' },
            ],
            decorate: (cls, proto) => {
              AccessResource(TAG, { relationScope: opts.relationScope ?? 'where' })(cls);
              Owner()(proto, 'owner');
            },
          },
          dialect,
        )) as Static;
        const Post = (await db.define(
          {
            name: 'Post',
            columns: { title: 'TEXT' },
            rows: [
              { id: 'p1', title: 'x' },
              { id: 'p2', title: 'y' },
              { id: 'p3', title: 'z' },
            ],
          },
          dialect,
        )) as Static;
        const PostTag = await db.define(
          {
            name: 'PostTag',
            columns: { post_id: 'TEXT', tag_id: 'TEXT', visible: 'TEXT' },
            rows: [
              { id: 'j1', post_id: 'p1', tag_id: 'g1', visible: 'yes' },
              { id: 'j2', post_id: 'p1', tag_id: 'g2', visible: 'yes' },
              { id: 'j3', post_id: 'p1', tag_id: 'g3', visible: 'no' },
              { id: 'j4', post_id: 'p2', tag_id: 'g1', visible: 'yes' },
            ],
            decorate: (cls, proto) => {
              if (opts.scopedJunction) AccessResource(LINK)(cls);
              BelongsTo(Post as never, 'post_id', 'id')(proto, 'post');
              BelongsTo(Tag as never, 'tag_id', 'id')(proto, 'tag');
            },
          },
          dialect,
        );
        HasManyToMany(PostTag as never, Tag as never, { targetModelPKey: 'id', sourceModelPKey: 'id', junctionModelTargetPk: 'tag_id', junctionModelSourcePk: 'post_id', type: ManyToManyRelationList as never })(Post.prototype, 'tags');
        rewire();
        return { Tag, Post, PostTag };
      }

      /** Task (scoped, owner) with Notes (belongsTo; a Note has its own `owner` column) and a Project (hasMany). */
      async function tasks(opts: { relationScope?: 'where' | 'join' } = {}) {
        const Task = (await db.define(
          {
            name: 'Task',
            columns: { title: 'TEXT', owner: 'TEXT', project_id: 'TEXT' },
            rows: [
              { id: 't1', title: 'a', owner: 'alice', project_id: 'r1' },
              { id: 't2', title: 'b', owner: 'bob', project_id: 'r1' },
              { id: 't3', title: 'c', owner: 'alice', project_id: 'r1' },
            ],
            decorate: (cls, proto) => {
              AccessResource(TASK, { relationScope: opts.relationScope ?? 'where' })(cls);
              Owner()(proto, 'owner');
            },
          },
          dialect,
        )) as Static;
        const Note = (await db.define(
          {
            name: 'Note',
            columns: { task_id: 'TEXT', owner: 'TEXT' },
            rows: [
              { id: 'n1', task_id: 't1', owner: 'bob' },
              { id: 'n2', task_id: 't2', owner: 'alice' },
              { id: 'n3', task_id: 't3', owner: 'bob' },
            ],
            decorate: (_cls, proto) => BelongsTo(Task as never, 'task_id', 'id')(proto, 'task'),
          },
          dialect,
        )) as Static;
        const Project = (await db.define({ name: 'Project', columns: { name: 'TEXT' }, rows: [{ id: 'r1', name: 'r' }] }, dialect)) as Static;
        HasMany(Task as never, { foreignKey: 'project_id', primaryKey: 'id', type: (() => OneToManyRelationList) as never })(Project.prototype, 'tasks');
        rewire();
        return { Task, Note, Project };
      }

      const tagsOf = (post: unknown): string[] => idsOf([...((post as { tags: unknown[] }).tags ?? [])]);
      const populatedTags = (Post: Static) => async () => tagsOf(await Post.where('id', 'p1').populate('tags').first());
      const listedTags = (Post: Static) => async () => {
        const post: any = await Post.where('id', 'p1').first();
        await post.tags.populate();
        return tagsOf(post);
      };
      /** [note id, task title or null] of a populated note query, executed. */
      const notesWithTask = async (p: Principal, build: () => any): Promise<string[][]> => {
        const rows = (await as(p, () => build().asRaw())) as Record<string, unknown>[];
        return rows.map((r) => [String(r.nid), String(r['$task$.title'] ?? null)]).sort();
      };
      const bindingsOf = (executed: readonly Executed[], value: string) => executed.flatMap((e) => e.bindings).filter((b) => b === value).length;

      describe('many-to-many', () => {
        for (const relationScope of ['where', 'join'] as const) {
          it(`populate and the relation list return only the targets the residual allows (relationScope '${relationScope}')`, async () => {
            await host({ [READ.tag]: permit(rel('owner')) });
            const { Post } = await posts({ relationScope });
            const driver = db.driver(dialect);
            const { result, executed } = await captured(driver, () => as(bob, populatedTags(Post)));
            expect(result).to.deep.equal(['g2', 'g3']);
            // The target's residual binds bob's id once: it applies exactly once.
            expect(bindingsOf(executed, 'bob')).to.equal(1);
            expect(await as(bob, listedTags(Post))).to.deep.equal(['g2', 'g3']);
            expect(await asSystem(populatedTags(Post))).to.deep.equal(['g1', 'g2', 'g3']);
          });
        }

        it("a registered junction model's residual scopes the junction rows too", async () => {
          await host({ [READ.tag]: permit(rel('owner')), [READ.link]: permit(cmp('visible', 'eq', 'yes')) });
          const { Post } = await posts({ scopedJunction: true });
          expect(await as(bob, populatedTags(Post))).to.deep.equal(['g2']);
          expect(await as(bob, listedTags(Post))).to.deep.equal(['g2']);
        });

        it('FALSE on the target fails closed: AccessDenied, no rows', async () => {
          await host({});
          const { Post } = await posts();
          expect(await fails(as(bob, populatedTags(Post)))).to.be.instanceOf(AccessDenied);
          expect(await fails(as(bob, listedTags(Post)))).to.be.instanceOf(AccessDenied);
        });

        it("a deferred residual of the target resolves before the junction query runs (sync 'never')", async () => {
          await host({ [READ.tag]: permit(rel('owner')) }, { sync: 'never' });
          const { Post } = await posts();
          expect(await as(bob, populatedTags(Post))).to.deep.equal(['g2', 'g3']);
          expect(await as(bob, listedTags(Post))).to.deep.equal(['g2', 'g3']);
        });

        it('whereExist and whereNotExists test the target rows the residual allows, with and without a callback', async () => {
          await host({ [READ.tag]: permit(rel('owner')) });
          const { Post } = await posts();
          expect(idsOf(await as(bob, () => Post.query().whereExist('tags')))).to.deep.equal(['p1']);
          expect(idsOf(await as(bob, () => Post.query().whereNotExists('tags')))).to.deep.equal(['p2', 'p3']);
          const titled = (title: string) =>
            function (this: IWhereBuilder<never>) {
              this.where('title' as never, title);
            };
          expect(idsOf(await as(bob, () => Post.query().whereExist('tags', titled('b'))))).to.deep.equal(['p1']);
          expect(idsOf(await as(bob, () => Post.query().whereExist('tags', titled('a'))))).to.deep.equal([]);
          expect(idsOf(await asSystem(() => Post.query().whereExist('tags', titled('a'))))).to.deep.equal(['p1', 'p2']);
          // A clone (count, pagination) keeps the scoped sub-queries and their correlation.
          expect(idsOf(await as(bob, () => Post.query().whereExist('tags').clone()))).to.deep.equal(['p1']);
        });

        it('a junction sub-query the orm builds itself (whereExist inside a nested where) fails closed', async () => {
          await host({ [READ.tag]: permit(rel('owner')) });
          const { Post } = await posts();
          const nested = () =>
            Post.query().where(function (this: IWhereBuilder<never>) {
              this.whereExist('tags');
            });
          expect(await fails(as(bob, nested))).to.be.instanceOf(Forbidden);
          // The orm's own junction sub-query is plain SQL on SQLite only (its correlation is back-quoted).
          if (dialect === 'sqlite') expect(idsOf(await asSystem(nested))).to.deep.equal(['p1', 'p2']);
        });

        it('the static Model.populate joins the target explicitly and fails closed', async () => {
          await host({ [READ.tag]: permit(rel('owner')) });
          const { Post } = await posts();
          expect(await fails(as(bob, () => Post.populate('tags', 'p1')))).to.be.instanceOf(Forbidden);
        });
      });

      describe('belongsTo and hasMany', () => {
        it("populate of a belongsTo target: the residual goes into the WHERE ('where') or the JOIN ON ('join')", async () => {
          await host({ [READ.task]: permit(rel('owner')) });
          let { Note } = await tasks();
          const query = () => Note.query().select('id', 'nid').populate('task');
          expect(await notesWithTask(bob, query)).to.deep.equal([['n2', 'b']]);
          // The relation object's own query (SingleRelation.populate) is scoped too.
          const taskOf = (id: string) =>
            as(bob, async () => {
              const note: any = await Note.where('id', id).first();
              await note.task.populate();
              return note.task.Value?.id ?? null;
            });
          expect([await taskOf('n1'), await taskOf('n2')]).to.deep.equal([null, 't2']);
          await db.clear();

          ({ Note } = await tasks({ relationScope: 'join' }));
          const { result, executed } = await captured(db.driver(dialect), () => notesWithTask(bob, query));
          expect(result).to.deep.equal([
            ['n1', 'null'],
            ['n2', 'b'],
            ['n3', 'null'],
          ]);
          expect(executed).to.have.length(1);
          expect(executed[0].sql).to.match(/ ON .*[`"]owner[`"]/);
          expect(executed[0].sql).to.not.match(/\bWHERE\b/i);
        });

        it('populate of a hasMany target and its relation list are scoped by the target residual', async () => {
          await host({ [READ.task]: permit(rel('owner')) });
          for (const relationScope of ['where', 'join'] as const) {
            const { Project } = await tasks({ relationScope });
            const project: any = await as(bob, (): any => Project.where('id', 'r1').populate('tasks').first());
            expect(idsOf([...project.tasks])).to.deep.equal(['t2']);
            const listed: any = await as(bob, (): any => Project.where('id', 'r1').first());
            await as(bob, () => listed.tasks.populate());
            expect(idsOf([...listed.tasks])).to.deep.equal(['t2']);
            await db.clear();
          }
        });

        it('FALSE on a populated target fails closed: AccessDenied, no rows', async () => {
          await host({});
          for (const relationScope of ['where', 'join'] as const) {
            const { Note, Project } = await tasks({ relationScope });
            expect(await fails(notesWithTask(bob, () => Note.query().select('id', 'nid').populate('task')))).to.be.instanceOf(AccessDenied);
            expect(await fails(as(bob, () => Project.where('id', 'r1').populate('tasks').first()))).to.be.instanceOf(AccessDenied);
            await db.clear();
          }
        });

        it("a deferred residual of a populated belongsTo resolves before the query runs (sync 'never')", async () => {
          await host({ [READ.task]: permit(rel('owner')) }, { sync: 'never' });
          let { Note } = await tasks();
          const query = () => Note.query().select('id', 'nid').populate('task');
          expect(await notesWithTask(bob, query)).to.deep.equal([['n2', 'b']]);
          await db.clear();
          ({ Note } = await tasks({ relationScope: 'join' }));
          expect(await notesWithTask(bob, query)).to.deep.equal([
            ['n1', 'null'],
            ['n2', 'b'],
            ['n3', 'null'],
          ]);
        });

        it("a join that reuses a populated relation's alias is not the relation's join: Forbidden", async () => {
          await host({ [READ.task]: permit(rel('owner')) });
          const { Task, Note } = await tasks();
          const forged = () =>
            Note.query()
              .select('id', 'nid')
              .populate('task')
              .leftJoin({ joinTable: db.table(Task), joinTableAlias: '$task$', sourceTablePrimaryKey: 'task_id', joinTableForeignKey: 'id', joinTableDriver: db.driver(dialect) } as never);
          expect(await fails(notesWithTask(bob, forged))).to.be.instanceOf(Forbidden);
        });
      });

      describe('clone', () => {
        it('a clone of a scoped select returns the same rows; its count too', async () => {
          await host({ [READ.task]: permit(rel('owner')) });
          const { Task } = await tasks();
          const { q } = await as(bob, () => ({ q: Task.query().whereIn('title', ['a', 'b']) }));
          expect(idsOf(await as(bob, () => q.clone()))).to.deep.equal(['t2']);
          expect(idsOf(await as(bob, () => q))).to.deep.equal(['t2']);
          expect(Number(await as(bob, () => q.clone().selectCount()))).to.equal(1);
        });

        it("a clone of a compiled populated query keeps the relation's residual on the relation's alias, once", async () => {
          await host({ [READ.task]: permit(rel('owner')) });
          for (const relationScope of ['where', 'join'] as const) {
            const { Note } = await tasks({ relationScope });
            const { q } = await as(bob, () => ({ q: Note.query().select('id', 'nid').populate('task') }));
            await as(bob, () => void q.toDB());
            // Rebound to the parent, the residual would read the note's own `owner` (bob on n1 and n3, whose tasks are alice's).
            const expected =
              relationScope === 'where'
                ? [['n2', 'b']]
                : [
                    ['n1', 'null'],
                    ['n2', 'b'],
                    ['n3', 'null'],
                  ];
            const { result, executed } = await captured(db.driver(dialect), () => notesWithTask(bob, () => q.clone()));
            expect(result).to.deep.equal(expected);
            expect(bindingsOf(executed, 'bob')).to.equal(1);
            expect(await notesWithTask(bob, () => q.clone().clearWhere())).to.deep.equal(expected);
            expect(Number(await as(bob, () => q.clone().selectCount()))).to.equal(expected.length);
            await db.clear();
          }
        });

        it('a clone of a deferred populated query resolves the relation residual it carries', async () => {
          await host({ [READ.task]: permit(rel('owner')) }, { sync: 'never' });
          const { Note } = await tasks();
          const { q } = await as(bob, () => ({ q: Note.query().select('id', 'nid').populate('task') }));
          await as(bob, () => void q.toDB());
          expect(await notesWithTask(bob, () => q.clone())).to.deep.equal([['n2', 'b']]);
        });
      });
    });
  }
});
