import { GLOBAL } from '@spinajs/authz';
import type { Assignment, RuleDef, ScopeAttributeSchema } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';

import { toSqlForm } from '../../src/index.js';
import { RbacBound, RbacRoleGraphSource, RbacScopeAttributeSource, ident, ormRbacScopeLayers, outer, renderSql, rsql } from '../../src/orm/index.js';
import type { RbacScopePath, RbacSql } from '../../src/orm/index.js';
import { RootOrm } from '../orm/root-orm.js';
import type { Kind } from '../orm/root-orm.js';
import { rawQuery } from '../support/db.js';
import { DOC_PATH, NODES, ROWS, classCount, compareForms, compileTerm, createTables, dropTables, evaluate, loadRows, tenantLayers, termNamed, termsOf } from './classes-world.js';
import type { Compared, DocRow } from './classes-world.js';
import { DAY, LADDERS, RouteWorld, assignment, at, registerRouteSources, u, user } from './route-world.js';
import type { RouteWorldOptions } from './route-world.js';

/*
 * S1 task 2a: the rule list terms worked out once per class of rows (compile/classes.ts). On Postgres each case
 * compares the class form, with the representatives taken first and last by id, with the per-row form row for row
 * (three-valued), and checks the class keys: rows that differ in what a rule reads are apart, rows that differ only
 * in what no rule reads share a class. SQLite keeps the per-row form.
 */

type Rule = Omit<RuleDef, 'source'>;

const P = (id: string) => at('project', id);
const O = (id: string) => at('org', id);
const ann = user('ann');
const PROJECT_DEFAULTS: ScopeAttributeSchema = { scopeType: 'project', schema: {}, defaults: { tier: 'basic' } };
// A rule that keeps the route term in RbacRulesSql without reading anything of the row.
const STRIP: Rule = { id: 'c0', kind: 'cap', scope: GLOBAL, stripTags: true };

const sameKey = (c: Compared, a: number | string, b: number | string): boolean => c.keys!.get(String(a)) === c.keys!.get(String(b));

function expectRows(c: Compared, want: Readonly<Record<string, boolean | null>>): void {
  for (const [id, v] of Object.entries(want)) expect(c.rows.get(id), `${c.term.name}, per row, row ${id}`).to.equal(v);
}

function expectApart(c: Compared, pairs: readonly (readonly [number | string, number | string])[]): void {
  expect(c.keys, `${c.term.name}: the class form was chosen`).to.not.equal(undefined);
  for (const [a, b] of pairs) expect(sameKey(c, a, b), `${c.term.name}: rows ${a} and ${b} in different classes (${c.keys!.get(String(a))} / ${c.keys!.get(String(b))})`).to.equal(false);
}

function expectTogether(c: Compared, pairs: readonly (readonly [number | string, number | string])[]): void {
  expect(c.keys, `${c.term.name}: the class form was chosen`).to.not.equal(undefined);
  for (const [a, b] of pairs) expect(sameKey(c, a, b), `${c.term.name}: rows ${a} and ${b} in one class (${c.keys!.get(String(a))} / ${c.keys!.get(String(b))})`).to.equal(true);
}

