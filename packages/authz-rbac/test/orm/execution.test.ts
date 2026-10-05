import { AccessDenied, AuthzConfigError, SYSTEM, runWithPrincipal } from '@spinajs/authz';
import type { Principal, ResourceFilter } from '@spinajs/authz';
import { AccessResource, OrmNativeCompiler, ScopeColumn } from '@spinajs/authz-orm';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { ModelBase } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';

import { RBAC_ASSIGNMENT_OP } from '../../src/index.js';
// The compiler the middleware runs, from the build the package resolves to (one copy of authz-orm).
import { compileResidual } from '../../../authz-orm/lib/mjs/compile/compiler.js';
import { OrmRbacScopePathSource, RbacRoleGraphSource, RbacScopePathSource, TRUE_SQL, whereRbacSql } from '../../src/orm/index.js';
import { bootPostgres, bootSqlite, createSchema, executionCases, parityCases, seed } from './fixture.js';
import type { BootedDb } from './fixture.js';
import { intersectCases } from './intersect.js';
import { CurrentRoleGraphSource, ORM_DOCS, PRINCIPALS, SQLITE_ODD_DOCS, as, assignments, createAssignmentTable, defineDocModels, idsOf, insertAssignments, rbacDomain, user } from './orm-world.js';
import type { DocModels } from './orm-world.js';
import { KINDS, RootOrm } from './root-orm.js';
import type { ModelClass } from './root-orm.js';

describe('authz-rbac orm: native:rbac.assignment on sqlite', function () {
  this.timeout(30000);

  let db: BootedDb;

  before(async () => {
    db = await bootSqlite();
    await createSchema(db.driver);
    await seed(db.driver);
  });

  after(async () => {
    await db?.close();
  });

  executionCases(() => db.driver);
  parityCases(() => db.driver);
  intersectCases(() => db.driver);
});

describe('authz-rbac orm: native:rbac.assignment on postgres', function () {
  this.timeout(60000);

  let db: BootedDb | null = null;

  before(async function () {
    db = await bootPostgres();
    if (!db) {
      if (process.env.L2_REQUIRE_PG === '1') {
        throw new Error('L2_REQUIRE_PG=1 but the postgres server at 127.0.0.1:15432 is unreachable');
      }
      console.warn('    skipped: postgres at 127.0.0.1:15432 is unreachable (set L2_REQUIRE_PG=1 to fail instead)');
      this.skip();
    }
    await createSchema(db.driver);
    await seed(db.driver);
  });

  after(async () => {
    await db?.close();
  });

  executionCases(() => db!.driver);
  parityCases(() => db!.driver);
  intersectCases(() => db!.driver);
});

