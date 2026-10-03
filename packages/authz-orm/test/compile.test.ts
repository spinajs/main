import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, GLOBAL, NativeFilter } from '@spinajs/authz';
import type { Principal, ResourceFilter } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { BelongsTo, DeleteQueryBuilder, ModelBase, createQuery } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';

import { AccessResource, OrmNativeCompiler, OrmScope, OrmScopePolicy, Owner, ScopeColumn } from '../src/index.js';
import { compileResidual } from '../src/compile/compiler.js';
import { OrmResourceAdapter } from '../src/adapter.js';
import { TestDb } from './support/db.js';
import type { Dialect } from './support/db.js';
import { Memory, allRows, contextOf, not, sqlIds } from './support/residual.js';
import type { Model } from './support/residual.js';
import { systemIt } from './support/system.js';

const expect = chai.expect;
// The suite tests the compiler, not the middleware: test bodies run as SYSTEM, which it leaves alone.
const it = systemIt;

const user = (id: string, attributes: Record<string, unknown> = {}): Principal => ({ type: 'user', id, authenticated: true, source: 'test', attributes });
const alice = user('alice', { org: 'o1' });

const TYPES: Record<Dialect, { text: string; int: string; real: string; bool: string; date: string; json: string }> = {
  sqlite: { text: 'TEXT', int: 'INTEGER', real: 'REAL', bool: 'BOOLEAN', date: 'DATETIME', json: 'JSON' },
  postgres: { text: 'TEXT', int: 'INTEGER', real: 'DOUBLE PRECISION', bool: 'BOOLEAN', date: 'TIMESTAMP', json: 'JSONB' },
};

const cmp = (field: string, op: string, value?: unknown): ResourceFilter => ({ op: 'cmp', field, cmp: op, value } as ResourceFilter);
const under = (...scopes: unknown[]): ResourceFilter => ({ op: 'under', scopes } as ResourceFilter);
const rel = (relation: string): ResourceFilter => ({ op: 'relation', relation });

// Rows of the main fixture; null cells are left out. `b` is a sqlite storage value (2 is false after
// hydration), mapped to a Postgres boolean.
const DOCS: Record<string, unknown>[] = [{ id: 'd01', s: 'a', n: 1, r: 1.5, b: 1, o: '2020-01-01 00:00:00', owner: 'alice', org_id: 'o1', proj_id: 5 }, { id: 'd02', s: 'b', n: 2, r: 0.1, b: 0, owner: 'bob', org_id: 'o2', proj_id: 7 }, { id: 'd03' }, { id: 'd04', s: 'B', n: 10, r: 1000, b: 2, o: '2021-06-01 12:00:00', owner: 'ALICE', org_id: 'o1' }, { id: 'd05', s: 'é', n: -1, r: -0.5, b: 1, owner: 'alice', proj_id: 5 }, { id: 'd06', s: '\u{1F600}', n: 0, r: 0 }, { id: 'd07', s: 'z', n: 1000 }, { id: 'd08', s: '10', n: 3 }, { id: 'd09', s: '1.0' }, { id: 'd10', s: 'a%c' }, { id: 'd11', s: 'a_c' }, { id: 'd12', s: 'a\\c' }, { id: 'd13', s: 'abc' }, { id: 'd14', s: 'ABC' }, { id: 'd15', s: 'a/b' }, { id: 'd16', s: 'a/b/c' }, { id: 'd17', s: '' }, { id: 'd18', s: '�' }, { id: 'd19', s: "it's" }, { id: 'd20', s: "'; DROP TABLE x; --" }, { id: 'd21', s: 'A' }, { id: 'd22', s: 'ab\u{1F600}' }];
const ALL = DOCS.map((d) => d.id as string).sort();
const WITH_S = DOCS.filter((d) => d.s !== undefined).map((d) => d.id as string);
const others = (ids: string[], pool = ALL): string[] => pool.filter((x) => !ids.includes(x)).sort();

