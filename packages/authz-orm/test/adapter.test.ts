import * as chai from 'chai';
import 'mocha';

import { CORE_FILTER_OPS, GLOBAL, currentPrincipal, runWithPrincipal } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { Json, ModelBase, QueryMiddleware } from '@spinajs/orm';

import { AccessResource, OrmNativeCompiler, Owner, ScopeColumn } from '../src/index.js';
import { OrmResourceAdapter } from '../src/adapter.js';
import { OPAQUE } from '../src/columns.js';
import { OrmAuthzContributor } from '../src/contributor.js';
import { TestDb } from './support/db.js';
import type { Dialect } from './support/db.js';
import { asSystem } from './support/system.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const inStore = <T>(fn: () => Promise<T>): Promise<T> => runWithPrincipal(alice, fn);

const TYPES: Record<Dialect, { text: string; int: string; real: string; bool: string; date: string; json: string; uuid: string }> = {
  sqlite: { text: 'TEXT', int: 'INTEGER', real: 'REAL', bool: 'BOOLEAN', date: 'DATETIME', json: 'JSON', uuid: 'TEXT' },
  postgres: { text: 'TEXT', int: 'INTEGER', real: 'DOUBLE PRECISION', bool: 'BOOLEAN', date: 'TIMESTAMP', json: 'JSONB', uuid: 'UUID' },
};

