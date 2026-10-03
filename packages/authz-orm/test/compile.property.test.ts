import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { GLOBAL, NativeFilter } from '@spinajs/authz';
import type { Principal, ResourceFilter, ResourceRef } from '@spinajs/authz';
import { arb } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IWhereBuilder, ModelBase } from '@spinajs/orm';

import { AccessResource, OrmNativeCompiler, OrmScope, OrmScopePolicy, Owner, ScopeColumn } from '../src/index.js';
import { TestDb } from './support/db.js';
import type { Dialect } from './support/db.js';
import { Memory, allRows, not, sqlIds } from './support/residual.js';
import type { Model } from './support/residual.js';

const expect = chai.expect;

const SEED = 20261003;
const RUNS = 300;
const ROWS = 48;

const user = (id: string, attributes: Record<string, unknown> = {}): Principal => ({ type: 'user', id, authenticated: true, source: 'test', attributes });
const PRINCIPALS: readonly Principal[] = [user('alice', { org: 'o1' }), user('bob', { org: 'o2' }), user('ALICE', { org: 'O1' }), { ...user('alice', { org: 'o1' }), type: 'agent' }];

const TYPES: Record<Dialect, { text: string; int: string; real: string; bool: string; date: string }> = {
  sqlite: { text: 'TEXT', int: 'INTEGER', real: 'REAL', bool: 'BOOLEAN', date: 'DATETIME' },
  postgres: { text: 'TEXT', int: 'INTEGER', real: 'DOUBLE PRECISION', bool: 'BOOLEAN', date: 'TIMESTAMP' },
};

const STRINGS = ['a', 'b', 'A', 'B', 'é', 'z', '\u{1F600}', '�', '', 'abc', 'a%c', 'a_c', 'a\\c', 'a/b', 'a/b/c', '10', '1', '1.0', "it's", 'o1', 'O1', 'alice', 'ALICE'];
const NUMBERS = [1, 2, 10, -1, 0, 1.5, 1000, 5, 7];
const NUMERIC_STRINGS = ['1', '01', '1.0', '1e3', '10', '-1', '5', 'x', ''];
const LIKE = ['a%', '%c', 'a_c', 'a\\%c', 'a\\_c', '%', '_', 'A%', '%\u{1F600}', 'a\\', '%/%', 'a\\\\c'];
const WILDCARD = ['a*', '*c', '*', 'a%c', 'a*b*', 'a/*', '*/*'];
// The glob forms SQLite compiles exactly (no '*', or one trailing '*' after a literal prefix).
const GLOB_EXACT = ['a/*', 'a/**', '**/c', '*', 'a*', '**', 'a/b', '**a**'];
const GLOB_ANY = [...GLOB_EXACT, '*/b', 'a/*/c', '**/*', '*b*'];
const SCOPES: readonly unknown[] = [GLOBAL, { type: 'p-doc' }, { type: 'p-doc', id: 'r3' }, { type: 'org' }, { type: 'org', id: 'o1' }, { type: 'org', id: 'O1' }, { type: 'project' }, { type: 'project', id: '5' }, { type: 'project', id: '05' }, { type: 'other' }, { type: 'other', id: 'x' }, { type: 'org', id: 5 }];

const cmp = (field: string, op: string, value?: unknown): ResourceFilter => ({ op: 'cmp', field, cmp: op, value } as ResourceFilter);
const pick = <T>(xs: readonly T[]) => fc.constantFrom(...xs);