describe('authz-rbac orm-compile: rule list terms worked out once per class of rows (S1)', function () {
  this.timeout(1800000);

  let db: RootOrm;
  let undoSources: (() => void) | undefined;

  before(async function () {
    db = await RootOrm.open(this, 's1_classes');
    await (await testHost.domains()).service('root');
    undoSources = registerRouteSources();
  });

  after(async () => {
    undoSources?.();
    DI.uncache(RbacRoleGraphSource);
    DI.uncache(RbacScopeAttributeSource);
    await db?.close();
  });

  const open = async (kind: Kind): Promise<{ world: RouteWorld; driver: OrmDriver }> => {
    const world = await RouteWorld.open(db, kind);
    const driver = db.driver(kind);
    await createTables(driver);
    return { world, driver };
  };

  describe('sqlite keeps the per-row form', () => {
    let world: RouteWorld;
    let driver: OrmDriver;

    before(async () => {
      ({ world, driver } = await open('sqlite'));
    });

    after(async () => {
      if (driver) await dropTables(driver);
      await world?.close();
    });

    it("builds the SQL it builds without the model's table, with config and stored rules", async () => {
      await world.configure({
        rules: [{ id: 'r1', kind: 'restrict', scope: O('o1'), allow: [], when: { attr: 'scope.project.tier', eq: 'gold' } }, STRIP],
        dbRules: [{ id: 't1', kind: 'threshold', scope: P('10'), permissions: ['*'], minRole: 'maintainer', resource: { attr: 'resource.name', glob: 'tmp*' }, resourceTypes: ['doc'] }],
        schemas: [PROJECT_DEFAULTS],
      });
      await world.assign([assignment(u('ann'), 'viewer', GLOBAL)]);
      await loadRows(driver, [
        [1, 10, 'o1', 'tmp1'],
        [2, 12, 'o1', 'doc'],
      ]);
      const terms = termsOf(await world.residual(ann, 'doc:read'));
      expect(terms.length, 'a route term and the stored rules threshold term').to.equal(2);
      const render = (t: RbacSql) => renderSql(t, { driver, outer: (c) => `"r"."${c}"`, outerName: 'r' });
      for (const term of terms) {
        let keys = 0;
        const now = new Date();
        const withTable = compileTerm(world, driver, term, { now, testOnly: { keys: () => keys++ } });
        expect(keys, `${term.name}: no class form on SQLite`).to.equal(0);
        expect(render(withTable), term.name).to.deep.equal(render(compileTerm(world, driver, term, { now, rowTable: null })));
        expect(render(withTable), term.name).to.deep.equal(render(compileTerm(world, driver, term, { now, testOnly: { rows: true } })));
        // And it runs.
        expect([...(await evaluate(driver, { t: withTable })).keys()].sort()).to.deep.equal(['1', '2']);
      }
    });
  });

  describe('postgres', () => {
    let world: RouteWorld;
    let driver: OrmDriver;
    const extraTables: string[] = [];

    before(async () => {
      ({ world, driver } = await open('postgres'));
    });

    after(async () => {
      if (driver) await dropTables(driver, extraTables);
      await world?.close();
    });

    async function scenario(options: RouteWorldOptions, assignments: readonly Assignment[], rows: readonly DocRow[]): Promise<void> {
      await world.configure(options);
      await world.assign(assignments);
      await loadRows(driver, rows);
    }

    it('splits on an assignment of the subjects (one that expires later too), and merges rows that differ only in untouched ids', async () => {
      await scenario(
        { rules: [STRIP] },
        [assignment(u('ann'), 'viewer', P('10'), { expiresAt: new Date(Date.now() + DAY) })],
        [
          [1, 10, 'o1'],
          [2, 10, 'o2'],
          [3, 12, 'o1'],
          [4, 13, 'o2'],
          [5, 14, 'o1'],
          [6, 15, null],
          [7, 12, 'o10'],
        ],
      );
      const route = termNamed(await compareForms(world, driver, ann, 'doc:read'), 'route');
      expectRows(route, { 1: true, 2: true, 3: false, 4: false, 5: false, 6: false, 7: false });
      expectApart(route, [
        [1, 3],
        [5, 6],
      ]);
      expectTogether(route, [
        [1, 2],
        [3, 4],
        [3, 5],
        [3, 7],
      ]);
      expect(classCount(route.keys!), 'one representative per class').to.equal(3);
    });

    it('splits on a stored rule visible to the row type (any kind), never on one whose resource types exclude it', async () => {
      await scenario(
        {
          dbRules: [
            { id: 'r1', kind: 'restrict', scope: P('11'), allow: [], resourceTypes: ['doc'] },
            { id: 'r2', kind: 'restrict', scope: P('12'), allow: [], resourceTypes: ['project'] },
            { id: 't1', kind: 'threshold', scope: P('13'), permissions: ['*'], minRole: 'maintainer', resourceTypes: ['doc'] },
          ],
        },
        [assignment(u('ann'), 'viewer', GLOBAL)],
        [
          [1, 10, 'o1'],
          [2, 11, 'o1'],
          [3, 11, 'o2'],
          [4, 12, 'o1'],
          [5, 12, 'o2'],
          [6, 13, 'o1'],
          [7, 13, 'o2'],
          [8, 14, 'o1'],
        ],
      );
      const terms = await compareForms(world, driver, ann, 'doc:read');
      const route = termNamed(terms, 'route');
      const denies = termNamed(terms, 'threshold db');
      expectRows(route, { 1: true, 2: false, 3: false, 4: true, 5: true, 6: true, 7: true, 8: true });
      expectRows(denies, { 1: false, 2: false, 4: false, 6: true, 7: true, 8: false });
      for (const c of [route, denies]) {
        expectApart(c, [
          [2, 1],
          [6, 1],
          [8, 1],
        ]);
        // r2 is for projects only: project 12 is as untouched as project 10 (canvas: branch thresholds).
        expectTogether(c, [
          [1, 4],
          [4, 5],
          [2, 3],
        ]);
      }
    });

    it('splits on an attribute row of a type the rules read, not of a type they do not read', async () => {
      await scenario(
        {
          rules: [{ id: 'r1', kind: 'restrict', scope: O('o1'), allow: [], when: { attr: 'scope.project.tier', eq: 'gold' } }],
          schemas: [PROJECT_DEFAULTS],
          attributes: [
            [P('12'), { tier: 'gold' }],
            [O('o2'), { policies: { level: 1 } }],
          ],
        },
        [assignment(u('ann'), 'viewer', GLOBAL)],
        [
          [1, 12, 'o1'],
          [2, 13, 'o1'],
          [3, 11, 'o1'],
          [4, 13, 'o2'],
          [5, 13, 'o10'],
        ],
      );
      const route = termNamed(await compareForms(world, driver, ann, 'doc:read'), 'route');
      expectRows(route, { 1: false, 2: true, 3: true, 4: true, 5: true });
      expectApart(route, [[1, 2]]);
      expectTogether(route, [
        [2, 3],
        [4, 5],
      ]);
    });

    it("splits on a config rule's scope id", async () => {
      await scenario(
        { rules: [{ id: 'r1', kind: 'restrict', scope: P('13'), allow: [] }] },
        [assignment(u('ann'), 'viewer', GLOBAL)],
        [
          [1, 13, 'o1'],
          [2, 12, 'o1'],
          [3, 14, 'o1'],
        ],
      );
      const route = termNamed(await compareForms(world, driver, ann, 'doc:read'), 'route');
      expectRows(route, { 1: false, 2: true, 3: true });
      expectApart(route, [[1, 2]]);
      expectTogether(route, [[2, 3]]);
    });

    it("keeps a node id of '' apart from an untouched id", async () => {
      await scenario(
        {
          rules: [{ id: 'r1', kind: 'restrict', scope: P('10'), allow: [], when: { attr: 'scope.org.policies.locked', eq: true } }],
          schemas: [{ scopeType: 'org', schema: {}, defaults: { policies: { locked: false } } }],
          attributes: [[O('o1'), { policies: { locked: true } }]],
        },
        [assignment(u('ann'), 'viewer', GLOBAL)],
        [
          [1, 10, ''],
          [2, 10, 'o3'],
          [3, 10, 'o1'],
          [4, 10, 'o4'],
        ],
      );
      // org read from the store: no `exists` bit, so only '' itself keeps row 1 apart.
      const layers = { ...ormRbacScopeLayers(driver), org: { kind: 'store' as const } };
      const route = termNamed(await compareForms(world, driver, ann, 'doc:read', { layers }), 'route');
      expectRows(route, { 1: false, 2: true, 3: false, 4: true });
      expectApart(route, [
        [1, 2],
        [3, 2],
      ]);
      expectTogether(route, [[2, 4]]);
    });

    it('splits by shape (a NULL scope column) and by the exists of an untouched node', async () => {
      await scenario(
        { rules: [{ id: 'r1', kind: 'restrict', scope: GLOBAL, allow: [{ type: 'user', id: 'ann' }], when: { attr: 'scope.project.tier', eq: 'gold' } }], schemas: [PROJECT_DEFAULTS] },
        [assignment(u('ann'), 'viewer', GLOBAL)],
        [
          [1, null, 'o1'],
          [2, 14, 'o1'],
          [3, 15, 'o1'],
          [4, 12, 'o1'],
          [5, 13, 'o1'],
        ],
      );
      const route = termNamed(await compareForms(world, driver, ann, 'doc:read'), 'route');
      // Project 14 and 15 have no project row: the read faults there.
      expectRows(route, { 1: true, 2: false, 3: false, 4: true, 5: true });
      expectApart(route, [
        [1, 2],
        [2, 4],
      ]);
      expectTogether(route, [
        [2, 3],
        [4, 5],
      ]);
    });

    it("keys a field a stored rule's resource pattern reads, only where such a rule sits on the row's path", async () => {
      await scenario(
        { dbRules: [{ id: 't1', kind: 'threshold', scope: P('10'), permissions: ['*'], minRole: 'maintainer', resource: { attr: 'resource.name', glob: 'tmp*' }, resourceTypes: ['doc'] }] },
        [assignment(u('ann'), 'viewer', GLOBAL)],
        [
          [1, 10, 'o1', 'tmp1'],
          [2, 10, 'o1', 'doc1'],
          [3, 10, 'o1', 'tmp2'],
          [4, 11, 'o1', 'tmp1'],
          [5, 11, 'o1', 'doc1'],
          [6, 10, 'o1', null],
        ],
      );
      const denies = termNamed(await compareForms(world, driver, ann, 'doc:read'), 'threshold db');
      expectRows(denies, { 1: true, 2: false, 3: true, 4: false, 5: false });
      expectApart(denies, [
        [1, 2],
        [1, 6],
      ]);
      expectTogether(denies, [[4, 5]]);
    });

    it('keys a path column a stored resource pattern reads (r2 C1)', async () => {
      await scenario(
        { dbRules: [{ id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['*'], minRole: 'maintainer', resource: { attr: 'resource.org_id', glob: 'tmp-*' }, resourceTypes: ['doc'] }] },
        [assignment(u('ann'), 'viewer', GLOBAL)],
        [
          [1, 10, 'tmp-1'],
          [2, 10, 'doc-2'],
          [3, 10, 'tmp-3'],
        ],
      );
      const denies = termNamed(await compareForms(world, driver, ann, 'doc:read'), 'threshold db');
      expectRows(denies, { 1: true, 2: false, 3: true });
      expectApart(denies, [
        [1, 2],
        [3, 2],
      ]);
    });

    it('keys every column of the row an exists reads, path columns too (r3 N2), and any other column the flag reads (r2 I3)', async () => {
      await rawQuery(driver, `DELETE FROM "${NODES}"`, [], QueryContext.Delete);
      await rawQuery(driver, `INSERT INTO "${NODES}" ("id", "org_id", "tenant") VALUES (10, 'o1', 't1')`, [], QueryContext.Insert);
      await scenario(
        { rules: [{ id: 'r1', kind: 'restrict', scope: GLOBAL, allow: [{ type: 'user', id: 'ann' }], when: { attr: 'scope.project.tier', eq: 'gold' } }], schemas: [PROJECT_DEFAULTS] },
        [assignment(u('ann'), 'viewer', P('10'))],
        [
          [1, 10, 'o1', null, 't1'],
          [2, 10, 'o1', null, 't2'],
          [3, 10, 'o2', null, 't1'],
          [4, 10, 'o1', null, 't1'],
        ],
      );
      const route = termNamed(await compareForms(world, driver, ann, 'doc:read', { layers: tenantLayers(driver) }), 'route');
      expectRows(route, { 1: true, 2: false, 3: false, 4: true });
      expectApart(route, [
        [1, 2],
        [1, 3],
      ]);
      expectTogether(route, [[1, 4]]);
    });

    it('keys a column the flag reads that the exists probe does not see (r2 I3: checked on the compiled flag)', async () => {
      await rawQuery(driver, `DELETE FROM "${NODES}"`, [], QueryContext.Delete);
      await rawQuery(driver, `INSERT INTO "${NODES}" ("id", "org_id", "tenant") VALUES (10, 'o1', 't1')`, [], QueryContext.Insert);
      await scenario(
        { rules: [{ id: 'r1', kind: 'restrict', scope: GLOBAL, allow: [{ type: 'user', id: 'ann' }], when: { attr: 'scope.project.tier', eq: 'gold' } }], schemas: [PROJECT_DEFAULTS] },
        [assignment(u('ann'), 'viewer', P('10'))],
        [
          [1, 10, 'o1', null, 't1'],
          [2, 10, 'o1', null, 't2'],
        ],
      );
      // Reads the row's tenant only for an id that is no bound value: what a constant probe would never show.
      const n = (c: string) => rsql`${ident('authz_np', c)}`;
      const sly = (nodeId: RbacSql) => (nodeId.parts.some((p) => p instanceof RbacBound) ? rsql`EXISTS (SELECT 1 FROM ${ident(NODES)} ${ident('authz_np')} WHERE CAST(${n('id')} AS TEXT) = ${nodeId})` : rsql`EXISTS (SELECT 1 FROM ${ident(NODES)} ${ident('authz_np')} WHERE CAST(${n('id')} AS TEXT) = ${nodeId} AND ${n('tenant')} = ${outer('tenant')})`);
      const layers = { ...ormRbacScopeLayers(driver), project: { kind: 'adapter' as const, attributes: [], exists: sly } };
      const route = termNamed(await compareForms(world, driver, ann, 'doc:read', { layers }), 'route');
      expectRows(route, { 1: true, 2: false });
      expectApart(route, [[1, 2]]);
    });

    it('a class without a representative: a threshold term denies (fail closed), a route term is FALSE', async () => {
      const copy = 's1c_copy';
      extraTables.push(copy);
      await rawQuery(driver, `CREATE TABLE "${copy}" ("id" INT PRIMARY KEY, "project_id" INT, "org_id" TEXT, "name" TEXT, "tenant" TEXT)`, [], QueryContext.Schema);
      const rows: DocRow[] = [
        [1, 10, 'o1'],
        [2, 11, 'o1'],
        [3, 12, 'o2'],
        [4, 13, 'o1'],
      ];
      await scenario(
        {
          dbRules: [
            { id: 'r1', kind: 'restrict', scope: P('11'), allow: [], resourceTypes: ['doc'] },
            { id: 't1', kind: 'threshold', scope: P('13'), permissions: ['*'], minRole: 'maintainer', resourceTypes: ['doc'] },
          ],
        },
        [assignment(u('ann'), 'viewer', GLOBAL)],
        rows,
      );
      // The representatives come from a table holding only project 11's row: the other rows' classes are missing.
      await loadRows(driver, [rows[1]], copy);
      const terms = await compareForms(world, driver, ann, 'doc:read');
      for (const name of ['route', 'threshold db']) {
        const c = termNamed(terms, name);
        const missing = compileTerm(world, driver, c.term, { rowTable: copy, testOnly: { order: 'asc' } });
        const got = await evaluate(driver, { t: missing }, ROWS);
        const present = c.keys!.get('2');
        for (const [id, want] of c.rows) {
          const v = got.get(id)!.t;
          if (c.keys!.get(id) === present) expect(v, `${name}, row ${id}: its class has a representative`).to.equal(want);
          else expect(v, `${name}, row ${id}: no representative`).to.equal(name !== 'route');
        }
      }
      // Rows 1 and 3 (untouched projects and orgs whose rows exist) share a class; row 4's project is touched.
      expect(classCount(termNamed(terms, 'route').keys!), 'classes').to.equal(3);
    });

    it('records the error surface (r2 I5): a stored rule Postgres cannot read fails every list of the model, also one that does not reach it', async () => {
      const bad: Rule = { id: 'r1', kind: 'restrict', scope: O('o2'), allow: [] };
      const form = toSqlForm(bad, LADDERS);
      await scenario(
        { dbRules: [] },
        [assignment(u('ann'), 'viewer', GLOBAL)],
        [
          [1, 10, 'o1'],
          [2, 10, 'o2'],
        ],
      );
      await world.writeRawRules([{ rule: { ...form.rule, definition: '{bad' }, subjects: form.subjects.map((s) => ({ ...s })) }]);
      const [route] = termsOf(await world.residual(ann, 'doc:read'));
      const onlyO1 = rsql`${outer('org_id')} = ${'o1'}`;
      const perRow = await evaluate(driver, { t: compileTerm(world, driver, route, { testOnly: { rows: true } }) }, ROWS, onlyO1);
      expect([...perRow].map(([id, v]) => [id, v.t])).to.deep.equal([['1', true]]);
      const failed = await evaluate(driver, { t: compileTerm(world, driver, route) }, ROWS, onlyO1).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(failed, 'the class form reads the rule for the representative of org o2').to.be.instanceOf(Error);
    });

    describe('a model whose id and scope columns declare another collation (r2 I2, r3 N1)', () => {
      const PATH: RbacScopePath = {
        type: 'doc',
        idColumn: 'id',
        idMode: 'string',
        scopes: [
          { column: 'project_id', scopeType: 'project', idMode: 'string' },
          { column: 'org_id', scopeType: 'org', idMode: 'string' },
        ],
      };
      // Rows that differ only in letter case, touched ('o1', 'O1', 'p1') and untouched ('P1', 'P9', 'p9', 'o2').
      const ROWS_CI: DocRow[] = [
        ['a', 'p1', 'o1'],
        ['b', 'P1', 'o1'],
        ['c', 'P9', 'o1'],
        ['d', 'p9', 'O1'],
        ['e', 'p9', 'o2'],
        ['A', 'p1', 'o2'],
        ['B', 'P1', 'O1'],
      ];
      // r1 drops ann's GLOBAL viewer under org 'O1' only; r2 under org 'o1' where the project's tier is gold ('p1' only).
      const WANT = { a: false, b: true, c: true, d: false, e: true, A: true, B: false };

      async function collated(collation: string): Promise<void> {
        const table = `s1c_coll_${extraTables.length}`;
        extraTables.push(table);
        const col = `TEXT COLLATE ${collation}`;
        // No primary key: under a case-insensitive collation it would refuse ids that differ only in case.
        await rawQuery(driver, `CREATE TABLE "${table}" ("id" ${col} NOT NULL, "project_id" ${col}, "org_id" ${col}, "name" TEXT, "tenant" TEXT)`, [], QueryContext.Schema);
        await scenario(
          {
            rules: [
              { id: 'r1', kind: 'restrict', scope: O('O1'), allow: [] },
              { id: 'r2', kind: 'restrict', scope: O('o1'), allow: [], when: { attr: 'scope.project.tier', eq: 'gold' } },
            ],
            schemas: [PROJECT_DEFAULTS],
            attributes: [[P('p1'), { tier: 'gold' }]],
          },
          [assignment(u('ann'), 'viewer', GLOBAL)],
          [],
        );
        await loadRows(driver, ROWS_CI, table);
        const layers = { ...ormRbacScopeLayers(driver), project: { kind: 'store' as const }, org: { kind: 'store' as const } };
        const route = termNamed(await compareForms(world, driver, ann, 'doc:read', { rowTable: table, path: PATH, fields: [], layers }, `collation ${collation}`), 'route');
        expectRows(route, WANT);
        expectApart(route, [
          ['c', 'd'],
          ['a', 'b'],
        ]);
        expectTogether(route, [['b', 'c']]);
      }

      it('"C"', async () => {
        await collated('"C"');
      });

      it('a deterministic ICU collation', async function () {
        if (!(await icu())) return this.skip();
        await rawQuery(driver, `CREATE COLLATION IF NOT EXISTS s1c_und (provider = icu, locale = 'und')`, [], QueryContext.Schema);
        await collated('s1c_und');
      });

      it('a nondeterministic (case-insensitive) ICU collation', async function () {
        if (!(await icu())) return this.skip();
        await rawQuery(driver, `CREATE COLLATION IF NOT EXISTS s1c_ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`, [], QueryContext.Schema);
        await collated('s1c_ci');
      });

      async function icu(): Promise<boolean> {
        const rows = (await rawQuery(driver, `SELECT COUNT(*) AS n FROM pg_collation WHERE collprovider = 'i'`)) as Array<{ n: unknown }>;
        const has = Number(rows[0]?.n) > 0;
        if (!has) console.warn('      skipped: this Postgres server has no ICU collations');
        return has;
      }
    });

    it('every part of a class key is non-NULL (r3 M3), also over NULL columns read as fields', async () => {
      await scenario(
        { rules: [STRIP], dbRules: [{ id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['*'], minRole: 'maintainer', resource: { attr: 'resource.name', glob: 'tmp*' }, resourceTypes: ['doc'] }] },
        [assignment(u('ann'), 'viewer', P('10'))],
        [
          [1, null, null, null, null],
          [2, 10, '', '', ''],
          [3, 10, 'o1', 'tmp1', 't1'],
        ],
      );
      const terms = await compareForms(world, driver, ann, 'doc:read');
      expect(terms.length).to.equal(2);
      for (const c of terms) {
        expect(c.keys, c.term.name).to.not.equal(undefined);
        for (const [id, key] of c.keys!) expect(JSON.parse(key) as unknown[], `${c.term.name} row ${id}`).to.not.include(null);
      }
    });

    it('a row the adapter cannot find (a non-integer number id, an earlier model holding the id) is UNKNOWN in both terms', async () => {
      const table = 's1c_double';
      const shadow = 's1c_shadow';
      extraTables.push(table, shadow);
      await rawQuery(driver, `CREATE TABLE "${table}" ("id" DOUBLE PRECISION PRIMARY KEY, "project_id" DOUBLE PRECISION, "org_id" TEXT, "name" TEXT, "tenant" TEXT)`, [], QueryContext.Schema);
      await rawQuery(driver, `CREATE TABLE "${shadow}" ("id" INT PRIMARY KEY)`, [], QueryContext.Schema);
      await rawQuery(driver, `INSERT INTO "${shadow}" ("id") VALUES (3)`, [], QueryContext.Insert);
      await scenario({ dbRules: [{ id: 't1', kind: 'threshold', scope: P('10'), permissions: ['*'], minRole: 'maintainer', resourceTypes: ['doc'] }] }, [assignment(u('ann'), 'viewer', GLOBAL)], []);
      await loadRows(
        driver,
        [
          [1, 10, 'o1'],
          [2, 10.5, 'o1'],
          [1.5, 10, 'o1'],
          [3, 11, 'o1'],
          [4, 10.5, 'o2'],
          [5, 11, 'o1'],
        ],
        table,
      );
      const path: RbacScopePath = { ...DOC_PATH, earlierKeys: [{ table: shadow, idColumn: 'id', idMode: 'number' }] };
      const terms = await compareForms(world, driver, ann, 'doc:read', { rowTable: table, path });
      const unknown = { 2: null, '1.5': null, 3: null, 4: null };
      expectRows(termNamed(terms, 'route'), { 1: true, 5: true, ...unknown });
      expectRows(termNamed(terms, 'threshold db'), { 1: true, 5: false, ...unknown });
      for (const c of terms) expect(c.keys, `${c.term.name}: the class form was chosen`).to.not.equal(undefined);
    });

    it('a config threshold reading a scope attribute takes the class form and splits on the attribute row', async () => {
      await scenario(
        {
          rules: [{ id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['*'], minRole: 'maintainer', when: { attr: 'scope.project.tier', eq: 'gold' } }],
          schemas: [PROJECT_DEFAULTS],
          attributes: [[P('12'), { tier: 'gold' }]],
        },
        [assignment(u('ann'), 'viewer', GLOBAL)],
        [
          [1, 12, 'o1'],
          [2, 13, 'o1'],
          [3, 11, 'o1'],
          [4, 12, 'o2'],
        ],
      );
      const denies = termNamed(await compareForms(world, driver, ann, 'doc:read'), 'threshold t1');
      expectRows(denies, { 1: true, 2: false, 3: false, 4: true });
      expectApart(denies, [[1, 2]]);
      expectTogether(denies, [
        [2, 3],
        [1, 4],
      ]);
    });

    it('a config threshold reading resource.name keeps the per-row form (r2 I6), with and without stored rules', async () => {
      const rows: DocRow[] = [
        [1, 10, 'o1', 'tmp1'],
        [2, 10, 'o1', 'doc'],
        [3, 11, 'o1', 'tmp2'],
      ];
      const t1: Rule = { id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['*'], minRole: 'maintainer', resource: { attr: 'resource.name', glob: 'tmp*' }, resourceTypes: ['doc'] };
      for (const stored of [false, true]) {
        await scenario({ rules: [t1], ...(stored ? { dbRules: [] } : {}) }, [assignment(u('ann'), 'viewer', GLOBAL)], rows);
        const denies = termNamed(await compareForms(world, driver, ann, 'doc:read', {}, `stored rules ${stored}`), 'threshold t1');
        expectRows(denies, { 1: true, 2: false, 3: true });
        expect(denies.keys, `stored rules ${stored}: no class form`).to.equal(undefined);
      }
    });
  });
});