describe('authz-rbac orm: native:rbac.assignment through authz-orm', function () {
  this.timeout(600000);

  let db: RootOrm;
  let undoSource: (() => void) | undefined;

  before(async function () {
    db = await RootOrm.open(this, 'l4b_exec');
    await (await testHost.domains()).service('root');
    undoSource = testHost.registerInRoot(RbacRoleGraphSource, testHost.instance(new CurrentRoleGraphSource()));
  });

  after(async () => {
    undoSource?.();
    DI.uncache(RbacRoleGraphSource);
    await db?.close();
  });

  it('the default RbacScopePathSource reads the @AccessResource and @ScopeColumn metadata with its id modes', async () => {
    expect(DI.resolve(RbacScopePathSource)).to.be.instanceOf(OrmRbacScopePathSource);
    const { Doc } = await defineDocModels(db, 'postgres');
    try {
      expect(new OrmRbacScopePathSource().path(Doc)).to.deep.equal({
        type: 'doc',
        idColumn: 'id',
        idMode: 'number',
        scopes: [
          { column: 'project_id', scopeType: 'project', idMode: 'number' },
          { column: 'org_id', scopeType: 'org', idMode: 'string' },
        ],
        earlierKeys: [],
      });
      expect(new OrmRbacScopePathSource().path(class NotAResource extends ModelBase {})).to.equal(null);
    } finally {
      await db.clear();
    }
  });

  for (const kind of KINDS) {
    describe(kind, () => {
      let models: DocModels;
      let domain: Awaited<ReturnType<typeof rbacDomain>>;
      const rows = assignments(new Date());

      before(async () => {
        await createAssignmentTable(db.driver(kind), kind);
        await insertAssignments(db.driver(kind), rows);
        models = await defineDocModels(db, kind, kind === 'sqlite' ? SQLITE_ODD_DOCS : []);
        domain = await rbacDomain(rows, models.Doc);
      });

      after(async () => {
        await domain?.dispose();
        await db.clear();
        await db.raw(kind, 'DROP TABLE IF EXISTS "authz_assignment"');
      });

      const query = () => (models.Doc as unknown as { query(): any }).query();
      const INEXACT = kind === 'sqlite' ? ['9.5'] : [];

      /** The ids a select lists for `p`; a FALSE residual is refused before any SQL runs (H16), which lists nothing. */
      async function listed(p: Principal, run: () => Promise<unknown> = () => query()): Promise<string[]> {
        const residual = await domain.service.filter(p, 'doc:read', 'doc');
        try {
          return idsOf(await as(p, run));
        } catch (e) {
          if (e instanceof AccessDenied && residual.op === 'false') return [];
          throw e;
        }
      }

      /** B06: the docs check() allows, one check per row, by the ref the adapter gives the row. */
      async function allowed(p: Principal): Promise<string[]> {
        const out: string[] = [];
        for (const row of (await db.raw(kind, `SELECT "id" FROM "${db.table(models.Doc)}"`)) as Array<{ id: unknown }>) {
          const decision = await domain.service.check({ principal: p, permission: 'doc:read', resource: { type: 'doc', id: String(row.id) } });
          if (decision.allowed) out.push(String(row.id));
        }
        return out.sort();
      }

      it('a select lists exactly the docs check() allows (B06), as do its clones and their counts', async () => {
        let native = 0;
        let listing = 0;
        for (const p of PRINCIPALS) {
          const residual = await domain.service.filter(p, 'doc:read', 'doc');
          if (JSON.stringify(residual).includes(RBAC_ASSIGNMENT_OP)) native++;
          const all = await allowed(p);
          // whenFound makes doc 9.5 UNKNOWN (no block names a non-integer number id), though check() decides it.
          const want = all.filter((id) => !INEXACT.includes(id));
          if (want.length > 0) listing++;
          if (residual.op === 'true') {
            // Engine side, not this SQL: a TRUE residual lists every row, while check() refuses a row the adapter cannot find ('x9').
            const every = idsOf(await as(p, () => query()));
            expect(every, `${kind} ${p.id}: TRUE lists every row`).to.have.length(ORM_DOCS.length + (kind === 'sqlite' ? SQLITE_ODD_DOCS.length : 0));
            expect(all, `${kind} ${p.id}`).to.deep.equal(every.filter((id) => id !== 'x9'));
            continue;
          }
          expect(await listed(p), `${kind} ${p.id}: ${JSON.stringify(residual)}`).to.deep.equal(want);
          if (residual.op === 'false') continue;
          const { copy, count } = await as(p, async () => {
            const q = query();
            return { copy: idsOf(await q.clone().clone().setAlias('copy')), count: Number(await q.clone().selectCount()) };
          });
          expect(copy, `${kind} ${p.id}: a clone`).to.deep.equal(want);
          expect(count, `${kind} ${p.id}: the count of a clone`).to.equal(want.length);
        }
        expect(native, 'principals whose residual holds native:rbac.assignment').to.be.at.least(7);
        expect(listing, 'principals who see a doc').to.be.at.least(6);
        if (kind === 'sqlite') expect(await allowed(user('alice')), 'check() decides doc 9.5').to.include('9.5');
      });

      it('compares ids by the column id modes: case, canonical numbers, NULL and empty ancestors', async () => {
        const list = (id: string) => listed(user(id));
        // SQLite also holds doc 9.5 (UNKNOWN), doc 20 (org o1, project 'p10') and doc 'x9', which the adapter cannot find.
        expect(await list('alice')).to.deep.equal(kind === 'sqlite' ? ['1', '20', '3'] : ['1', '3']);
        expect(await list('bob')).to.deep.equal(['1', '2', '7']);
        expect(await list('dave')).to.deep.equal(['2', '4']);
        expect(await list('hank')).to.deep.equal(['6']);
        expect(await list('kim')).to.deep.equal([]);
        expect(await list('erin')).to.deep.equal([]);
        // 'p10' in an integer column and 'x9' as an integer key are no ids the adapter reads.
        expect(await list('lena')).to.deep.equal([]);
      });

      it('compares ids in the binary collation, though scope_id is case-insensitive here', async () => {
        // Doc 7's org is 'O1'; alice holds org 'o1', bob reaches doc 7 through project 10.
        expect(await listed(user('alice'))).to.not.include('7');
        expect(await listed(user('bob'))).to.include('7');
      });

      it('under NOT the term keeps out exactly the rows it cannot decide', async () => {
        const every = ((await db.raw(kind, `SELECT "id" FROM "${db.table(models.Doc)}"`)) as Array<{ id: unknown }>).map((r) => String(r.id)).sort();
        const undecided = kind === 'sqlite' ? ['9.5', 'x9'] : [];
        const run = (f: ResourceFilter, p: Principal) =>
          runWithPrincipal(SYSTEM, async () => {
            const q = query();
            compileResidual(f, q, { model: models.Doc, principal: p, op: 'read' });
            return idsOf(await q);
          });
        let checked = 0;
        for (const p of PRINCIPALS) {
          const residual = await domain.service.filter(p, 'doc:read', 'doc');
          if (!JSON.stringify(residual).includes(RBAC_ASSIGNMENT_OP)) continue;
          const yes = await run(residual, p);
          const no = await run({ op: 'not', arg: residual }, p);
          expect(
            yes.filter((id) => no.includes(id)),
            `${kind} ${p.id}`,
          ).to.deep.equal([]);
          expect([...yes, ...no].sort(), `${kind} ${p.id}`).to.deep.equal(every.filter((id) => !undecided.includes(id)));
          checked++;
        }
        expect(checked).to.be.at.least(7);
      });

      it('refuses a filtered row aliased as the assignment sub-query, when the query runs', async () => {
        const e = await as(user('alice'), () => query().setAlias('authz_a')).then(
          () => undefined,
          (err: unknown) => err,
        );
        expect(e).to.be.instanceOf(AuthzConfigError);
        expect((e as Error).message).to.match(/authz_a/);
      });

      it("takes a filtered row aliased 'c': the collation name reserves no alias", async () => {
        expect(await listed(user('alice'), () => query().setAlias('c'))).to.deep.equal(await listed(user('alice')));
      });

      it('refuses a fragment on a plain sub-query correlated with the native builder: no fallback to plain SQL', async () => {
        const driver = db.driver(kind);
        class L4bProbeCompiler extends OrmNativeCompiler {
          readonly op = 'native:l4b.probe' as const;
          compile(_args: unknown, builder: IWhereBuilder<unknown>): void {
            const sub = driver.select().from('authz_assignment', 'p').correlateWith(builder);
            whereRbacSql(sub as unknown as IWhereBuilder<unknown>, TRUE_SQL);
            builder.whereExist(sub);
          }
        }
        DI.uncache(OrmNativeCompiler);
        const undo = testHost.registerInRoot(OrmNativeCompiler, L4bProbeCompiler);
        try {
          expect(() => compileResidual({ op: 'native:l4b.probe', args: {} } as unknown as ResourceFilter, query(), { model: models.Doc, principal: user('alice'), op: 'read' })).to.throw(AuthzConfigError, /correlated with an authz-orm native compilation/);
        } finally {
          undo();
          DI.uncache(OrmNativeCompiler);
        }
      });

      it('a later model of the type lists no row whose id an earlier one holds: findRow takes that row (B06)', async () => {
        const later = (name: string, docs: Record<string, unknown>[]) =>
          db.define(
            {
              name,
              columns: { id: 'INT', project_id: 'INT', org_id: 'TEXT' },
              rows: docs,
              decorate: (cls, proto) => {
                AccessResource('doc')(cls);
                ScopeColumn('project_id', 'project')(proto, 'project_id');
                ScopeColumn('org_id', 'org')(proto, 'org_id');
              },
            },
            kind,
          );
        const DocA = await later('DocA', [
          { id: 1, project_id: 11, org_id: null },
          { id: 50, project_id: 11, org_id: null },
        ]);
        const DocB = await later('DocB', [
          { id: 50, project_id: 11, org_id: null },
          { id: 60, project_id: 11, org_id: null },
        ]);
        const queryOf = (model: ModelClass) => () => (model as unknown as { query(): any }).query();
        const idsIn = async (model: ModelClass) => ((await db.raw(kind, `SELECT "id" FROM "${db.table(model)}"`)) as Array<{ id: unknown }>).map((r) => String(r.id));
        const earlier = new Map([
          [DocA, new Set(await idsIn(models.Doc))],
          [DocB, new Set([...(await idsIn(models.Doc)), ...(await idsIn(DocA))])],
        ]);
        let listedRows = 0;
        for (const [model, shadowed] of earlier) {
          for (const p of [user('mia'), user('alice'), user('dave')]) {
            const want: string[] = [];
            for (const id of await idsIn(model)) {
              const decision = await domain.service.check({ principal: p, permission: 'doc:read', resource: { type: 'doc', id } });
              if (decision.allowed && !shadowed.has(id)) want.push(id);
            }
            const got = await listed(p, queryOf(model));
            expect(got, `${kind} ${model.name} ${p.id}`).to.deep.equal(want.sort());
            listedRows += got.length;
          }
        }
        expect(await listed(user('mia'), queryOf(DocA))).to.deep.equal(['50']);
        expect(await listed(user('mia'), queryOf(DocB))).to.deep.equal(['60']);
        // alice reaches doc 1 through Doc's row 1 (org o1): DocA's row 1 is not hers to list.
        expect(await domain.service.check({ principal: user('alice'), permission: 'doc:read', resource: { type: 'doc', id: '1' } })).to.include({ allowed: true });
        expect(await listed(user('alice'), queryOf(DocA))).to.deep.equal([]);
        expect(listedRows).to.be.at.least(2);
      });

      it('an unregistered subclass lists by the path the adapter reads: the registered class key and scope columns (B06)', async () => {
        // findRow loads SBase, the registered class, so ancestors read SBase's scope columns only (project_id).
        const SBase = await db.define(
          {
            name: 'SBase',
            columns: { id: 'INT', project_id: 'INT', org_id: 'TEXT' },
            rows: [
              { id: 101, project_id: 10, org_id: 'o1' },
              { id: 102, project_id: 12, org_id: 'o2' },
            ],
            decorate: (cls, proto) => {
              AccessResource('doc')(cls);
              ScopeColumn('project_id', 'project')(proto, 'project_id');
            },
          },
          kind,
        );
        // On SBase's table, adding a scope column the adapter never reads.
        const Sub = await db.define({ name: 'SSub', columns: {}, base: SBase, table: db.table(SBase), decorate: (_cls, proto) => ScopeColumn('org_id', 'org')(proto, 'org_id') }, kind);
        // A table of its own: findRow never finds its rows.
        const Own = await db.define({ name: 'SOwn', columns: { id: 'INT', project_id: 'INT', org_id: 'TEXT' }, base: SBase, rows: [{ id: 201, project_id: 10, org_id: 'o1' }] }, kind);
        const queryOf = (model: ModelClass) => () => (model as unknown as { query(): any }).query();
        const idsIn = async (model: ModelClass) => ((await db.raw(kind, `SELECT "id" FROM "${db.table(model)}"`)) as Array<{ id: unknown }>).map((r) => String(r.id));
        for (const model of [Sub, Own]) {
          for (const p of [user('alice'), user('bob'), user('dave'), user('mia')]) {
            const want: string[] = [];
            for (const id of await idsIn(model)) {
              const decision = await domain.service.check({ principal: p, permission: 'doc:read', resource: { type: 'doc', id } });
              if (decision.allowed) want.push(id);
            }
            expect(await listed(p, queryOf(model)), `${kind} ${model.name} ${p.id}`).to.deep.equal(want.sort());
          }
        }
        // alice holds org o1: Sub's org_id is no ancestor of row 101.
        expect(await listed(user('alice'), queryOf(Sub))).to.deep.equal([]);
        // bob reaches project 10 through his team set.
        expect(await listed(user('bob'), queryOf(Sub))).to.deep.equal(['101']);
        expect(await listed(user('bob'), queryOf(Own))).to.deep.equal([]);
      });
    });
  }
});