/** Filters whose every leaf is an exact rule of conventions §5 for well-typed rows. */
function typedFilter(dialect: Dialect): fc.Arbitrary<ResourceFilter> {
  const six = pick(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']);
  const list = pick(['in', 'nin']);
  const str = pick(['s', 't', 'owner', 'org_id']);
  const numeric = pick(['n', 'r', 'proj_id']);
  const anyValue = fc.oneof(pick(STRINGS), pick(NUMBERS), fc.boolean(), fc.constant(null), fc.constant({ ref: 'principal.id' }));
  const leaf = fc.oneof(
    fc.tuple(str, six, pick(STRINGS)).map(([f, o, v]) => cmp(f, o, v)),
    fc.tuple(str, list, fc.array(pick(STRINGS), { maxLength: 3 })).map(([f, o, v]) => cmp(f, o, v)),
    fc.tuple(str, pick(LIKE)).map(([f, v]) => cmp(f, 'like', v)),
    fc.tuple(str, pick(WILDCARD)).map(([f, v]) => cmp(f, 'wildcard', v)),
    fc.tuple(str, pick(dialect === 'sqlite' ? GLOB_EXACT : GLOB_ANY)).map(([f, v]) => cmp(f, 'glob', v)),
    fc.tuple(str, six, fc.boolean()).map(([f, o, v]) => cmp(f, o, v)),
    fc.tuple(numeric, six, fc.oneof(pick(NUMBERS), pick(NUMERIC_STRINGS), fc.boolean())).map(([f, o, v]) => cmp(f, o, v)),
    fc.tuple(numeric, list, fc.array(fc.oneof(pick(NUMBERS), pick(NUMERIC_STRINGS)), { maxLength: 3 })).map(([f, o, v]) => cmp(f, o, v)),
    fc.tuple(numeric, pick(['like', 'glob', 'wildcard']), pick(LIKE)).map(([f, o, v]) => cmp(f, o, v)),
    fc.tuple(six, fc.oneof(fc.boolean(), pick([0, 1, 2]), pick(['x', 'true']))).map(([o, v]) => cmp('b', o, v)),
    fc.tuple(list, fc.array(fc.oneof(pick([0, 1, 2]), pick(['x', '1'])), { maxLength: 3 })).map(([o, v]) => cmp('b', o, v)),
    fc.tuple(pick(['o', 'nope']), pick(['eq', 'ne', 'lt', 'gte', 'in', 'nin', 'like', 'glob', 'wildcard']), anyValue).map(([f, o, v]) => cmp(f, o, o === 'in' || o === 'nin' ? (typeof v === 'string' ? [v] : v) : v)),
    fc.tuple(pick(['s', 'n', 'r', 'b', 'o', 'owner', 'org_id', 'proj_id', 'nope']), pick(['null', 'notnull'])).map(([f, o]) => cmp(f, o)),
    fc.tuple(pick(['s', 'n', 'b']), pick(['eq', 'in', 'like']), pick([{ ref: 'principal.id' }, null, [true], {}])).map(([f, o, v]) => cmp(f, o, v)),
    pick(['owner', 'member']).map((relation): ResourceFilter => ({ op: 'relation', relation })),
    fc.array(pick(SCOPES), { maxLength: 3 }).map((scopes) => ({ op: 'under', scopes } as ResourceFilter)),
    fc.constant<ResourceFilter>({ op: 'native:test.pflag', args: { k: 1 } }),
    pick<ResourceFilter>([{ op: 'true' }, { op: 'false' }]),
  );
  const tree = fc.letrec<{ node: ResourceFilter }>((self) => ({
    node: fc.oneof({ depthSize: 'small', withCrossShrink: true }, { weight: 4, arbitrary: leaf }, { weight: 1, arbitrary: fc.array(self('node'), { maxLength: 3 }).map((args): ResourceFilter => ({ op: 'and', args })) }, { weight: 1, arbitrary: fc.array(self('node'), { maxLength: 3 }).map((args): ResourceFilter => ({ op: 'or', args })) }, { weight: 1, arbitrary: self('node').map((arg): ResourceFilter => ({ op: 'not', arg })) }),
  }));
  return tree.node;
}

/** The authz kit's filters over every column and value kind, malformed values included. */
function anyFilter(): fc.Arbitrary<ResourceFilter> {
  return arb.filter({
    fields: ['s', 't', 'n', 'r', 'b', 'o', 'owner', 'org_id', 'proj_id', 'nope'],
    values: ['a', 'B', 'é', '1', '01', '1.0', 'x', '%', 'a*', 'a/b', 'o1', 1, 2, 0, 1.5, 5, -1],
    relations: ['owner', 'member'],
    scopes: SCOPES as ResourceRef[],
    nativeOps: ['native:test.pflag'],
    invalid: true,
    depth: 3,
  });
}

function typedRows(dialect: Dialect): Record<string, unknown>[] {
  const nullable = <T>(a: fc.Arbitrary<T>) => fc.oneof({ weight: 4, arbitrary: a }, { weight: 1, arbitrary: fc.constant(null) });
  const row = fc.record({
    s: nullable(pick(STRINGS)),
    t: nullable(pick(STRINGS)),
    n: nullable(pick([1, 2, 10, -1, 0, 1000, 5])),
    r: nullable(pick([1.5, 0.1, -0.5, 0, 1, 1000])),
    b: dialect === 'sqlite' ? nullable(pick([0, 1, 2])) : nullable(fc.boolean()),
    o: nullable(pick(['2020-01-01 00:00:00', '2021-06-01 12:00:00'])),
    owner: nullable(pick(['alice', 'bob', 'ALICE', 'Alice'])),
    org_id: nullable(pick(['o1', 'o2', 'O1'])),
    proj_id: nullable(pick([5, 7, 50])),
  });
  return fc.sample(row, { seed: SEED, numRuns: ROWS }).map((r, i) => ({ id: `r${i}`, ...r }));
}

// SQLite keeps a value of any storage class in any column: the evaluator reads such cells as opaque.
const SQLITE_MIXED: Record<string, unknown>[] = [
  { id: 'm1', s: Buffer.from('a'), n: 'abc', b: 'true', owner: Buffer.from('alice'), org_id: 7, proj_id: 'x' },
  { id: 'm2', s: 'a\u0000b', n: 2 ** 60, b: '1', owner: 'alice', org_id: Buffer.from('o1'), proj_id: 5.5 },
  { id: 'm3', s: 'a\u0000', t: 1.5, n: '1', b: 'x', r: 'nan', proj_id: 2 ** 53 },
  { id: 'm4', s: 'a/b\u0000', t: 'a', n: 1.5, b: 1.0, r: 1e308 * 10 },
];

describe('authz-orm residual compiler: SQL selection against evaluateResidual (property)', function () {
  this.timeout(600000);
  let db: TestDb;
  let pg = false;

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  for (const dialect of ['sqlite', 'postgres'] as const) {
    describe(dialect, () => {
      const T = TYPES[dialect];
      let Doc: Model;
      let rows: ModelBase[];
      let memory: Memory;
      let Member: abstract new () => unknown;
      let Flag: abstract new () => unknown;

      before(async function () {
        if (dialect === 'postgres' && !pg) return this.skip();
        Member = class PropertyMemberPolicy extends OrmScopePolicy {
          scope(q: IWhereBuilder<ModelBase>, p: Principal): void {
            q.where('org_id', String(p.attributes.org ?? '')).orWhere('s', 'a');
          }
        };
        Object.defineProperty(Member, 'name', { value: `PropertyMemberPolicy_${dialect}` });
        // Two-valued like its in-memory twin below: a NULL s is FALSE, never UNKNOWN.
        Flag = class PropertyFlagCompiler extends OrmNativeCompiler {
          readonly op = 'native:test.pflag' as const;
          compile(_args: unknown, builder: IWhereBuilder<unknown>): void {
            builder
              .where(function (this: IWhereBuilder<unknown>) {
                this.where('s', 'a').orWhere('s', 'b');
              })
              .whereNotNull('s');
          }
        };
        DI.register(Flag as never).as(OrmNativeCompiler);
        class FlagFilter extends NativeFilter {
          readonly op = 'native:test.pflag' as const;
          matches(_args: unknown, subject: unknown): boolean {
            const s = (subject as { s?: unknown }).s;
            return s === 'a' || s === 'b';
          }
        }
        const rowsIn = typedRows(dialect).concat(dialect === 'sqlite' ? SQLITE_MIXED : []);
        Doc = await db.define(
          {
            name: 'PDoc',
            columns: { s: T.text, t: T.text, n: T.int, r: T.real, b: T.bool, o: T.date, owner: T.text, org_id: T.text, proj_id: T.int },
            rows: rowsIn,
            decorate: (cls, proto) => {
              AccessResource('p-doc')(cls);
              Owner()(proto, 'owner');
              ScopeColumn('org_id', 'org')(proto, 'org_id');
              ScopeColumn('proj_id', 'project')(proto, 'proj_id');
              OrmScope(cls as never, 'member')(Member as never);
            },
          },
          dialect,
        );
        rows = await allRows(Doc);
        memory = new Memory(new Map([['native:test.pflag', new FlagFilter()]]), { cacheRelations: true });
      });

      after(async () => {
        if (!Doc) return;
        await db.clear();
        DI.unregister(Flag as never);
        DI.uncache(Flag as never);
        DI.uncache(OrmNativeCompiler);
        DI.uncache(Member as never);
      });

      const typed = (r: ModelBase) => !String((r as unknown as { id: string }).id).startsWith('m');

      it(`typed rows: SQL selects exactly the rows evaluateResidual holds for, f and not f (seed ${SEED}, ${RUNS} runs)`, async () => {
        const sample = rows.filter(typed);
        expect(sample).to.have.length(ROWS);
        let selected = 0;
        await fc.assert(
          fc.asyncProperty(typedFilter(dialect), pick(PRINCIPALS), async (f, principal) => {
            for (const g of [f, not(f)]) {
              const sql = (await sqlIds(Doc, g, principal)).filter((id) => !id.startsWith('m'));
              const mem = await memory.ids(g, principal, sample);
              expect(sql, JSON.stringify(g)).to.deep.equal(mem);
              selected += sql.length;
            }
          }),
          { seed: SEED, numRuns: RUNS },
        );
        expect(selected, 'the runs select rows').to.be.greaterThan(RUNS);
      });

      it(`every row and filter: SQL never selects a row evaluateResidual does not hold for (seed ${SEED + 1}, ${RUNS} runs)`, async () => {
        await fc.assert(
          fc.asyncProperty(anyFilter(), pick(PRINCIPALS), async (f, principal) => {
            for (const g of [f, not(f)]) {
              const sql = await sqlIds(Doc, g, principal);
              const mem = await memory.ids(g, principal, rows);
              expect(mem, JSON.stringify(g)).to.include.members(sql);
            }
          }),
          { seed: SEED + 1, numRuns: RUNS },
        );
      });
    });
  }
});
