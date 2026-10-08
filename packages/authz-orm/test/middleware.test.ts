import * as chai from 'chai';
import 'mocha';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AccessDenied, AuthorizationModel, AuthzConfigError, DecisionAudit, SYSTEM, authzStorage, runWithPrincipal } from '@spinajs/authz';
import type { ModelCapabilities, Principal, ResourceFilter } from '@spinajs/authz';
import { RecordingAudit, StaticModel, testHost } from '@spinajs/authz-testing';
import type { VoteTable } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { BelongsTo, CloneTableQueryBuilder, DeleteQueryBuilder, InsertBehaviour, InsertQueryBuilder, ModelBase, QueryMiddleware, SelectQueryBuilder, SoftDelete, TruncateTableQueryBuilder, TruncateTableQueryCompiler, UpdateQueryBuilder, createQuery } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';

import { AccessResource, OrmScope, OrmScopePolicy, Owner, ScopeColumn } from '../src/index.js';
import { ResidualStatement } from '../src/compile/compiler.js';
import { AuthzQueryMiddleware } from '../src/middleware.js';
import { claimProcess } from '../src/once.js';
import { ResidualSlot } from '../src/shield.js';
import { TestDb } from './support/db.js';
import type { Dialect } from './support/db.js';
import { asSystem } from './support/system.js';

const expect = chai.expect;

const user = (id: string, attributes: Record<string, unknown> = {}): Principal => ({ type: 'user', id, authenticated: true, source: 'test', attributes });
const alice = user('alice', { team: 'red' });
const bob = user('bob', { team: 'blue' });
const agentFor = (p: Principal): Principal => ({ type: 'agent', id: 'bot', authenticated: true, source: 'token', attributes: {}, onBehalfOf: p, delegation: 'inherit' } as Principal);

const cmp = (field: string, op: string, value?: unknown): ResourceFilter => ({ op: 'cmp', field, cmp: op, value } as ResourceFilter);
const rel = (relation: string): ResourceFilter => ({ op: 'relation', relation });
const and = (...args: ResourceFilter[]): ResourceFilter => ({ op: 'and', args });
const or = (...args: ResourceFilter[]): ResourceFilter => ({ op: 'or', args });
const permit = (when: ResourceFilter = { op: 'true' }) => ({ permitWhen: when });

const TYPE = 'mwtask';
const P = { read: `${TYPE}:read`, create: `${TYPE}:create`, update: `${TYPE}:update`, delete: `${TYPE}:delete` };

const TASKS = [
  { id: 't1', title: 'a', status: 'open', owner: 'alice', team: 'red', visibility: 'private' },
  { id: 't2', title: 'b', status: 'open', owner: 'bob', team: 'blue', visibility: 'public' },
  { id: 't3', title: 'c', status: 'closed', owner: 'alice', team: 'blue', visibility: 'private' },
];
const ALL = ['t1', 't2', 't3'];

type Task = typeof ModelBase & { query(): any; all(): any; where(...a: unknown[]): any; update(v: object): any; destroy(pk: unknown): any; insert(v: object | object[], b?: InsertBehaviour): any };
const ids = (rows: ModelBase[]) => rows.map((r) => (r as unknown as { id: string }).id).sort();
const as = <T>(p: Principal, fn: () => T | Promise<T>): Promise<T> => runWithPrincipal(p, async () => fn());
const tick = () => new Promise((r) => setImmediate(r));