describe('authz-orm OrmResourceAdapter', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  afterEach(async () => {
    await db.clear();
  });

  const adapter = () => new OrmResourceAdapter();

  for (const dialect of ['sqlite', 'postgres'] as const) {
    describe(dialect, () => {
      const T = TYPES[dialect];
      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      const defineTask = (rows: Record<string, unknown>[] = []) =>
        db.define(
          {
            name: 'Task',
            columns: { title: T.text, owner: T.text, project_id: T.text, org_id: T.int, n: T.int, r: T.real, done: T.bool, due: T.date },
            rows,
            decorate: (cls, proto) => {
              AccessResource('ad-task')(cls);
              Owner()(proto, 'owner');
              ScopeColumn('project_id', 'project')(proto, 'project_id');
              ScopeColumn('org_id', 'org')(proto, 'org_id');
            },
          },
          dialect,
        );

      it('types, accepts, refOf, permissions, compiles', async () => {
        const Task = await defineTask([{ id: 't1', title: 'a' }]);
        const a = adapter();
        expect(a.kind).to.equal('orm');
        expect(a.types).to.include('ad-task');
        const [row] = (await asSystem(() => (Task as any).all())) as ModelBase[];
        expect(a.accepts(row)).to.equal(true);
        expect(a.accepts({ id: 't1' })).to.equal(false);
        expect(a.accepts(null)).to.equal(false);
        expect(a.refOf(row)).to.deep.equal({ type: 'ad-task', id: 't1' });
        expect(
          a
            .permissions()
            .filter((p) => p.types.includes('ad-task'))
            .map((p) => p.name),
        ).to.deep.equal(['ad-task:read', 'ad-task:create', 'ad-task:update', 'ad-task:delete']);
        expect(a.compiles).to.deep.equal([...CORE_FILTER_OPS]);
        expect(
          a.relations!()
            .filter((r) => r.type === 'ad-task')
            .map((r) => r.relation),
        ).to.deep.equal(['owner']);
      });

      it('ancestors: self, scope columns in order (null skipped, dangling listed), GLOBAL; unknown row is null', async () => {
        await defineTask([
          { id: 't1', project_id: 'p1', org_id: 7 },
          { id: 't2', project_id: null, org_id: 9 },
          { id: 't3', project_id: 'p-gone', org_id: null },
        ]);
        const a = adapter();
        expect(await a.ancestors({ type: 'ad-task', id: 't1' })).to.deep.equal([{ type: 'ad-task', id: 't1' }, { type: 'project', id: 'p1' }, { type: 'org', id: '7' }, GLOBAL]);
        expect(await a.ancestors({ type: 'ad-task', id: 't2' })).to.deep.equal([{ type: 'ad-task', id: 't2' }, { type: 'org', id: '9' }, GLOBAL]);
        expect(await a.ancestors({ type: 'ad-task', id: 't3' })).to.deep.equal([{ type: 'ad-task', id: 't3' }, { type: 'project', id: 'p-gone' }, GLOBAL]);
        expect(await a.ancestors({ type: 'ad-task', id: 'missing' })).to.equal(null);
        expect(await a.ancestors({ type: 'ad-task' })).to.deep.equal([{ type: 'ad-task' }, GLOBAL]);
        expect(await a.ancestors({ type: 'ad-nothing', id: 'x' })).to.equal(null);
      });

      it('ancestors are memoised per request store, not across stores, not outside one', async () => {
        const Task = await defineTask([{ id: 't1', project_id: 'p1' }]);
        const a = adapter();
        const ref = { type: 'ad-task', id: 't1' };
        await inStore(async () => {
          const first = await a.ancestors(ref);
          await db.raw(`UPDATE "${db.table(Task)}" SET project_id = 'p2'`, [], dialect);
          expect(await a.ancestors(ref)).to.deep.equal(first);
        });
        await inStore(async () => {
          expect((await a.ancestors(ref))![1]).to.deep.equal({ type: 'project', id: 'p2' });
        });
        await db.raw(`UPDATE "${db.table(Task)}" SET project_id = 'p3'`, [], dialect);
        expect((await a.ancestors(ref))![1]).to.deep.equal({ type: 'project', id: 'p3' });
        await db.raw(`UPDATE "${db.table(Task)}" SET project_id = 'p4'`, [], dialect);
        expect((await a.ancestors(ref))![1]).to.deep.equal({ type: 'project', id: 'p4' });
      });

      it('load under SYSTEM; several classes per type are searched in registration order', async () => {
        const decorate = (cls: typeof ModelBase) => AccessResource('ad-multi')(cls);
        await db.define({ name: 'First', columns: { v: T.text }, rows: [{ id: 'x', v: 'first' }], decorate }, dialect);
        await db.define(
          {
            name: 'Second',
            columns: { v: T.text },
            rows: [
              { id: 'x', v: 'second' },
              { id: 'y', v: 'second' },
            ],
            decorate,
          },
          dialect,
        );
        const a = adapter();
        expect(((await a.load!({ type: 'ad-multi', id: 'x' })) as any).v).to.equal('first');
        expect(((await a.load!({ type: 'ad-multi', id: 'y' })) as any).v).to.equal('second');
        expect(await a.load!({ type: 'ad-multi', id: 'z' })).to.equal(null);
        expect(await a.load!({ type: 'ad-multi' })).to.equal(null);
      });

      it('numeric primary keys match canonical number strings only', async () => {
        await db.define({ name: 'Num', columns: { id: T.int, v: T.text }, rows: [{ id: 5, v: 'five' }], decorate: (cls) => AccessResource('ad-num')(cls) }, dialect);
        const a = adapter();
        expect(((await a.load!({ type: 'ad-num', id: '5' })) as any).v).to.equal('five');
        expect(await a.load!({ type: 'ad-num', id: '05' })).to.equal(null);
        expect(await a.load!({ type: 'ad-num', id: '5.0' })).to.equal(null);
        expect(await a.ancestors({ type: 'ad-num', id: 'x' })).to.equal(null);
      });

      it('attribute normalises per column kind; a non-column is undefined', async () => {
        const Task = await defineTask([{ id: 't1', title: 'a', n: 3, r: 1.5, done: dialect === 'postgres' ? true : 1, due: '2024-01-01 00:00:00' }, { id: 't2' }]);
        const a = adapter();
        const rows = (await asSystem(() => (Task as any).all())) as ModelBase[];
        const t1 = rows.find((r: any) => r.id === 't1')!;
        const t2 = rows.find((r: any) => r.id === 't2')!;
        expect(a.attribute!(t1, 'title')).to.equal('a');
        expect(a.attribute!(t1, 'n')).to.equal(3);
        expect(a.attribute!(t1, 'r')).to.equal(1.5);
        expect(a.attribute!(t1, 'done')).to.equal(true);
        expect(a.attribute!(t1, 'due')).to.equal(OPAQUE);
        expect(a.attribute!(t2, 'title')).to.equal(null);
        expect(a.attribute!(t2, 'n')).to.equal(null);
        expect(a.attribute!(t2, 'done'), 'NULL hydrates to false through the boolean converter').to.equal(false);
        expect(a.attribute!(t2, 'due')).to.equal(null);
        expect(a.attribute!(t1, 'nope')).to.equal(undefined);
        expect(a.attribute!(t1, 'constructor')).to.equal(undefined);
        expect(a.attribute!({ title: 'a' }, 'title')).to.equal(undefined);
      });

      if (dialect === 'sqlite') {
        it('sqlite: a value of another storage class in a typed column is opaque', async () => {
          const Task = await defineTask([{ id: 't1', n: 'abc' }]);
          const [row] = (await asSystem(() => (Task as any).all())) as ModelBase[];
          expect(adapter().attribute!(row, 'n')).to.equal(OPAQUE);
        });
      }

      if (dialect === 'sqlite') {
        it('sqlite: a scope value that is no id of its column is no ancestor', async () => {
          await defineTask([
            { id: 't1', org_id: 'abc' },
            { id: 't2', org_id: 2.5 },
          ]);
          expect(await adapter().ancestors({ type: 'ad-task', id: 't1' })).to.deep.equal([{ type: 'ad-task', id: 't1' }, GLOBAL]);
          expect(await adapter().ancestors({ type: 'ad-task', id: 't2' })).to.deep.equal([{ type: 'ad-task', id: 't2' }, { type: 'org', id: '2.5' }, GLOBAL]);
        });
      }

      if (dialect === 'postgres') {
        it('postgres: uuid and int8 columns take part in ids by their text form', async () => {
          const u = '6f9619ff-8b86-d011-b42d-00cf4fc964ff';
          await db.define(
            {
              name: 'Big',
              columns: { id: 'BIGINT', org: 'UUID', when: 'TIMESTAMP' },
              rows: [{ id: '9007199254740993', org: u, when: '2024-01-01' }],
              decorate: (cls, proto) => {
                AccessResource('ad-big')(cls);
                ScopeColumn('org', 'org')(proto, 'org');
                ScopeColumn('when', 'day')(proto, 'when');
              },
            },
            dialect,
          );
          const a = adapter();
          expect(await a.ancestors({ type: 'ad-big', id: '9007199254740993' })).to.deep.equal([{ type: 'ad-big', id: '9007199254740993' }, { type: 'org', id: u }, GLOBAL]);
          expect(await a.load!({ type: 'ad-big', id: '9007199254740992' })).to.equal(null);
          expect(await a.load!({ type: 'ad-big', id: '99999999999999999999' })).to.equal(null);
          expect(await a.load!({ type: 'ad-big', id: '1e3' })).to.equal(null);
          await db.define({ name: 'Dec', columns: { id: 'NUMERIC' }, rows: [{ id: '12.50' }], decorate: (cls) => AccessResource('ad-dec')(cls) }, dialect);
          expect(await a.load!({ type: 'ad-dec', id: '1x5' }), 'not a numeric literal: a miss, not a cast error').to.equal(null);
          expect(await a.load!({ type: 'ad-dec', id: '12.5' }), 'the text form is 12.50').to.equal(null);
          expect(((await a.load!({ type: 'ad-dec', id: '12.50' })) as any).id).to.equal('12.50');
        });
      }

      if (dialect === 'postgres') {
        it('postgres: a uuid primary key matches its text form; an invalid id is a miss, not an error', async () => {
          const id = '6f9619ff-8b86-d011-b42d-00cf4fc964ff';
          await db.define({ name: 'Uuid', columns: { id: T.uuid, v: T.text }, rows: [{ id, v: 'u' }], decorate: (cls) => AccessResource('ad-uuid')(cls) }, dialect);
          const a = adapter();
          expect(((await a.load!({ type: 'ad-uuid', id })) as any).v).to.equal('u');
          expect(await a.load!({ type: 'ad-uuid', id: id.toUpperCase() })).to.equal(null);
          expect(await a.load!({ type: 'ad-uuid', id: 'not-a-uuid' })).to.equal(null);
        });
      }

      it('ancestors read the scope column by its column name, not the decorated property', async () => {
        await db.define(
          {
            name: 'Renamed',
            columns: { project_id: T.text },
            rows: [{ id: 'r1', project_id: 'p1' }],
            decorate: (cls, proto) => {
              AccessResource('ad-renamed')(cls);
              ScopeColumn('project_id', 'project')(proto, 'ProjectId');
            },
          },
          dialect,
        );
        expect(await adapter().ancestors({ type: 'ad-renamed', id: 'r1' })).to.deep.equal([{ type: 'ad-renamed', id: 'r1' }, { type: 'project', id: 'p1' }, GLOBAL]);
      });

      it('a failed ancestors load is not memoised; the memoised list is frozen', async () => {
        const Task = await defineTask([{ id: 't1', project_id: 'p1' }]);
        const table = db.table(Task);
        const ref = { type: 'ad-task', id: 't1' };
        await inStore(async () => {
          await db.raw(`ALTER TABLE "${table}" RENAME TO "${table}_away"`, [], dialect);
          let failed = false;
          try {
            await adapter().ancestors(ref);
          } catch {
            failed = true;
          }
          await db.raw(`ALTER TABLE "${table}_away" RENAME TO "${table}"`, [], dialect);
          expect(failed).to.equal(true);
          const list = await adapter().ancestors(ref);
          expect(list![1]).to.deep.equal({ type: 'project', id: 'p1' });
          expect(Object.isFrozen(list)).to.equal(true);
          expect(Object.isFrozen(list![1])).to.equal(true);
        });
      });

      it('loads run as SYSTEM', async () => {
        await defineTask([{ id: 't1' }]);
        const seen: string[] = [];
        class Spy extends QueryMiddleware {
          afterQueryCreation(): void {
            seen.push(currentPrincipal().type);
          }
          beforeQueryExecution(): void {}
        }
        DI.register(Spy).as(QueryMiddleware);
        // Builders cache the resolved middleware list; rebuild it with and without the spy.
        DI.uncache(QueryMiddleware);
        try {
          await inStore(() => adapter().load!({ type: 'ad-task', id: 't1' }));
        } finally {
          DI.unregister(Spy);
          DI.uncache(Spy);
          DI.uncache(QueryMiddleware);
        }
        expect(seen).to.deep.equal(['system']);
      });

      it('scopeAttributes never returns a name that is not a column', async () => {
        await db.define({ name: 'Odd', columns: { v: T.text }, rows: [{ id: 'o1', v: 'x' }], decorate: (cls) => AccessResource('ad-odd', { attributes: ['v', 'constructor', 'save'] })(cls) }, dialect);
        expect(await adapter().scopeAttributes!({ type: 'ad-odd', id: 'o1' })).to.deep.equal({ v: 'x' });
      });

      it('scopeAttributes: listed columns only, JSON parsed; no row is null; no attributes is {}', async () => {
        await db.define(
          {
            name: 'Org',
            columns: { name: T.text, policies: T.json, broken: T.json },
            rows: [{ id: 'o1', name: 'gold', policies: '{"level":"gold"}', broken: dialect === 'sqlite' ? '{nope' : null }],
            decorate: (cls) => AccessResource('ad-org', { attributes: ['policies', 'broken'] })(cls),
          },
          dialect,
        );
        await defineTask([{ id: 't1' }]);
        const a = adapter();
        const attrs = await a.scopeAttributes!({ type: 'ad-org', id: 'o1' });
        expect(attrs).to.deep.equal(dialect === 'sqlite' ? { policies: { level: 'gold' } } : { policies: { level: 'gold' }, broken: null });
        expect(await a.scopeAttributes!({ type: 'ad-org', id: 'o9' })).to.equal(null);
        expect(await a.scopeAttributes!({ type: 'ad-task', id: 't1' })).to.deep.equal({});
      });

      it('a JSON column decorated with @Json is used as hydrated', async () => {
        await db.define(
          {
            name: 'OrgJ',
            columns: { policies: T.text },
            rows: [{ id: 'o1', policies: '{"level":"gold"}' }],
            decorate: (cls, proto) => {
              Json()(proto, 'policies');
              AccessResource('ad-orgj', { attributes: ['policies'] })(cls);
            },
          },
          dialect,
        );
        expect(await adapter().scopeAttributes!({ type: 'ad-orgj', id: 'o1' })).to.deep.equal({ policies: { level: 'gold' } });
      });
    });
  }

  it('compiles lists the registered native compilers', () => {
    class FakeOp extends OrmNativeCompiler {
      readonly op = 'native:test.fake' as const;
      compile(): void {}
    }
    DI.register(FakeOp).as(OrmNativeCompiler);
    try {
      expect(adapter().compiles).to.deep.equal([...CORE_FILTER_OPS, 'native:test.fake']);
    } finally {
      DI.unregister(FakeOp);
      DI.uncache(FakeOp);
      DI.uncache(OrmNativeCompiler);
    }
  });

  it('the contributor names the join-scoped types', async () => {
    await db.define({ name: 'Joined', columns: { v: 'TEXT' }, decorate: (cls) => AccessResource('ad-joined', { relationScope: 'join' })(cls) });
    await db.define({ name: 'Plain', columns: { v: 'TEXT' }, decorate: (cls) => AccessResource('ad-plain')(cls) });
    const { joinTypes } = await new OrmAuthzContributor().contribute();
    expect(joinTypes).to.include('ad-joined');
    expect(joinTypes).to.not.include('ad-plain');
  });
});