describe('authz-orm residual compiler', function () {
  this.timeout(120000);
  let db: TestDb;
  let pg = false;
  const tracked: (abstract new (...args: never[]) => unknown)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  afterEach(async () => {
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

  for (const dialect of ['sqlite', 'postgres'] as const) {
    describe(dialect, () => {
      const T = TYPES[dialect];
      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      const bool = (v: unknown) => (dialect === 'postgres' && typeof v === 'number' ? v === 1 : v);
      const rowsOf = (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r, ...('b' in r ? { b: bool(r.b) } : {}) }));

      const defineDocs = (opts: { rows?: Record<string, unknown>[]; columns?: Record<string, string>; decorate?: (cls: typeof ModelBase, proto: object) => void } = {}) =>
        db.define(
          {
            name: 'Doc',
            columns: { s: T.text, n: T.int, r: T.real, b: T.bool, o: T.date, j: T.json, owner: T.text, org_id: T.text, proj_id: T.int, ...opts.columns },
            rows: rowsOf(opts.rows ?? DOCS),
            decorate: (cls, proto) => {
              AccessResource('c-doc')(cls);
              Owner()(proto, 'owner');
              ScopeColumn('org_id', 'org')(proto, 'org_id');
              ScopeColumn('proj_id', 'project')(proto, 'proj_id');
              opts.decorate?.(cls, proto);
            },
          },
          dialect,
        );

      /**
       * Compares SQL with the evaluator for `f` and `not f`: equal selections for an exact rule (so
       * TRUE, FALSE and UNKNOWN agree row by row), SQL a subset of the evaluator's for a sound one.
       * Returns the SQL selections.
       */
      const verify = async (model: Model, f: ResourceFilter, mode: 'exact' | 'sound' = 'exact', principal: Principal = alice, memory = new Memory()) => {
        const rows = await allRows(model);
        const out: string[][] = [];
        for (const g of [f, not(f)]) {
          const sql = await sqlIds(model, g, principal);
          const mem = await memory.ids(g, principal, rows);
          if (mode === 'exact') expect(sql, `${dialect} ${JSON.stringify(g)}`).to.deep.equal(mem);
          else expect(mem, `${dialect} ${JSON.stringify(g)}`).to.include.members(sql);
          out.push(sql);
        }
        return { yes: out[0], no: out[1] };
      };

      it('Kleene shape: true, false, empty and/or, nested not, the depth cap', async () => {
        const Doc = await defineDocs();
        expect((await verify(Doc, { op: 'true' })).yes).to.deep.equal(ALL);
        expect((await verify(Doc, { op: 'false' })).no).to.deep.equal(ALL);
        expect((await verify(Doc, { op: 'and', args: [] })).yes).to.deep.equal(ALL);
        expect((await verify(Doc, { op: 'or', args: [] })).yes).to.deep.equal([]);
        await verify(Doc, { op: 'and', args: [cmp('s', 'eq', 'a'), { op: 'or', args: [cmp('n', 'eq', 1), cmp('s', 'eq', 'b')] }] });
        let deep: ResourceFilter = cmp('s', 'eq', 'a');
        for (let i = 0; i < 300; i++) deep = not(deep);
        const r = await verify(Doc, deep);
        expect(r.yes.concat(r.no), 'beyond the evaluator depth cap every row is UNKNOWN').to.deep.equal([]);
        let nested: ResourceFilter = cmp('s', 'eq', 'a');
        for (let i = 0; i < 300; i++) nested = { op: i % 2 ? 'and' : 'or', args: [{ op: i % 2 ? 'and' : 'or', args: [nested] }] };
        const n = await verify(Doc, nested);
        expect(n.yes.concat(n.no)).to.deep.equal([]);
        let shallow: ResourceFilter = cmp('s', 'eq', 'a');
        for (let i = 0; i < 60; i++) shallow = not(i % 3 ? shallow : { op: 'and', args: [shallow] });
        expect((await verify(Doc, shallow)).yes).to.deep.equal(['d01']);
      });

      it('NULL cells are UNKNOWN: neither a comparison nor its not selects them', async () => {
        const Doc = await defineDocs();
        const r = await verify(Doc, cmp('s', 'eq', 'a'));
        expect(r.yes).to.deep.equal(['d01']);
        expect(r.no).to.deep.equal(others(['d01'], WITH_S));
        expect((await verify(Doc, cmp('n', 'gt', 1))).no).to.deep.equal(['d01', 'd05', 'd06']);
        expect((await verify(Doc, cmp('s', 'null'))).yes).to.deep.equal(['d03']);
        expect((await verify(Doc, cmp('s', 'notnull'))).no).to.deep.equal(['d03']);
      });

      it('strings order by code point and compare case-sensitively in the binary collation', async () => {
        const Doc = await defineDocs();
        expect((await verify(Doc, cmp('s', 'lt', 'a'))).yes).to.deep.equal(['d04', 'd08', 'd09', 'd14', 'd17', 'd20', 'd21']);
        expect((await verify(Doc, cmp('s', 'gt', 'z'))).yes).to.deep.equal(['d05', 'd06', 'd18']);
        expect((await verify(Doc, cmp('s', 'gt', '�'))).yes, 'a supplementary character sorts above U+FFFD').to.deep.equal(['d06']);
        expect((await verify(Doc, cmp('s', 'lte', 'é'))).no).to.deep.equal(['d06', 'd18']);
        expect((await verify(Doc, cmp('s', 'eq', 'A'))).yes).to.deep.equal(['d21']);
        await verify(Doc, cmp('s', 'gte', 'B'));
        await verify(Doc, cmp('s', 'ne', 'abc'));
      });

      it(`a case-insensitive column collation does not widen equality, IN, LIKE or ids`, async () => {
        let collate = 'COLLATE NOCASE';
        if (dialect === 'postgres') {
          await db.raw(`DO $$ BEGIN CREATE COLLATION authz_orm_ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false); EXCEPTION WHEN duplicate_object THEN NULL; END $$`, [], dialect);
          collate = 'COLLATE authz_orm_ci';
        }
        const Doc = await defineDocs({
          columns: { s: `TEXT ${collate}`, owner: `TEXT ${collate}`, org_id: `TEXT ${collate}` },
          rows: [
            { id: 'c1', s: 'a', owner: 'alice', org_id: 'o1' },
            { id: 'c2', s: 'A', owner: 'ALICE', org_id: 'O1' },
            { id: 'c3', s: 'alice', owner: 'Alice', org_id: 'o2' },
            { id: 'c4', s: 'ALICE', owner: null, org_id: null },
          ],
        });
        expect((await verify(Doc, cmp('s', 'eq', 'A'))).yes).to.deep.equal(['c2']);
        expect((await verify(Doc, cmp('s', 'in', ['A', 'ALICE']))).yes).to.deep.equal(['c2', 'c4']);
        expect((await verify(Doc, cmp('s', 'like', 'A%'))).yes).to.deep.equal(['c2', 'c4']);
        expect((await verify(Doc, cmp('s', 'lt', 'a'))).yes).to.deep.equal(['c2', 'c4']);
        expect((await verify(Doc, rel('owner'))).yes).to.deep.equal(['c1']);
        expect((await verify(Doc, under({ type: 'org', id: 'O1' }))).yes).to.deep.equal(['c2']);
        if (dialect === 'postgres') {
          await db.clear();
          await db.raw('DROP COLLATION IF EXISTS authz_orm_ci', [], dialect);
        }
      });

      it('in and nin: empty lists fold, items coerce per kind, NULL cells stay UNKNOWN', async () => {
        const Doc = await defineDocs();
        expect((await verify(Doc, cmp('s', 'in', []))).yes).to.deep.equal([]);
        expect((await verify(Doc, cmp('s', 'nin', []))).yes, 'nin [] holds for NULL cells too').to.deep.equal(ALL);
        expect((await verify(Doc, cmp('nope', 'in', []))).yes).to.deep.equal([]);
        const n = await verify(Doc, cmp('n', 'in', [1, '2', 'x', '01']));
        expect(n.yes).to.deep.equal(['d01', 'd02']);
        expect(n.no, 'an item that cannot compare leaves a miss UNKNOWN').to.deep.equal([]);
        expect((await verify(Doc, cmp('n', 'nin', [1, '2']))).yes).to.deep.equal(['d04', 'd05', 'd06', 'd07', 'd08']);
        expect((await verify(Doc, cmp('s', 'in', ['a', 'B', 'x']))).yes).to.deep.equal(['d01', 'd04']);
        expect((await verify(Doc, cmp('s', 'nin', ['a', 'B']))).yes).to.deep.equal(others(['d01', 'd04'], WITH_S));
        expect((await verify(Doc, cmp('b', 'in', [1]))).yes).to.deep.equal(['d01', 'd05']);
        expect((await verify(Doc, cmp('b', 'in', [0, 'x']))).no).to.deep.equal([]);
        await verify(Doc, cmp('b', 'nin', [0, 1]));
        expect((await verify(Doc, cmp('o', 'in', ['2020-01-01 00:00:00']))).yes).to.deep.equal([]);
        // A malformed list is UNKNOWN as a whole.
        for (const bad of [[true], [null], [Number.NaN], 'a', { ref: 'principal.id' }]) expect((await verify(Doc, cmp('n', 'in', bad))).no).to.deep.equal([]);
        // A number item against a string column: the row is coerced only when canonical, which SQL cannot test.
        const s = await verify(Doc, cmp('s', 'in', ['a', 10]), 'sound');
        expect(s.yes).to.deep.equal(['d01', 'd08']);
        expect(s.no).to.deep.equal([]);
      });

      it('a number value against a string column is decided only on equal text (sound)', async () => {
        const Doc = await defineDocs();
        expect((await verify(Doc, cmp('s', 'eq', 10), 'sound')).yes).to.deep.equal(['d08']);
        expect((await verify(Doc, cmp('s', 'lte', 10), 'sound')).yes).to.deep.equal(['d08']);
        expect((await verify(Doc, cmp('s', 'ne', 1), 'sound')).yes).to.deep.equal([]);
        await verify(Doc, cmp('s', 'gt', 1), 'sound');
      });

      it('like: % and _ by code point, \\ escapes, a trailing \\ is UNKNOWN, case-sensitive', async () => {
        const Doc = await defineDocs();
        expect((await verify(Doc, cmp('s', 'like', 'a%'))).yes).to.deep.equal(['d01', 'd10', 'd11', 'd12', 'd13', 'd15', 'd16', 'd22']);
        expect((await verify(Doc, cmp('s', 'like', 'A%'))).yes).to.deep.equal(['d14', 'd21']);
        expect((await verify(Doc, cmp('s', 'like', 'a_c'))).yes).to.deep.equal(['d10', 'd11', 'd12', 'd13']);
        expect((await verify(Doc, cmp('s', 'like', 'a\\%c'))).yes).to.deep.equal(['d10']);
        expect((await verify(Doc, cmp('s', 'like', 'a\\_c'))).yes).to.deep.equal(['d11']);
        expect((await verify(Doc, cmp('s', 'like', 'a\\\\c'))).yes).to.deep.equal(['d12']);
        expect((await verify(Doc, cmp('s', 'like', 'ab_'))).yes, '_ is one code point').to.deep.equal(['d13', 'd22']);
        expect((await verify(Doc, cmp('s', 'like', '%*%'))).yes).to.deep.equal([]);
        expect((await verify(Doc, cmp('s', 'like', '%[%'))).yes).to.deep.equal([]);
        const trailing = await verify(Doc, cmp('s', 'like', 'a\\'));
        expect(trailing.yes.concat(trailing.no)).to.deep.equal([]);
        expect((await verify(Doc, cmp('n', 'like', '1%'))).no, 'a number column never matches a pattern').to.deep.equal([]);
        expect((await verify(Doc, cmp('s', 'like', 1))).no).to.deep.equal([]);
      });

      it('wildcard: * is any run, / included; every other character is literal', async () => {
        const Doc = await defineDocs();
        expect((await verify(Doc, cmp('s', 'wildcard', 'a*'))).yes).to.deep.equal(['d01', 'd10', 'd11', 'd12', 'd13', 'd15', 'd16', 'd22']);
        expect((await verify(Doc, cmp('s', 'wildcard', 'a*c'))).yes).to.deep.equal(['d10', 'd11', 'd12', 'd13', 'd16']);
        expect((await verify(Doc, cmp('s', 'wildcard', 'a%c'))).yes).to.deep.equal(['d10']);
        expect((await verify(Doc, cmp('s', 'wildcard', 'a_c'))).yes).to.deep.equal(['d11']);
        expect((await verify(Doc, cmp('s', 'wildcard', 'a\\c'))).yes).to.deep.equal(['d12']);
        expect((await verify(Doc, cmp('s', 'wildcard', '*'))).yes).to.deep.equal(WITH_S.slice().sort());
        await verify(Doc, cmp('s', 'wildcard', '?'));
        await verify(Doc, cmp('s', 'wildcard', '[a]*'));
      });

      it('glob: ** crosses /, * does not; patterns SQLite cannot express are UNKNOWN there', async () => {
        const Doc = await defineDocs();
        expect((await verify(Doc, cmp('s', 'glob', 'a/*'))).yes).to.deep.equal(['d15']);
        expect((await verify(Doc, cmp('s', 'glob', 'a/**'))).yes).to.deep.equal(['d15', 'd16']);
        expect((await verify(Doc, cmp('s', 'glob', 'a*'))).yes).to.deep.equal(['d01', 'd10', 'd11', 'd12', 'd13', 'd22']);
        expect((await verify(Doc, cmp('s', 'glob', '**'))).yes).to.deep.equal(WITH_S.slice().sort());
        expect((await verify(Doc, cmp('s', 'glob', '*'))).yes).to.deep.equal(others(['d15', 'd16'], WITH_S));
        expect((await verify(Doc, cmp('s', 'glob', 'a%c'))).yes).to.deep.equal(['d10']);
        const inner = await verify(Doc, cmp('s', 'glob', '*/b'), dialect === 'sqlite' ? 'sound' : 'exact');
        expect(inner.yes).to.deep.equal(dialect === 'sqlite' ? [] : ['d15']);
        await verify(Doc, cmp('s', 'glob', 'a/*/c'), dialect === 'sqlite' ? 'sound' : 'exact');
        await verify(Doc, cmp('s', 'glob', '**/*'), dialect === 'sqlite' ? 'sound' : 'exact');
      });

      it('numeric strings against a number column: canonical only (1, not 01, 1.0 or 1e3)', async () => {
        const Doc = await defineDocs();
        expect((await verify(Doc, cmp('n', 'eq', '1'))).yes).to.deep.equal(['d01']);
        for (const v of ['01', '1.0', '1e3', ' 1', '-0', 'x', '']) {
          const r = await verify(Doc, cmp('n', 'eq', v));
          expect(r.yes.concat(r.no), v).to.deep.equal([]);
        }
        expect((await verify(Doc, cmp('n', 'eq', '1000'))).yes).to.deep.equal(['d07']);
        expect((await verify(Doc, cmp('n', 'lt', '2'))).yes).to.deep.equal(['d01', 'd05', 'd06']);
        expect((await verify(Doc, cmp('n', 'lt', 1.5))).yes, 'an integer column compares with a fraction').to.deep.equal(['d01', 'd05', 'd06']);
        expect((await verify(Doc, cmp('r', 'gte', 1.5))).yes).to.deep.equal(['d01', 'd04']);
        expect((await verify(Doc, cmp('r', 'eq', '0.1'))).yes).to.deep.equal(['d02']);
        expect((await verify(Doc, cmp('n', 'eq', 1e300))).no).to.deep.equal(['d01', 'd02', 'd04', 'd05', 'd06', 'd07', 'd08']);
      });

      it('booleans against true/false and 0/1/2; numbers against booleans', async () => {
        const Doc = await defineDocs();
        const truthy = ['d01', 'd05'];
        expect((await verify(Doc, cmp('b', 'eq', true))).yes).to.deep.equal(truthy);
        expect((await verify(Doc, cmp('b', 'eq', false))).yes, 'NULL and 2 hydrate to false').to.deep.equal(others(truthy));
        expect((await verify(Doc, cmp('b', 'eq', 1))).yes).to.deep.equal(truthy);
        expect((await verify(Doc, cmp('b', 'ne', 0))).yes).to.deep.equal(truthy);
        for (const f of [cmp('b', 'eq', 2), cmp('b', 'eq', 'true'), cmp('b', 'lt', true), cmp('b', 'gte', 1)]) {
          const r = await verify(Doc, f);
          expect(r.yes.concat(r.no), JSON.stringify(f)).to.deep.equal([]);
        }
        expect((await verify(Doc, cmp('b', 'null'))).yes).to.deep.equal([]);
        expect((await verify(Doc, cmp('b', 'notnull'))).yes).to.deep.equal(ALL);
        const n = await verify(Doc, cmp('n', 'eq', true));
        expect(n.yes).to.deep.equal(['d01']);
        expect(n.no).to.deep.equal(['d06']);
        expect((await verify(Doc, cmp('n', 'ne', false))).yes).to.deep.equal(['d01']);
        const ord = await verify(Doc, cmp('n', 'lt', true));
        expect(ord.yes.concat(ord.no)).to.deep.equal([]);
      });

      it('opaque columns only answer null and notnull; a field that is not a column is null', async () => {
        const Doc = await defineDocs();
        for (const f of [cmp('o', 'eq', '2020-01-01 00:00:00'), cmp('o', 'gt', ''), cmp('o', 'like', '%'), cmp('j', 'eq', 'x'), cmp('nope', 'eq', 'a'), cmp('nope', 'like', '%'), cmp('nope', 'in', ['a'])]) {
          const r = await verify(Doc, f);
          expect(r.yes.concat(r.no), JSON.stringify(f)).to.deep.equal([]);
        }
        expect((await verify(Doc, cmp('o', 'notnull'))).yes).to.deep.equal(['d01', 'd04']);
        expect((await verify(Doc, cmp('j', 'null'))).yes).to.deep.equal(ALL);
        expect((await verify(Doc, cmp('nope', 'null'))).yes).to.deep.equal(ALL);
        expect((await verify(Doc, cmp('nope', 'notnull'))).yes).to.deep.equal([]);
        expect((await verify(Doc, cmp('s" = \'a\' OR "s', 'null'))).yes, 'a field name is never SQL').to.deep.equal(ALL);
      });

      it('a { ref } or another non-literal value left in the residual is UNKNOWN', async () => {
        const Doc = await defineDocs();
        const ref = { ref: 'principal.id' };
        for (const f of [cmp('s', 'eq', ref), cmp('s', 'in', ref), cmp('s', 'like', ref), cmp('s', 'eq', null), cmp('n', 'eq', [1]), cmp('s', 'eq', {}), cmp('n', 'lt', Number.NaN)]) {
          const r = await verify(Doc, f);
          expect(r.yes.concat(r.no), JSON.stringify(f)).to.deep.equal([]);
        }
      });

      it('values never reach the SQL text: quotes, %, backslashes and -- compare as data', async () => {
        const Doc = await defineDocs();
        expect((await verify(Doc, cmp('s', 'eq', "'; DROP TABLE x; --"))).yes).to.deep.equal(['d20']);
        expect((await verify(Doc, cmp('s', 'eq', "it's"))).yes).to.deep.equal(['d19']);
        expect((await verify(Doc, cmp('s', 'eq', "a' OR '1'='1"))).yes).to.deep.equal([]);
        expect((await verify(Doc, cmp('s', 'in', ["it's", "x') OR ('1'='1"]))).yes).to.deep.equal(['d19']);
        expect((await verify(Doc, cmp('s', 'like', "%'%"))).yes).to.deep.equal(['d19', 'd20']);
        expect((await verify(Doc, cmp('s', 'like', '%--%'))).yes).to.deep.equal(['d20']);
        expect((await verify(Doc, cmp('s', 'glob', "**'**"))).yes).to.deep.equal(['d19', 'd20']);
        expect((await verify(Doc, cmp('s', 'eq', 'a\\'))).yes).to.deep.equal([]);
        expect((await verify(Doc, under({ type: 'org', id: "o1' OR '1'='1" }))).yes).to.deep.equal([]);
        expect((await verify(Doc, rel('owner'), 'exact', user("alice' --"))).yes).to.deep.equal([]);
        expect((await verify(Doc, cmp('s', 'eq', '?'))).yes, 'a ? in a value is not a placeholder').to.deep.equal([]);
        expect(await allRows(Doc)).to.have.length(DOCS.length);
      });

      it('strings a row cannot hold: a lone surrogate (both), NUL (Postgres)', async () => {
        const Doc = await defineDocs();
        const r = await verify(Doc, cmp('s', 'eq', '\uD800'));
        expect(r.yes).to.deep.equal([]);
        expect(r.no).to.deep.equal(WITH_S.slice().sort());
        await verify(Doc, cmp('s', 'in', ['\uD800', 'a']));
        await verify(Doc, cmp('s', 'like', 'a\uDC00%'));
        await verify(Doc, cmp('s', 'lt', '\uD800'), 'sound');
        expect((await verify(Doc, under({ type: 'org', id: '\uD800' }))).yes).to.deep.equal([]);
        if (dialect === 'postgres') {
          expect((await verify(Doc, cmp('s', 'eq', 'a\u0000'))).no).to.deep.equal(WITH_S.slice().sort());
          await verify(Doc, cmp('s', 'like', '%\u0000%'));
          await verify(Doc, cmp('s', 'glob', '**\u0000*'));
          await verify(Doc, cmp('s', 'in', ['a\u0000', 'b']));
          expect((await verify(Doc, rel('owner'), 'exact', user('alice\u0000'))).yes).to.deep.equal([]);
        }
      });

      it('under: $global, own type, scope column types with and without id, other types', async () => {
        const Doc = await defineDocs();
        expect((await verify(Doc, under(GLOBAL))).yes).to.deep.equal(ALL);
        expect((await verify(Doc, under({ type: 'c-doc' }))).yes).to.deep.equal(ALL);
        expect((await verify(Doc, under({ type: 'c-doc', id: 'd01' }))).yes).to.deep.equal(['d01']);
        expect((await verify(Doc, under({ type: 'org' }))).yes).to.deep.equal(['d01', 'd02', 'd04']);
        expect((await verify(Doc, under({ type: 'org', id: 'o1' }))).yes).to.deep.equal(['d01', 'd04']);
        expect((await verify(Doc, under({ type: 'org', id: 'o1' }))).no, 'two-valued: a NULL scope column is FALSE').to.deep.equal(others(['d01', 'd04']));
        expect((await verify(Doc, under({ type: 'project', id: '5' }))).yes).to.deep.equal(['d01', 'd05']);
        expect((await verify(Doc, under({ type: 'project', id: '05' }))).yes).to.deep.equal([]);
        expect((await verify(Doc, under({ type: 'project' }))).yes).to.deep.equal(['d01', 'd02', 'd05']);
        expect((await verify(Doc, under({ type: 'other' }, { type: 'other', id: 'x' }, { type: GLOBAL.type, id: 'x' }))).yes).to.deep.equal([]);
        expect((await verify(Doc, under({ type: 'org', id: 'o2' }, { type: 'project', id: '5' }))).yes).to.deep.equal(['d01', 'd02', 'd05']);
        expect((await verify(Doc, under())).no).to.deep.equal(ALL);
        expect((await verify(Doc, under({ type: 'org', id: null }))).yes).to.deep.equal(['d01', 'd02', 'd04']);
        for (const bad of [[{ type: 'org', id: 5 }], [{ id: 'o1' }], ['org'], [undefined]]) {
          const r = await verify(Doc, under(...bad));
          expect(r.yes.concat(r.no), JSON.stringify(bad)).to.deep.equal([]);
        }
        const notList = await verify(Doc, { op: 'under', scopes: 'org' } as never);
        expect(notList.yes.concat(notList.no)).to.deep.equal([]);
      });

      it('under and owner on numeric keys: canonical ids only; a key the adapter cannot look up is UNKNOWN', async () => {
        const huge = 2 ** 60;
        const Num = await db.define(
          {
            name: 'Num',
            columns: { id: dialect === 'sqlite' ? 'INTEGER' : 'DOUBLE PRECISION', parent_id: T.int, owner: T.int },
            rows: [
              { id: 5, parent_id: 5, owner: 7 },
              { id: 7, parent_id: null, owner: 5 },
              { id: huge, parent_id: 5, owner: 5 },
              { id: 0, parent_id: 1, owner: null },
            ],
            decorate: (cls, proto) => {
              AccessResource('c-num')(cls);
              Owner()(proto, 'owner');
              ScopeColumn('parent_id', 'project')(proto, 'parent_id');
            },
          },
          dialect,
        );
        const H = String(huge);
        expect((await verify(Num, under({ type: 'c-num', id: '5' }))).yes).to.deep.equal(['5']);
        expect((await verify(Num, under({ type: 'c-num', id: '05' }))).yes).to.deep.equal([]);
        expect((await verify(Num, under({ type: 'project', id: '5' }))).yes).to.deep.equal(['5']);
        expect((await verify(Num, under({ type: 'project', id: '05' }))).yes).to.deep.equal([]);
        const g = await verify(Num, under(GLOBAL));
        expect(g.yes).to.deep.equal(['0', '5', '7']);
        expect(g.no, `${H} has no ancestors in memory`).to.deep.equal([]);
        expect((await verify(Num, rel('owner'), 'exact', user('5'))).yes, 'a key that is no id never owns').to.deep.equal(['7']);
        expect((await verify(Num, rel('owner'), 'exact', user('05'))).no).to.deep.equal(['0', '5', '7', H].sort());
      });

      if (dialect === 'postgres') {
        it('postgres: uuid, int8 and numeric keys compare by their text form; NaN cannot be looked up', async () => {
          const u1 = '0b9a3c34-7f0e-4c7a-9a65-2b1f7f0e9d11';
          const Num = await db.define(
            {
              name: 'Numeric',
              columns: { id: 'NUMERIC', org: 'UUID', big: 'BIGINT' },
              rows: [
                { id: '15', org: u1, big: '9007199254740993' },
                { id: '1.50', org: null, big: '5' },
                { id: 'NaN', org: u1, big: null },
              ],
              decorate: (cls, proto) => {
                AccessResource('c-numeric')(cls);
                ScopeColumn('org', 'org')(proto, 'org');
                ScopeColumn('big', 'big')(proto, 'big');
              },
            },
            dialect,
          );
          expect((await verify(Num, under({ type: 'c-numeric', id: '1.50' }))).yes).to.deep.equal(['1.50']);
          expect((await verify(Num, under({ type: 'c-numeric', id: '1.5' }))).yes).to.deep.equal([]);
          expect((await verify(Num, under({ type: 'org', id: u1 }))).yes).to.deep.equal(['15']);
          expect((await verify(Num, under({ type: 'org', id: u1.toUpperCase() }))).yes).to.deep.equal([]);
          expect((await verify(Num, under({ type: 'big', id: '9007199254740993' }))).yes).to.deep.equal(['15']);
          const g = await verify(Num, under(GLOBAL));
          expect(g.yes).to.deep.equal(['1.50', '15']);
          expect(g.no).to.deep.equal([]);
        });
      }

      it('relation owner: the user whose id is the owner value, two-valued under not', async () => {
        const Doc = await defineDocs();
        const r = await verify(Doc, rel('owner'));
        expect(r.yes).to.deep.equal(['d01', 'd05']);
        expect(r.no).to.deep.equal(others(['d01', 'd05']));
        expect((await verify(Doc, rel('owner'), 'exact', user('ALICE'))).yes).to.deep.equal(['d04']);
        for (const p of [{ ...alice, type: 'agent' }, { type: 'system', id: 'alice' }, user('\uD800')] as Principal[]) {
          expect((await verify(Doc, rel('owner'), 'exact', p)).yes).to.deep.equal([]);
        }
        expect((await verify(Doc, { op: 'and', args: [rel('owner'), not(under({ type: 'org', id: 'o1' }))] })).yes).to.deep.equal(['d05']);
      });

      it('relation through @OrmScope: EXISTS by pk with the policy scope for the query op, two-valued under not', async () => {
        const ops: string[] = [];
        const Member = track(
          class MemberPolicy extends OrmScopePolicy {
            scope(q: IWhereBuilder<ModelBase>, p: Principal, op: 'read' | 'update' | 'delete'): void {
              ops.push(op);
              q.where('org_id', String(p.attributes.org)).orWhere('s', 'shared');
            }
          },
        );
        const Doc = await defineDocs({
          rows: [{ id: 'm1', org_id: 'o1' }, { id: 'm2', org_id: 'o2', s: 'shared' }, { id: 'm3' }, { id: 'm4', org_id: 'o2', s: 'x' }],
          decorate: (cls) => OrmScope(cls as never, 'member')(Member),
        });
        const r = await verify(Doc, rel('member'));
        expect(r.yes).to.deep.equal(['m1', 'm2']);
        expect(r.no).to.deep.equal(['m3', 'm4']);
        expect(ops).to.include('read');

        const q = createQuery(Doc, DeleteQueryBuilder).query;
        compileResidual(not(rel('member')), q as never, contextOf(Doc, alice, 'delete'));
        expect(ops[ops.length - 1]).to.equal('delete');
        await q;
        expect((await allRows(Doc)).map((x: any) => x.id).sort(), 'delete with a correlated EXISTS on an unaliased table').to.deep.equal(['m1', 'm2']);
      });

      it('a relation of the type that this model lacks is FALSE; an unknown relation throws', async () => {
        const Doc = await defineDocs();
        await db.define({ name: 'Other', columns: { owner: T.text }, decorate: (cls) => AccessResource('c-doc')(cls) }, dialect);
        const Plain = await db.define({ name: 'Plain', columns: { v: T.text }, rows: [{ id: 'p1' }], decorate: (cls) => AccessResource('c-plain')(cls) }, dialect);
        void Doc;
        expect(() => compileResidual(rel('owner'), (Plain as any).query(), contextOf(Plain, alice))).to.throw(AuthzConfigError, /owner/);
        expect(() => compileResidual(rel('member'), (Plain as any).query(), contextOf(Plain, alice))).to.throw(AuthzConfigError, /member/);
        const Shared = await db.define({ name: 'Shared', columns: { v: T.text }, rows: [{ id: 's1' }], decorate: (cls) => AccessResource('c-doc')(cls) }, dialect);
        const r = await verify(Shared, rel('owner'));
        expect(r.yes).to.deep.equal([]);
        expect(r.no).to.deep.equal(['s1']);
      });

      it('an @Owner on a property that is not a column is a configuration error', async () => {
        const Bad = await db.define(
          {
            name: 'BadOwner',
            columns: { v: T.text },
            decorate: (cls, proto) => {
              AccessResource('c-bad')(cls);
              Owner()(proto, 'ownerId');
            },
          },
          dialect,
        );
        expect(() => compileResidual(rel('owner'), (Bad as any).query(), contextOf(Bad, alice))).to.throw(AuthzConfigError, /ownerId/);
      });

      it('native ops compile through the registered OrmNativeCompiler; NOT covers its whole fragment', async () => {
        const calls: unknown[][] = [];
        const Flag = track(
          class FlagCompiler extends OrmNativeCompiler {
            readonly op = 'native:test.flag' as const;
            compile(args: unknown, builder: IWhereBuilder<unknown>, model: unknown, principal: Principal): void {
              calls.push([args, model, principal]);
              builder.where('s', 'a').orWhere('s', 'b');
            }
          },
        );
        class FlagFilter extends NativeFilter {
          readonly op = 'native:test.flag' as const;
          matches(_args: unknown, subject: unknown): boolean {
            const s = (subject as { s?: unknown }).s;
            return s === 'a' || s === 'b';
          }
        }
        DI.register(Flag).as(OrmNativeCompiler);
        try {
          const Doc = await defineDocs({
            rows: [
              { id: 'n1', s: 'a' },
              { id: 'n2', s: 'b' },
              { id: 'n3', s: 'c' },
            ],
          });
          const memory = new Memory(new Map([['native:test.flag', new FlagFilter()]]));
          const r = await verify(Doc, { op: 'native:test.flag', args: { k: 1 } }, 'exact', alice, memory);
          expect(r.yes).to.deep.equal(['n1', 'n2']);
          expect(r.no).to.deep.equal(['n3']);
          expect(calls[0]).to.deep.equal([{ k: 1 }, Doc, alice]);
          expect(() => compileResidual({ op: 'native:test.none' }, (Doc as any).query(), contextOf(Doc, alice))).to.throw(AuthzConfigError, /native:test.none/);
        } finally {
          DI.unregister(Flag);
          DI.uncache(OrmNativeCompiler);
        }
      });

      it('an async policy scope or native compile is refused, never read as TRUE', async () => {
        const Late = track(
          class LatePolicy extends OrmScopePolicy {
            // eslint-disable-next-line @typescript-eslint/require-await
            async scope(q: IWhereBuilder<ModelBase>): Promise<void> {
              q.where('s', 'never');
            }
          } as unknown as abstract new () => OrmScopePolicy,
        );
        const LateNative = track(
          class LateNativeCompiler extends OrmNativeCompiler {
            readonly op = 'native:test.late' as const;
            // eslint-disable-next-line @typescript-eslint/require-await
            async compile(_a: unknown, builder: IWhereBuilder<unknown>): Promise<void> {
              builder.where('s', 'never');
            }
          } as unknown as abstract new () => OrmNativeCompiler,
        );
        const Doc = await defineDocs({ rows: [{ id: 'l1', s: 'a' }], decorate: (cls) => OrmScope(cls as never, 'late')(Late as never) });
        expect(() => compileResidual(rel('late'), (Doc as any).query(), contextOf(Doc, alice))).to.throw(AuthzConfigError, /promise/);
        let inMemory: unknown;
        try {
          await new OrmResourceAdapter().relations!()
            .find((r) => r.relation === 'late' && r.type === 'c-doc')!
            .holds(alice, { type: 'c-doc', id: 'l1' });
        } catch (e) {
          inMemory = e;
        }
        expect(inMemory, 'the default holds refuses it too').to.be.instanceOf(AuthzConfigError);
        DI.register(LateNative as never).as(OrmNativeCompiler);
        try {
          expect(() => compileResidual({ op: 'native:test.late' }, (Doc as any).query(), contextOf(Doc, alice))).to.throw(AuthzConfigError, /promise/);
        } finally {
          DI.unregister(LateNative as never);
          DI.uncache(OrmNativeCompiler);
        }
      });

      it('two OrmNativeCompilers for one op are a configuration error', async () => {
        const A = track(
          class TwinA extends OrmNativeCompiler {
            readonly op = 'native:test.twin' as const;
            compile(): void {}
          },
        );
        const B = track(
          class TwinB extends OrmNativeCompiler {
            readonly op = 'native:test.twin' as const;
            compile(): void {}
          },
        );
        DI.register(A).as(OrmNativeCompiler);
        DI.register(B).as(OrmNativeCompiler);
        try {
          const Doc = await defineDocs({ rows: [] });
          expect(() => compileResidual({ op: 'native:test.twin' }, (Doc as any).query(), contextOf(Doc, alice))).to.throw(AuthzConfigError, /two OrmNativeCompilers/);
        } finally {
          DI.unregister(A);
          DI.unregister(B);
          DI.uncache(OrmNativeCompiler);
        }
      });

      it('an unknown op, cmp operator or malformed node throws AuthzConfigError', async () => {
        const Doc = await defineDocs({ rows: [] });
        const q = () => (Doc as any).query();
        for (const f of [{ op: 'bogus' }, cmp('s', 'regex', 'a'), { op: 'and' }, { op: 'cmp', cmp: 'eq', value: 'a' }, { op: 'relation' }, { op: 'not', arg: 5 }]) {
          expect(() => compileResidual(f as never, q(), contextOf(Doc, alice)), JSON.stringify(f)).to.throw(AuthzConfigError);
        }
        expect(() => compileResidual({ op: 'true' }, q(), { model: ModelBase as never, principal: alice, op: 'read' })).to.throw(AuthzConfigError);
      });

      it('another driver is a configuration error naming it', async () => {
        const Doc = await defineDocs({ rows: [] });
        const driver = { Options: { Driver: 'orm-driver-mysql' } };
        expect(() => compileResidual({ op: 'true' }, (Doc as any).query(), { ...contextOf(Doc, alice), driver: driver as never })).to.throw(AuthzConfigError, /orm-driver-mysql/);
      });

      it('a driver of the other dialect than the model connection is a configuration error', async function () {
        if (!pg) this.skip();
        const Doc = await defineDocs({ rows: [] });
        const other = db.driver(dialect === 'sqlite' ? 'postgres' : 'sqlite');
        expect(() => compileResidual({ op: 'true' }, (Doc as any).query(), { ...contextOf(Doc, alice), driver: other })).to.throw(AuthzConfigError, new RegExp(`lives on a ${dialect} connection`));
      });

      it('the residual is qualified with the alias the builder has when it builds', async () => {
        const Doc = await defineDocs();
        const f: ResourceFilter = { op: 'or', args: [cmp('s', 'eq', 'a'), rel('owner'), under({ type: 'org', id: 'o1' })] };
        const memory = await new Memory().ids(f, alice, await allRows(Doc));
        expect(memory).to.deep.equal(['d01', 'd04', 'd05']);

        const before = (Doc as any).query().setAlias('q1');
        compileResidual(f, before, contextOf(Doc, alice));
        const after = (Doc as any).query();
        compileResidual(f, after, contextOf(Doc, alice));
        after.setAlias('q2');
        for (const [q, alias] of [
          [before, 'q1'],
          [after, 'q2'],
        ] as const) {
          const text: string = q.toDB().expression;
          expect(text).to.match(new RegExp(`[\`"]${alias}[\`"]\\.[\`"]s[\`"]`));
          expect(text).to.match(new RegExp(`[\`"]${alias}[\`"]\\.[\`"]owner[\`"]`));
          expect(((await q) as any[]).map((x) => x.id).sort()).to.deep.equal(memory);
        }
        expect(await sqlIds(Doc, f, alice, (q) => q.where('n', '<', 5))).to.deep.equal(['d01', 'd05']);
      });

      it('placement: a populated relation gets the residual in its JOIN ON, or in the WHERE under its alias', async () => {
        const Doc = await defineDocs();
        const Post = await db.define(
          {
            name: 'Post',
            columns: { doc_id: T.text, s: T.text },
            rows: [
              { id: 'p1', doc_id: 'd01', s: 'b' },
              { id: 'p2', doc_id: 'd02', s: 'a' },
              { id: 'p3', doc_id: null, s: 'a' },
              { id: 'p4', doc_id: 'd04', s: 'a' },
            ],
            decorate: (_cls, proto) => BelongsTo(Doc as never, 'doc_id', 'id')(proto, 'doc'),
          },
          dialect,
        );
        const f = cmp('s', 'eq', 'a');
        const run = async (placement: 'where' | 'join') => {
          const q = (Post as any)
            .query()
            .select('id', 'pid')
            .populate('doc', function (this: IWhereBuilder<unknown>) {
              compileResidual(f, this, { ...contextOf(Doc, alice), placement });
            });
          const { expression, bindings } = q.toDB();
          // The orm's JOIN names the Postgres table with the connection's database as its schema
          // (an orm issue outside authz); run the same statement without that qualifier.
          const runnable = dialect === 'postgres' ? (expression as string).split('"test".').join('') : expression;
          const rows = (await db.raw(runnable, bindings, dialect)) as Record<string, unknown>[];
          return { expression: expression as string, rows: rows.map((r) => [r.pid, r['$doc$.id'] ?? null]).sort() };
        };
        const join = await run('join');
        expect(join.expression).to.match(/ ON .*[`"]\$doc\$[`"]\.[`"]s[`"]/);
        expect(join.expression).to.not.match(/WHERE/);
        expect(join.rows, 'LEFT JOIN keeps every post; only d01 joins').to.deep.equal([
          ['p1', 'd01'],
          ['p2', null],
          ['p3', null],
          ['p4', null],
        ]);
        const where = await run('where');
        expect(where.rows).to.deep.equal([['p1', 'd01']]);
      });

      it('update and delete builders take the residual on the unaliased table', async () => {
        const Doc = await defineDocs();
        const f: ResourceFilter = { op: 'and', args: [under({ type: 'org', id: 'o1' }), not(rel('owner'))] };
        const expected = await new Memory().ids(f, alice, await allRows(Doc));
        expect(expected).to.deep.equal(['d04']);
        const u = (Doc as any).update({ s: 'changed' });
        compileResidual(f, u, contextOf(Doc, alice, 'update'));
        await u;
        expect((await allRows(Doc)).filter((x: any) => x.s === 'changed').map((x: any) => x.id)).to.deep.equal(expected);
        const d = createQuery(Doc, DeleteQueryBuilder).query;
        compileResidual(rel('owner'), d as never, contextOf(Doc, alice, 'delete'));
        await d;
        expect((await allRows(Doc)).map((x: any) => x.id).sort()).to.deep.equal(others(['d01', 'd05']));
      });

      if (dialect === 'sqlite') {
        it('sqlite: values of another storage class, NUL in text, keys that are no ids', async () => {
          const Doc = await defineDocs({
            rows: [
              { id: 'x1', s: Buffer.from('a'), n: 'abc', b: 'true', owner: Buffer.from('alice'), org_id: 7 },
              { id: 'x2', s: 'a\u0000b', n: 2 ** 60, b: '1', owner: 'alice', org_id: Buffer.from('o1') },
              { id: 'x3', s: 'a', n: 1.5, b: 1.0, org_id: 'o1' },
              { id: 'x4', s: 'a\u0000', n: '1', b: 'x' },
            ],
          });
          for (const f of [cmp('s', 'eq', 'a'), cmp('s', 'eq', 'a\u0000b'), cmp('s', 'lt', 'b'), cmp('s', 'in', ['a', 'a\u0000']), cmp('n', 'eq', 'abc'), cmp('n', 'gt', 0), cmp('n', 'in', [1, 1.5]), cmp('b', 'eq', true), cmp('s', 'null'), cmp('n', 'notnull'), rel('owner'), under({ type: 'org' }), under({ type: 'org', id: 'o1' }), under({ type: 'org', id: '7' })]) {
            await verify(Doc, f);
          }
          // GLOB stops at NUL: a row holding one is UNKNOWN for patterns.
          for (const f of [cmp('s', 'like', 'a%'), cmp('s', 'like', 'a_b'), cmp('s', 'glob', 'a*'), cmp('s', 'wildcard', 'a*'), cmp('s', 'like', 'a\u0000%')]) await verify(Doc, f, 'sound');
          expect((await verify(Doc, cmp('b', 'eq', true))).yes).to.deep.equal(['x2', 'x3']);
          expect((await verify(Doc, cmp('s', 'eq', 'a\u0000b'))).yes).to.deep.equal(['x2']);
        });
      }
    });
  }
});