describe('authz-orm query middleware', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  const config = () => testHost.config();
  const undo: (() => void | Promise<void>)[] = [];
  const tracked: (abstract new (...args: never[]) => unknown)[] = [];
  let domainSeq = 0;

  const setConfig = (path: string[], value: unknown) => {
    const before = config().get<unknown>(path);
    config().set(path, value);
    undo.push(() => (before === undefined ? config().unset(path) : config().set(path, before)));
  };

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
    // Root boots before this suite registers its types, so their permissions come from the test domain's config.
    await (await testHost.domains()).service('root');
  });

  after(async () => {
    await db?.close();
  });

  afterEach(async () => {
    for (const fn of undo.splice(0).reverse()) await fn();
    await db.clear();
    for (const c of tracked.splice(0)) DI.uncache(c as never);
  });

  // DI keys classes by name; a unique name keeps one case's policy from answering for another's.
  let seq = 0;
  const track = <C extends abstract new (...args: never[]) => unknown>(cls: C): C => {
    Object.defineProperty(cls, 'name', { value: `${cls.name}_${++seq}` });
    tracked.push(cls);
    return cls;
  };

  /** A test domain with one StaticModel `m1`, a recording audit, the type's permissions; `authz.orm.domain` names it. */
  async function host(votes: VoteTable, opts: { sync?: ModelCapabilities['sync']; delayMs?: number; audit?: Record<string, unknown>; engine?: Record<string, unknown> } = {}) {
    const ds = await testHost.domains();
    const name = `mw${++domainSeq}`;
    const permissions = Object.fromEntries(Object.values(P).map((p) => [p, { types: [TYPE] }]));
    setConfig(['authz', 'domains', name], { permissions, combine: { default: { algorithm: 'deny-overrides', models: ['m1'] } }, cache: { maxEntries: 0 }, ...(opts.audit ? { audit: opts.audit } : {}), ...(opts.engine ? { engine: opts.engine } : {}) });
    setConfig(['authz', 'orm', 'domain'], name);
    const model = new StaticModel({ name: 'm1', votes, ...(opts.sync ? { capabilities: { sync: opts.sync } } : {}), ...(opts.delayMs ? { delayMs: opts.delayMs } : {}) });
    const audit = new RecordingAudit();
    const container: IContainer = ds.create(name, 'root');
    undo.push(() => (ds.names().includes(name) ? container.dispose() : undefined));
    container.register(testHost.instance(model)).as(AuthorizationModel);
    container.register(testHost.instance(audit)).as(DecisionAudit);
    const service = await ds.service(name);
    const evaluations = () => model.calls.filter((c) => c.method === 'evaluate').length;
    return { service, model, audit, evaluations };
  }

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      const defineTask = (decorate?: (cls: typeof ModelBase, proto: object) => void, extra: { columns?: Record<string, string>; rows?: Record<string, unknown>[] } = {}) =>
        db.define(
          {
            name: 'Task',
            columns: { title: 'TEXT', status: 'TEXT', owner: 'TEXT', team: 'TEXT', visibility: 'TEXT', ...extra.columns },
            rows: extra.rows ?? TASKS,
            decorate: (cls, proto) => {
              AccessResource(TYPE)(cls);
              Owner()(proto, 'owner');
              decorate?.(cls, proto);
            },
          },
          dialect,
        ) as Promise<Task>;

      const stored = async (Task: Task) => (await db.rows(Task)).map((r) => ({ ...r })).sort((a, b) => String(a.id).localeCompare(String(b.id)));

      /** A team policy like the kit's OrmScopeSpec: rows of the principal's team. */
      const teamPolicy = (opts: { onCreate?: 'stamp' | 'check'; guardUpdate?: boolean } = {}) =>
        track(
          class TeamPolicy extends OrmScopePolicy {
            scope(q: IWhereBuilder<never>, p: Principal): void {
              q.where('team' as never, String(p.attributes?.team));
            }

            authorizeCreate(q: InsertQueryBuilder, p: Principal): void {
              if (opts.onCreate === 'stamp') q.forceColumn('team', p.attributes?.team);
              else if (opts.onCreate === 'check' && q.getColumnValues('team').some((v) => v !== p.attributes?.team)) throw new Forbidden('team');
            }

            authorizeUpdate(_q: UpdateQueryBuilder<never>, values: Record<string, unknown>, p: Principal): void {
              if (opts.guardUpdate && 'team' in values && values.team !== p.attributes?.team) throw new Forbidden('team');
            }
          },
        );

      describe('scoping', () => {
        it('a model without @AccessResource is untouched, without a principal too, and consults no model', async () => {
          const { evaluations } = await host({ '*': permit() });
          const Note = (await db.define({ name: 'Note', columns: { text: 'TEXT' }, rows: [{ id: 'n1', text: 'x' }] }, dialect)) as Task;
          expect(ids(await Note.all())).to.deep.equal(['n1']);
          expect(ids(await as(alice, () => Note.all()))).to.deep.equal(['n1']);
          expect(evaluations()).to.equal(0);
        });

        it('runAs(SYSTEM) runs unscoped, consults no model, and the host audits the runAs', async () => {
          const Task = await defineTask();
          const { service, audit, evaluations } = await host({});
          expect(ids(await service.runAs(SYSTEM, 'cli', async () => Task.all()))).to.deep.equal(ALL);
          expect(evaluations()).to.equal(0);
          expect(audit.of('runAs').map((e) => e.reason)).to.deep.equal(['cli']);
        });

        it('@Unscoped(reason) runs unscoped and audits unscoped with the reason; authz.audit.unscoped false turns the record off', async () => {
          const Task = await defineTask();
          const { audit, evaluations } = await host({});
          const store = { Principal: alice, Unscoped: 'report' };
          expect(ids(await authzStorage().run(store, async () => Task.all()))).to.deep.equal(ALL);
          await tick();
          expect(evaluations()).to.equal(0);
          expect(audit.of('unscoped')).to.deep.equal([{ kind: 'unscoped', principal: { type: 'user', id: 'alice' }, reason: 'report', permission: P.read, resource: { type: TYPE } }]);

          const off = await host({}, { audit: { unscoped: false } });
          expect(ids(await authzStorage().run(store, async () => Task.all()))).to.deep.equal(ALL);
          await tick();
          expect(off.audit.of('unscoped')).to.deep.equal([]);
        });

        it('without a principal (UNATTENDED) a query throws AccessDenied with reason unattended and consults no model', async () => {
          const Task = await defineTask();
          const { evaluations } = await host({ [P.read]: permit() });
          const e = await Task.all().then(
            () => undefined,
            (x: unknown) => x,
          );
          expect(e).to.be.instanceOf(AccessDenied);
          expect((e as AccessDenied).decision.reason?.code).to.equal('unattended');
          expect(evaluations()).to.equal(0);
        });

        it('TRUE adds no WHERE', async () => {
          const Task = await defineTask();
          await host({ [P.read]: permit() });
          const sql = await as(alice, () => (Task.query().toDB() as { expression: string }).expression);
          expect(sql).to.not.match(/\bWHERE\b/i);
          expect(ids(await as(alice, () => Task.all()))).to.deep.equal(ALL);
        });

        it('a residual becomes a WHERE that keeps its OR and AND', async () => {
          const Task = await defineTask();
          await host({ [P.read]: permit(or(and(cmp('status', 'eq', 'open'), rel('owner')), cmp('visibility', 'eq', 'public'))) });
          expect(ids(await as(alice, () => Task.all()))).to.deep.equal(['t1', 't2']);
          expect(ids(await as(bob, () => Task.all()))).to.deep.equal(['t2']);
        });

        it("the caller's where never widens the residual: (residual) AND (where), also after orWhere and clearWhere", async () => {
          const Task = await defineTask();
          await host({ [P.read]: permit(rel('owner')) });
          const orWhere = () => Task.where('status', 'open').orWhere('status', 'closed');
          expect(ids(await as(alice, orWhere))).to.deep.equal(['t1', 't3']);
          expect(ids(await as(bob, orWhere))).to.deep.equal(['t2']);
          const sql = await as(alice, () => (orWhere().toDB() as { expression: string }).expression);
          expect(sql).to.match(/WHERE \(.+\) AND \( .+ OR .+ \)$/);
          expect(ids(await as(bob, () => Task.query().orWhere('owner', 'alice')))).to.deep.equal([]);
          expect(
            ids(
              await as(bob, () =>
                Task.query()
                  .where(function (this: IWhereBuilder<never>) {
                    this.where('status' as never, 'open').orWhere('status' as never, 'closed');
                  })
                  .orWhere('id', 't1'),
              ),
            ),
          ).to.deep.equal(['t2']);
          expect(ids(await as(bob, () => Task.query().clearWhere()))).to.deep.equal(['t2']);
        });

        it('a clone keeps the residual and its shield', async () => {
          const Task = await defineTask();
          await host({ [P.read]: permit(rel('owner')) });
          expect(ids(await as(bob, () => Task.query().clone().where('status', 'open').orWhere('owner', 'alice')))).to.deep.equal(['t2']);
        });

        it('a residual no row meets is an empty list; FALSE (no permit at all) is AccessDenied (H16)', async () => {
          const Task = await defineTask();
          await host({ [P.read]: permit(cmp('status', 'eq', 'archived')) });
          expect(ids(await as(alice, () => Task.all()))).to.deep.equal([]);

          await host({});
          const e = await as(alice, () => Task.all()).catch((x: unknown) => x);
          expect(e).to.be.instanceOf(AccessDenied);
          expect((e as AccessDenied).decision.permission).to.equal(P.read);
        });

        it("sync 'after-preload' without a preload and sync 'never' scope through the awaited filter", async () => {
          for (const opts of [{ sync: 'after-preload' as const }, { sync: 'never' as const, delayMs: 5 }]) {
            const Task = await defineTask();
            await host({ [P.read]: permit(cmp('status', 'eq', 'open')) }, opts);
            const before = await as(alice, () => ({ q: Task.query() }));
            expect(((await as(alice, () => before.q.toDB())) as { expression: string }).expression, 'unresolved: FALSE').to.include('(1 = 0)');
            expect(ids(await as(alice, () => Task.all())), JSON.stringify(opts)).to.deep.equal(['t1', 't2']);
            await db.clear();
          }
        });

        it('a deferred residual of FALSE throws AccessDenied; a deferred TRUE adds nothing', async () => {
          const Task = await defineTask();
          await host({}, { sync: 'never' });
          expect(await as(alice, () => Task.all()).catch((x: unknown) => x)).to.be.instanceOf(AccessDenied);
          await host({ [P.read]: permit() }, { sync: 'never' });
          expect(ids(await as(alice, () => Task.all()))).to.deep.equal(ALL);
        });

        it("a sub-query's deferred residual resolves when the query that compiles it executes; compiled unexecuted it stays FALSE", async () => {
          const Task = await defineTask();
          await host({ [P.read]: permit(cmp('status', 'eq', 'open')) }, { sync: 'never' });
          const query = () => Task.query().whereIn('id', Task.query().select('id').where('team', 'blue'));
          const { q } = await as(alice, () => ({ q: query() }));
          expect(((await as(alice, () => q.toDB())) as { expression: string }).expression).to.contain('(1 = 0)');
          expect(ids(await as(alice, query))).to.deep.equal(['t2']);
        });

        it('the delegation principal under inherit is the one relations compile for; maxDelegation is the booted one', async () => {
          const Task = await defineTask();
          const { service } = await host({ [P.read]: permit(rel('owner')) }, { engine: { maxDelegation: 1 } });
          expect(ids(await as(agentFor(alice), () => Task.all()))).to.deep.equal(['t1', 't3']);
          // The engine keeps the value it booted with; so does the middleware.
          setConfig(['authz', 'domains', service.domain, 'engine', 'maxDelegation'], 0);
          expect(ids(await as(agentFor(alice), () => Task.all()))).to.deep.equal(['t1', 't3']);
        });

        it('authz.orm.domain naming a domain whose service is not resolved fails closed with AuthzConfigError', async () => {
          const Task = await defineTask();
          await host({ [P.read]: permit() });
          setConfig(['authz', 'orm', 'domain'], 'mw-missing');
          expect(await as(alice, () => ({ q: Task.query() })).catch((x: unknown) => x)).to.be.instanceOf(AuthzConfigError);
          expect(ids(await asSystem(() => Task.all()))).to.deep.equal(ALL);
        });
      });

      describe('update and delete', () => {
        it("the residual limits the rows they change; the caller's orWhere does not widen it", async () => {
          const Task = await defineTask();
          await host({ [P.update]: permit(rel('owner')), [P.delete]: permit(rel('owner')) });
          await as(alice, () => Task.update({ title: 'x' }).where('id', 't1').orWhere('id', 't2'));
          expect((await stored(Task)).map((r) => [r.id, r.title])).to.deep.equal([
            ['t1', 'x'],
            ['t2', 'b'],
            ['t3', 'c'],
          ]);
          await as(alice, () => Task.destroy('t2'));
          expect((await stored(Task)).map((r) => r.id)).to.deep.equal(ALL);
          await as(alice, () => createQuery(Task, DeleteQueryBuilder).query.where('id', 't3').orWhere('id', 't2'));
          expect((await stored(Task)).map((r) => r.id)).to.deep.equal(['t1', 't2']);
        });

        it('FALSE is AccessDenied and changes nothing', async () => {
          const Task = await defineTask();
          await host({ [P.read]: permit() });
          expect(await as(alice, () => Task.update({ title: 'x' }).where('id', 't1')).catch((x: unknown) => x)).to.be.instanceOf(AccessDenied);
          expect(await as(alice, () => Task.destroy('t1')).catch((x: unknown) => x)).to.be.instanceOf(AccessDenied);
          expect((await stored(Task)).map((r) => [r.id, r.title])).to.deep.equal([
            ['t1', 'a'],
            ['t2', 'b'],
            ['t3', 'c'],
          ]);
        });

        it('under a relation, authorizeUpdate sees the values: moving a row out of scope is 403', async () => {
          const Policy = teamPolicy({ guardUpdate: true });
          const Task = await defineTask((cls) => OrmScope(cls, 'team')(Policy));
          await host({ [P.update]: permit(rel('team')) });
          const e = await as(alice, () => Task.update({ team: 'blue' }).where('id', 't1')).catch((x: unknown) => x);
          expect(e).to.be.instanceOf(Forbidden);
          await as(alice, () => Task.update({ title: 'y' }).where('id', 't1'));
          await as(alice, () => Task.update({ title: 'z' }).where('id', 't2'));
          expect((await stored(Task)).map((r) => [r.id, r.team, r.title])).to.deep.equal([
            ['t1', 'red', 'y'],
            ['t2', 'blue', 'b'],
            ['t3', 'blue', 'c'],
          ]);
        });
      });

      describe('insert', () => {
        const row = (values: Record<string, unknown> = {}) => ({ id: 't9', title: 'new', status: 'open', visibility: 'private', ...values });
        const insert = (Task: Task, p: Principal, values: Record<string, unknown> | Record<string, unknown>[], b?: InsertBehaviour) => as(p, () => Task.insert(Array.isArray(values) ? values : row(values), b));
        const fails = (p: PromiseLike<unknown>) =>
          Promise.resolve(p).then(
            () => undefined,
            (e: unknown) => e,
          );

        it('TRUE inserts as given', async () => {
          const Task = await defineTask();
          await host({ [P.create]: permit() });
          await insert(Task, alice, { owner: 'bob' });
          expect((await stored(Task)).find((r) => r.id === 't9')?.owner).to.equal('bob');
        });

        it('the owner relation stamps the @Owner column over a value the caller gave', async () => {
          const Task = await defineTask();
          await host({ [P.create]: permit(rel('owner')) });
          await insert(Task, alice, { owner: 'bob' });
          expect((await stored(Task)).find((r) => r.id === 't9')?.owner).to.equal('alice');
        });

        it("under inherit the delegate's id is stamped (D-L4-7)", async () => {
          const Task = await defineTask();
          await host({ [P.create]: permit(rel('owner')) });
          await insert(Task, agentFor(alice), {});
          expect((await stored(Task)).find((r) => r.id === 't9')?.owner).to.equal('alice');
        });

        it("another relation goes to its policy's authorizeCreate, which stamps or rejects", async () => {
          const Stamp = teamPolicy({ onCreate: 'stamp' });
          let Task = await defineTask((cls) => OrmScope(cls, 'team')(Stamp));
          await host({ [P.create]: permit(rel('team')) });
          await insert(Task, alice, { team: 'blue' });
          expect((await stored(Task)).find((r) => r.id === 't9')?.team).to.equal('red');
          await db.clear();

          const Check = teamPolicy({ onCreate: 'check' });
          Task = await defineTask((cls) => OrmScope(cls, 'team')(Check));
          expect(await fails(insert(Task, alice, { team: 'blue' }))).to.be.instanceOf(Forbidden);
          expect((await stored(Task)).map((r) => r.id)).to.deep.equal(ALL);
          await insert(Task, alice, { team: 'red' });
          expect((await stored(Task)).map((r) => r.id)).to.deep.equal([...ALL, 't9']);
        });

        it('a cmp residual checks every inserted row', async () => {
          const Task = await defineTask();
          await host({ [P.create]: permit(cmp('status', 'eq', 'draft')) });
          expect(await fails(insert(Task, alice, { status: 'open' }))).to.be.instanceOf(Forbidden);
          expect(await fails(insert(Task, alice, [row({ id: 't8', status: 'draft' }), row({ status: 'open' })]))).to.be.instanceOf(Forbidden);
          expect((await stored(Task)).map((r) => r.id)).to.deep.equal(ALL);
          await insert(Task, alice, [row({ id: 't8', status: 'draft' }), row({ status: 'draft' })]);
          expect((await stored(Task)).map((r) => r.id)).to.deep.equal([...ALL, 't8', 't9']);
        });

        it('a residual that needs the stored row (under) or a column the insert leaves out is 403', async () => {
          const Task = await defineTask((_cls, proto) => ScopeColumn('project_id', 'project')(proto, 'project_id'), { columns: { project_id: 'TEXT' } });
          await host({ [P.create]: permit(or({ op: 'under', scopes: [{ type: 'project', id: 'p1' }] } as ResourceFilter, cmp('team', 'notnull'))) });
          expect(await fails(insert(Task, alice, { project_id: 'p1' }))).to.be.instanceOf(Forbidden);
          expect((await stored(Task)).map((r) => r.id)).to.deep.equal(ALL);
          await insert(Task, alice, { team: 'red' });
          expect((await stored(Task)).map((r) => r.id)).to.deep.equal([...ALL, 't9']);
        });

        it('no permit is AccessDenied (a 403), and without a principal the reason is unattended', async () => {
          const Task = await defineTask();
          await host({ [P.read]: permit() });
          expect(await fails(insert(Task, alice, {})))
            .to.be.instanceOf(AccessDenied)
            .and.instanceOf(Forbidden);
          const e = await fails(Task.insert(row()));
          expect((e as AccessDenied).decision?.reason?.code).to.equal('unattended');
          expect((await stored(Task)).map((r) => r.id)).to.deep.equal(ALL);
        });

        it('an insert that may overwrite a row needs update permission on every row', async () => {
          const Task = await defineTask();
          await host({ [P.create]: permit(), [P.update]: permit(rel('owner')) });
          expect(await fails(insert(Task, alice, { id: 't2', title: 'stolen' }, InsertBehaviour.InsertOrUpdate))).to.be.instanceOf(Forbidden);
          expect((await stored(Task)).find((r) => r.id === 't2')?.title).to.equal('b');
        });
      });

      describe('review fixes', () => {
        const under = (type: string, id: string): ResourceFilter => ({ op: 'under', scopes: [{ type, id }] } as ResourceFilter);
        const fails = (p: PromiseLike<unknown>) =>
          Promise.resolve(p).then(
            () => undefined,
            (e: unknown) => e,
          );

        /** Task (scoped) and Note (not scoped) whose `task` is a belongsTo of Task. */
        const notes = async (relationScope: 'where' | 'join' = 'where') => {
          const Task = (await db.define(
            {
              name: 'Task',
              columns: { title: 'TEXT', owner: 'TEXT' },
              rows: TASKS.map(({ id, title, owner }) => ({ id, title, owner })),
              decorate: (cls, proto) => {
                AccessResource(TYPE, { relationScope })(cls);
                Owner()(proto, 'owner');
              },
            },
            dialect,
          )) as Task;
          const Note = (await db.define(
            {
              name: 'Note',
              columns: { task_id: 'TEXT' },
              rows: [
                { id: 'n1', task_id: 't1' },
                { id: 'n2', task_id: 't2' },
                { id: 'n3', task_id: 't3' },
              ],
              decorate: (_cls, proto) => BelongsTo(Task as never, 'task_id', 'id')(proto, 'task'),
            },
            dialect,
          )) as Task;
          return { Task, Note };
        };

        const populated = async (p: Principal, build: () => any): Promise<string[][]> => {
          const { q } = await as(p, () => ({ q: build() }));
          // Compiled as the principal it was built for (a builder refuses any other, M1).
          const { expression, bindings } = (await as(p, () => q.toDB())) as { expression: string; bindings: unknown[] };
          const rows = (await db.raw(expression, bindings, dialect)) as Record<string, unknown>[];
          return rows.map((r) => [String(r.nid), String(r['$task$.title'] ?? null)]).sort();
        };

        it("C1: an unscoped parent's orWhere does not widen a populated belongsTo residual, deferred too", async function () {
          const { Note } = await notes();
          await host({ [P.read]: permit(rel('owner')) });
          const query = () => Note.where('id', 'n1').orWhere('id', 'n2').select('id', 'nid').populate('task');
          expect(await populated(bob, query)).to.deep.equal([['n2', 'b']]);
          await host({ [P.read]: permit(rel('owner')) }, { sync: 'never' });
          expect(await populated(bob, query)).to.deep.equal([]);
        });

        it('I1: clearWhere or orWhere in a populate callback keep the residual, in WHERE and in JOIN ON', async function () {
          let { Note } = await notes('where');
          await host({ [P.read]: permit(rel('owner')) });
          const cleared = () =>
            Note.query()
              .select('id', 'nid')
              .populate('task', function (this: IWhereBuilder<never>) {
                this.clearWhere();
              });
          const widened = () =>
            Note.query()
              .select('id', 'nid')
              .populate('task', function (this: IWhereBuilder<never>) {
                this.where('title' as never, 'a').orWhere('title' as never, 'b');
              });
          expect(await populated(bob, cleared)).to.deep.equal([['n2', 'b']]);
          expect(await populated(bob, widened)).to.deep.equal([['n2', 'b']]);
          await db.clear();
          ({ Note } = await notes('join'));
          expect(await populated(bob, cleared)).to.deep.equal([
            ['n1', 'null'],
            ['n2', 'b'],
            ['n3', 'null'],
          ]);
        });

        it('I2: truncate needs delete on every row; without a principal it is AccessDenied (unattended)', async () => {
          const Task = await defineTask();
          await host({ [P.read]: permit(), [P.delete]: permit(rel('owner')) });
          const unattended = await fails((Task as any).truncate());
          expect(unattended).to.be.instanceOf(AccessDenied);
          expect((unattended as AccessDenied).decision.reason?.code).to.equal('unattended');
          expect(await fails(as(alice, () => (Task as any).truncate()))).to.be.instanceOf(Forbidden);
          expect((await stored(Task)).map((r) => r.id)).to.deep.equal(ALL);
          await host({ [P.delete]: permit() });
          await as(alice, () => (Task as any).truncate());
          expect(await stored(Task)).to.deep.equal([]);
        });

        it('I2: a builder with no model on a scoped table, an explicit join of a scoped table and a deep clone fail closed', async () => {
          const { Task, Note } = await notes();
          await host({ [P.read]: permit(rel('owner')), [P.delete]: permit(rel('owner')) });
          const table = db.table(Task);
          const driver = db.driver(dialect);
          expect(await fails(as(bob, () => driver.del().from(table)))).to.be.instanceOf(Forbidden);
          expect(await fails(as(bob, () => driver.select().from(table)))).to.be.instanceOf(Forbidden);
          expect(await fails(as(bob, () => Note.query().leftJoin({ joinTable: table, joinTableAlias: 'tk', sourceTablePrimaryKey: 'task_id', joinTableForeignKey: 'id' })))).to.be.instanceOf(Forbidden);
          expect(await fails(as(bob, () => Note.query().leftJoin({ joinModel: Task as never, sourceTablePrimaryKey: 'task_id', joinTableForeignKey: 'id' })))).to.be.instanceOf(Forbidden);
          const copy = `${table}_copy`;
          try {
            expect(await fails(as(bob, () => driver.schema().cloneTable((c) => void c.deepClone(table, copy))))).to.be.instanceOf(Forbidden);
          } finally {
            await db.raw(`DROP TABLE IF EXISTS "${copy}"`, [], dialect);
          }
          expect((await stored(Task)).map((r) => r.id)).to.deep.equal(ALL);
          expect(((await asSystem(() => driver.select().from(table))) as unknown[]).length).to.equal(3);
        });

        it('I3: a builder whose model is another class of the same name fails closed on the scoped table', async () => {
          const Dup = await db.define({ name: 'Dup', columns: { title: 'TEXT' } }, dialect);
          const Task = await defineTask();
          await host({ [P.read]: permit(rel('owner')) });
          const name = Task.name;
          Object.defineProperty(Task, 'name', { value: Dup.name });
          try {
            expect(await fails(as(bob, () => Task.query()))).to.be.instanceOf(Forbidden);
          } finally {
            Object.defineProperty(Task, 'name', { value: name });
          }
        });

        it('I4: an update that moves a row out of its owner, cmp or under residual is 403', async () => {
          const Task = await defineTask();
          await host({ [P.update]: permit(and(rel('owner'), cmp('status', 'eq', 'open'))) });
          expect(await fails(as(alice, () => Task.update({ owner: 'bob' }).where('id', 't1')))).to.be.instanceOf(Forbidden);
          expect(await fails(as(alice, () => Task.update({ status: 'closed' }).where('id', 't1')))).to.be.instanceOf(Forbidden);
          await as(alice, () => Task.update({ status: 'open', title: 'x' }).where('id', 't1'));
          expect((await stored(Task)).map((r) => [r.id, r.owner, r.status, r.title])).to.deep.equal([
            ['t1', 'alice', 'open', 'x'],
            ['t2', 'bob', 'open', 'b'],
            ['t3', 'alice', 'closed', 'c'],
          ]);
          await db.clear();

          const Scoped = await defineTask((_cls, proto) => ScopeColumn('project_id', 'project')(proto, 'project_id'), { columns: { project_id: 'TEXT' }, rows: TASKS.map((t) => ({ ...t, project_id: 'p1' })) });
          await host({ [P.update]: permit(under('project', 'p1')) });
          expect(await fails(as(alice, () => Scoped.update({ project_id: 'p2' }).where('id', 't1')))).to.be.instanceOf(Forbidden);
          await as(alice, () => Scoped.update({ project_id: 'p1', title: 'y' }).where('id', 't1'));
          expect((await stored(Scoped)).map((r) => [r.id, r.project_id, r.title])[0]).to.deep.equal(['t1', 'p1', 'y']);
        });

        it('I5: a soft delete is authorised as delete, not as update; a plain update still needs update', async () => {
          const softTask = () =>
            defineTask(
              (_cls, proto) => {
                (Reflect as unknown as { defineMetadata(k: string, v: unknown, t: object, p: string): void }).defineMetadata('design:type', { name: 'DateTime' }, proto, 'deleted_at');
                SoftDelete()(proto, 'deleted_at');
              },
              { columns: { deleted_at: dialect === 'postgres' ? 'TIMESTAMP' : 'DATETIME' } },
            );
          let Task = await softTask();
          await host({ [P.update]: permit() });
          expect(await fails(as(alice, () => Task.destroy('t1')))).to.be.instanceOf(AccessDenied);
          expect((await stored(Task)).every((r) => r.deleted_at === null)).to.equal(true);
          await db.clear();

          Task = await softTask();
          await host({ [P.delete]: permit(rel('owner')) });
          await as(alice, () => Task.destroy('t1'));
          await as(alice, () => Task.destroy('t2'));
          expect((await stored(Task)).map((r) => [r.id, r.deleted_at !== null])).to.deep.equal([
            ['t1', true],
            ['t2', false],
            ['t3', false],
          ]);
          expect(await fails(as(alice, () => Task.update({ title: 'x' }).where('id', 't3')))).to.be.instanceOf(AccessDenied);
        });

        it('a non-integer number for a Postgres integer column is UNKNOWN on insert (PG rounds it)', async () => {
          const Task = await defineTask(undefined, { columns: { priority: 'INTEGER' } });
          await host({ [P.create]: permit(cmp('priority', 'lt', 2)) });
          const insert = as(alice, () => Task.insert({ id: 't9', title: 'n', status: 'open', visibility: 'private', priority: 1.5 }));
          if (dialect === 'postgres') expect(await fails(insert)).to.be.instanceOf(Forbidden);
          else {
            await insert;
            expect((await stored(Task)).find((r) => r.id === 't9')?.priority).to.equal(1.5);
          }
        });

        const executed = async (p: Principal, build: () => any): Promise<string[][]> => {
          const rows = (await as(p, () => build().asRaw())) as Record<string, unknown>[];
          return rows.map((r) => [String(r.nid), String(r['$task$.title'] ?? null)]).sort();
        };

        it('C1 and I1, executed: the populated residual holds through the execution hooks', async function () {
          const { Note } = await notes();
          await host({ [P.read]: permit(rel('owner')) });
          expect(await executed(bob, () => Note.where('id', 'n1').orWhere('id', 'n2').select('id', 'nid').populate('task'))).to.deep.equal([['n2', 'b']]);
          expect(
            await executed(bob, () =>
              Note.query()
                .select('id', 'nid')
                .populate('task', function (this: IWhereBuilder<never>) {
                  this.clearWhere();
                }),
            ),
          ).to.deep.equal([['n2', 'b']]);
        });

        it('I-1: clearWhere after the relations compiled keeps the merged residual; a join whose residual is gone fails closed', async function () {
          let { Note } = await notes();
          await host({ [P.read]: permit(rel('owner')) });
          const compiled = async () => {
            const { q } = await as(bob, () => ({ q: Note.query().select('id', 'nid').populate('task') }));
            await as(bob, () => void q.toDB());
            return { q };
          };
          let { q } = await compiled();
          expect(await executed(bob, () => q.clearWhere())).to.deep.equal([['n2', 'b']]);
          ({ q } = await compiled());
          expect(await executed(bob, () => q.clone().clearWhere())).to.deep.equal([['n2', 'b']]);
          ({ q } = await compiled());
          q.Statements.splice(0);
          expect(await fails(executed(bob, () => q))).to.be.instanceOf(Forbidden);

          await db.clear();
          ({ Note } = await notes('join'));
          ({ q } = await compiled());
          expect(await executed(bob, () => q.clearWhere())).to.deep.equal([
            ['n1', 'null'],
            ['n2', 'b'],
            ['n3', 'null'],
          ]);
        });

        it('I-2: table names match case-insensitively', async () => {
          const { Task, Note } = await notes();
          await host({ [P.read]: permit(rel('owner')), [P.delete]: permit(rel('owner')) });
          const TABLE = db.table(Task).toUpperCase();
          const driver = db.driver(dialect);
          expect(await fails(as(bob, () => driver.select().from(TABLE)))).to.be.instanceOf(Forbidden);
          expect(await fails(as(bob, () => driver.del().from(TABLE)))).to.be.instanceOf(Forbidden);
          expect(await fails(as(bob, () => Note.query().leftJoin({ joinTable: TABLE, joinTableAlias: 'tk', sourceTablePrimaryKey: 'task_id', joinTableForeignKey: 'id' })))).to.be.instanceOf(Forbidden);
          expect((await stored(Task)).map((r) => r.id)).to.deep.equal(ALL);
        });

        it('I-3: a table-only sub-select, driver.execute without the hooks, and an unchecked insert fail closed', async () => {
          const { Task, Note } = await notes();
          await host({ [P.read]: permit(rel('owner')), [P.create]: permit(rel('owner')) });
          const table = db.table(Task);
          const driver = db.driver(dialect);
          expect(await fails(as(bob, () => Note.query().whereIn('task_id', driver.select().select('id').from(table).where('title', 'a'))))).to.be.instanceOf(Forbidden);
          expect(await fails(as(bob, () => Note.query().whereExist(driver.select().from(table))))).to.be.instanceOf(Forbidden);
          expect(await fails(as(bob, () => driver.execute(driver.select().from(table))))).to.be.instanceOf(Forbidden);
          const insert = () => createQuery(Task, InsertQueryBuilder).query.values({ id: 't9', title: 'x', owner: 'bob' });
          expect(await fails(as(alice, () => driver.execute(insert())))).to.be.instanceOf(Forbidden);
          expect((await stored(Task)).map((r) => r.id)).to.deep.equal(ALL);
          expect(((await asSystem(() => driver.execute(driver.select().from(table)))) as unknown[]).length).to.equal(3);
        });

        it('I-A: driver.execute of a scoped update skips no check: it is refused until beforeQueryExecution checked it', async () => {
          const { Task } = await notes();
          await host({ [P.read]: permit(rel('owner')), [P.update]: permit(rel('owner')) });
          const driver = db.driver(dialect);
          const move = () => createQuery(Task, UpdateQueryBuilder).query.update({ owner: 'alice' }).where('id', 't2');
          expect(await fails(as(bob, () => driver.execute(move())))).to.be.instanceOf(Forbidden);
          expect((await stored(Task)).find((r) => r.id === 't2')?.owner).to.equal('bob');
        });

        it('I-B: driver.execute of a truncate is refused unless the gate passed it; SYSTEM still truncates', async () => {
          const { Task } = await notes();
          await host({ [P.read]: permit(rel('owner')), [P.delete]: permit(rel('owner')) });
          const driver = db.driver(dialect);
          expect(await fails(as(bob, () => driver.execute(driver.truncate(db.table(Task)))))).to.be.instanceOf(Forbidden);
          expect((await stored(Task)).map((r) => r.id)).to.deep.equal(ALL);
          await asSystem(() => driver.execute(driver.truncate(db.table(Task))));
          expect(await stored(Task)).to.deep.equal([]);
        });

        it('values changed after the check make an insert or update unchecked again', async () => {
          const { Task } = await notes();
          await host({ [P.read]: permit(rel('owner')), [P.create]: permit(rel('owner')), [P.update]: permit(rel('owner')) });
          const driver = db.driver(dialect);
          const { insert } = await as(alice, () => ({ insert: createQuery(Task, InsertQueryBuilder).query.values({ id: 't8', title: 'x' }) }));
          await as(alice, () => insert);
          insert.values({ id: 't9', title: 'y', owner: 'bob' });
          expect(await fails(as(alice, () => driver.execute(insert)))).to.be.instanceOf(Forbidden);
          const { update } = await as(alice, () => ({ update: createQuery(Task, UpdateQueryBuilder).query.update({ title: 'z' }).where('id', 't1') }));
          await as(alice, () => update);
          update.update({ owner: 'bob' });
          expect(await fails(as(alice, () => driver.execute(update)))).to.be.instanceOf(Forbidden);
          expect((await stored(Task)).map((r) => [r.id, r.owner])).to.deep.equal([
            ['t1', 'alice'],
            ['t2', 'bob'],
            ['t3', 'alice'],
            ['t8', 'alice'],
          ]);
        });

        it('N-1: a check allows one compile: a builder sent again after its execution is refused, changed or not', async () => {
          const { Task, Note } = await notes();
          await host({ [P.read]: permit(rel('owner')), [P.create]: permit(rel('owner')), [P.update]: permit(rel('owner')), [P.delete]: permit(rel('owner')) });
          const driver = db.driver(dialect);
          const updateOf = (id: string) => as(alice, () => ({ u: createQuery(Task, UpdateQueryBuilder).query.update({ title: 'z' }).where('id', id) }));

          let { u } = await updateOf('t1');
          await as(alice, () => u);
          (u.Value as Record<string, unknown>).owner = 'bob';
          expect(await fails(as(alice, () => driver.execute(u)))).to.be.instanceOf(Forbidden);
          ({ u } = await updateOf('t3'));
          await as(alice, () => u);
          u.orWhere('id', 't2');
          expect(await fails(as(alice, () => driver.execute(u)))).to.be.instanceOf(Forbidden);
          expect(await fails(as(alice, () => u.toDB()))).to.be.instanceOf(Forbidden);

          const { insert } = await as(alice, () => ({ insert: createQuery(Task, InsertQueryBuilder).query.values({ id: 't8', title: 'x' }) }));
          await as(alice, () => insert);
          insert.forceColumn('owner', 'bob');
          expect(await fails(as(alice, () => driver.execute(insert)))).to.be.instanceOf(Forbidden);

          const truncate = driver.truncate(db.table(Note));
          await as(bob, () => truncate);
          truncate.setTable(db.table(Task));
          expect(await fails(as(bob, () => driver.execute(truncate)))).to.be.instanceOf(Forbidden);

          expect((await stored(Task)).map((r) => [r.id, r.owner, r.title])).to.deep.equal([
            ['t1', 'alice', 'z'],
            ['t2', 'bob', 'b'],
            ['t3', 'alice', 'z'],
            ['t8', 'alice', 'x'],
          ]);
        });

        it('the truncate and clone builders the driver returns compile through the authz gate, which calls the original toDB', async () => {
          const { Task } = await notes();
          await host({ [P.read]: permit(rel('owner')), [P.delete]: permit(rel('owner')) });
          const driver = db.driver(dialect);
          const table = db.table(Task);
          const gated = (cls: { prototype: { toDB: unknown } }) => (cls.prototype.toDB as { authzGate?: boolean }).authzGate;

          const truncate = driver.truncate(table);
          expect(truncate).to.be.instanceOf(TruncateTableQueryBuilder);
          expect(truncate.toDB).to.equal(TruncateTableQueryBuilder.prototype.toDB);
          expect(gated(TruncateTableQueryBuilder)).to.equal(true);
          expect(await fails(as(bob, () => truncate.toDB()))).to.be.instanceOf(Forbidden);
          const compiler = driver.Container.resolve<TruncateTableQueryCompiler>(TruncateTableQueryCompiler, [truncate.Container, truncate]);
          expect(await asSystem(() => truncate.toDB())).to.deep.equal(compiler.compile());

          const copy = `${table}_copy`;
          const clone = driver.schema().cloneTable((c) => void c.deepClone(table, copy));
          expect(clone).to.be.instanceOf(CloneTableQueryBuilder);
          expect(clone.toDB).to.equal(CloneTableQueryBuilder.prototype.toDB);
          expect(gated(CloneTableQueryBuilder)).to.equal(true);
          expect(await fails(as(bob, () => clone.toDB()))).to.be.instanceOf(Forbidden);
          // The orm cannot compile a deep clone yet; the TypeError shows the wrapper called through to it.
          expect(await fails(asSystem(() => clone.toDB()))).to.be.instanceOf(TypeError);
          expect((await stored(Task)).map((r) => r.id)).to.deep.equal(ALL);
        });
      });

      it("relationScope 'join': a populated target's residual goes into its JOIN ON, and the parent rows stay", async function () {
        const Task = (await db.define(
          {
            name: 'Task',
            columns: { owner: 'TEXT' },
            rows: [
              { id: 't1', owner: 'alice' },
              { id: 't2', owner: 'bob' },
            ],
            decorate: (cls, proto) => {
              AccessResource(TYPE, { relationScope: 'join' })(cls);
              Owner()(proto, 'owner');
            },
          },
          dialect,
        )) as Task;
        const Post = (await db.define(
          {
            name: 'Post',
            columns: { task_id: 'TEXT' },
            rows: [
              { id: 'p1', task_id: 't1' },
              { id: 'p2', task_id: 't2' },
            ],
            decorate: (_cls, proto) => BelongsTo(Task as never, 'task_id', 'id')(proto, 'task'),
          },
          dialect,
        )) as Task;
        await host({ [P.read]: permit(rel('owner')) });
        const { q } = await as(alice, () => ({ q: Post.query().select('id', 'pid').populate('task') }));
        const { expression, bindings } = (await as(alice, () => q.toDB())) as { expression: string; bindings: unknown[] };
        expect(expression).to.match(/ ON .*[`"]owner[`"]/);
        expect(expression).to.not.match(/WHERE/);
        const rows = (await db.raw(expression, bindings, dialect)) as Record<string, unknown>[];
        expect(rows.map((r) => [r.pid, r['$task$.id'] ?? null]).sort()).to.deep.equal([
          ['p1', 't1'],
          ['p2', null],
        ]);
      });

      it('authz (order 100) scopes a builder before a middleware of order 1000 sees it', async () => {
        const Task = await defineTask();
        await host({ [P.read]: permit(rel('owner')) });
        const seen: boolean[] = [];
        class Later extends QueryMiddleware {
          public order = 1000;
          afterQueryCreation(q: SelectQueryBuilder): void {
            if (q.Model === Task) seen.push(q.Statements.some((s) => s instanceof ResidualStatement));
          }
          beforeQueryExecution(): void {}
        }
        DI.register(Later).as(QueryMiddleware);
        DI.uncache(QueryMiddleware);
        try {
          const q = await as(alice, () => ({ q: Task.query() }));
          const list = (q.q as unknown as { _queryMiddlewares: QueryMiddleware[] })._queryMiddlewares;
          expect(list.findIndex((m) => m instanceof AuthzQueryMiddleware)).to.be.lessThan(list.findIndex((m) => m instanceof Later));
        } finally {
          DI.unregister(Later);
          DI.uncache(Later);
          DI.uncache(QueryMiddleware);
        }
        expect(seen).to.deep.equal([true]);
      });
    });
  }

  it('ResidualSlot renders FALSE until filled, nothing for TRUE', () => {
    const slot = new ResidualSlot({});
    expect(slot.build().Statements).to.deep.equal(['(1 = 0)']);
    slot.fill([]);
    expect(slot.build().Statements).to.deep.equal([]);
  });

  it('N-2: the process holds one copy of authz-orm; another copy claiming it throws AuthzConfigError', () => {
    const KEY = Symbol.for('@spinajs/authz-orm');
    const store: Record<symbol, unknown> = {};
    const mine = {};
    claimProcess(store, mine);
    claimProcess(store, mine);
    expect(() => claimProcess(store, {})).to.throw(AuthzConfigError);
    expect((globalThis as unknown as Record<symbol, unknown>)[KEY]).to.not.equal(undefined);
  });

  it('N-2: loading the built package where another copy is loaded fails at load with AuthzConfigError', async function () {
    const lib = resolve('lib/mjs/index.js');
    if (!existsSync(lib)) this.skip();
    const load = (claimed: boolean) => {
      const script = `${claimed ? "globalThis[Symbol.for('@spinajs/authz-orm')] = {};" : ''} import(${JSON.stringify(pathToFileURL(lib).href)}).then(() => console.log('loaded'), (e) => console.log(e?.name));`;
      return new Promise<string>((done, fail) => execFile(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd() }, (e, out) => (e ? fail(e) : done(out.trim()))));
    };
    expect(await load(false)).to.equal('loaded');
    expect(await load(true)).to.equal('AuthzConfigError');
  });
});
