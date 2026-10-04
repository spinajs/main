import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { AuthorizationModel, AuthzConfigError, CORE_FILTER_OPS, DecisionAudit, NativeFilter, runWithPrincipal } from '@spinajs/authz';
import type { ModelInitContext, Principal, ResourceFilter } from '@spinajs/authz';
import { RecordingAudit, StaticModel, testHost } from '@spinajs/authz-testing';
import type { VoteTable } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BelongsTo, LazyQueryStatement, ModelBase } from '@spinajs/orm';
import type { IQueryStatementResult, IWhereBuilder } from '@spinajs/orm';

import { AccessResource, OrmNativeCompiler, ScopeColumn } from '../src/index.js';
import { compileResidual } from '../src/compile/compiler.js';
import '../src/middleware.js';
import { correlate, correlatedQuery, identifier, outerColumn, scopeColumnsOf, sql, subColumn, whereSql } from '../src/native.js';
import { TestDb } from './support/db.js';
import type { Dialect } from './support/db.js';
import { Memory, allRows, contextOf, not, sqlIds } from './support/residual.js';
import type { Model } from './support/residual.js';
import { asSystem, systemIt } from './support/system.js';

const expect = chai.expect;

const SEED = 20261008;
const RUNS = 200;
const OP = 'native:test.member' as const;

const user = (id: string): Principal => ({ type: 'user', id, authenticated: true, source: 'test', attributes: {} });
const PRINCIPALS = ['alice', 'bob', 'carol', 'dave', 'ALICE'].map(user);
const [alice, bob] = PRINCIPALS;

const cmp = (field: string, op: string, value?: unknown): ResourceFilter => ({ op: 'cmp', field, cmp: op, value } as ResourceFilter);
const and = (...args: ResourceFilter[]): ResourceFilter => ({ op: 'and', args });
const or = (...args: ResourceFilter[]): ResourceFilter => ({ op: 'or', args });
const member = (args: MemberArgs = {}): ResourceFilter => ({ op: OP, args } as ResourceFilter);
const pick = <T>(xs: readonly T[]) => fc.constantFrom(...xs);

interface MemberArgs {
  readonly role?: string;
  /** The sub-query's own `orWhere('role', 'public')`: it must stay inside the correlation. */
  readonly loose?: boolean;
  readonly via?: 'table' | 'model';
  readonly negate?: boolean;
  /** The EXISTS inside a `where(fn)` group of the native builder. */
  readonly nested?: boolean;
  /** No rule on the row itself: a `NOT EXISTS` over the rule table nested in the membership sub-query, at its top level or in a group. */
  readonly restricted?: 'top' | 'group';
  /** onPath: an OR of two correlations (org path column, the row's own id) in where groups of one EXISTS. */
  readonly path?: boolean;
  /** The scope the membership must name, as a CASE over the row's columns: its org, or the row itself when it has none. */
  readonly case?: boolean;
  /** Not an EXISTS: `COALESCE((SELECT MIN(role) … scope = <row org>), dflt) = want` written straight into the native builder. */
  readonly attr?: { readonly want: string; readonly dflt: string };
}

type Membership = { id: string; principal_id: string | null; scope_id: string | null; scope_type: string | null; role: string | null };
const MEMBERS: readonly Membership[] = [
  { id: 'm1', principal_id: 'alice', scope_id: 'o1', scope_type: 'org', role: 'editor' },
  { id: 'm2', principal_id: 'alice', scope_id: 'o2', scope_type: 'org', role: 'viewer' },
  { id: 'm3', principal_id: 'bob', scope_id: 'o2', scope_type: 'org', role: 'editor' },
  { id: 'm4', principal_id: 'carol', scope_id: 'o3', scope_type: 'org', role: 'public' },
  { id: 'm5', principal_id: null, scope_id: 'o1', scope_type: 'org', role: 'viewer' },
  { id: 'm6', principal_id: 'bob', scope_id: null, scope_type: 'org', role: 'editor' },
  { id: 'm7', principal_id: 'ALICE', scope_id: 'O1', scope_type: null, role: null },
  { id: 'm8', principal_id: 'alice', scope_id: 'd3', scope_type: 'ndoc', role: 'viewer' },
  { id: 'm9', principal_id: 'bob', scope_id: 'd1', scope_type: 'ndoc', role: 'editor' },
  // Typed as a doc but naming an org: the org path of onPath must not take it.
  { id: 'm10', principal_id: 'carol', scope_id: 'o1', scope_type: 'ndoc', role: 'editor' },
  { id: 'm11', principal_id: 'dave', scope_id: 'd5', scope_type: 'ndoc', role: 'viewer' },
];
// r2 names a membership id: a restriction correlated with the membership row instead of the doc would hit it.
const RULES = [
  { id: 'r1', scope_id: 'd1' },
  { id: 'r2', scope_id: 'm3' },
];
const DOCS = [
  { id: 'd1', s: 'a', org_id: 'o1' },
  { id: 'd2', s: 'b', org_id: 'o2' },
  { id: 'd3', s: 'a', org_id: 'o3' },
  { id: 'd4', s: 'c', org_id: 'O1' },
  { id: 'd5', s: 'a', org_id: null },
  { id: 'd6', s: null, org_id: 'o2' },
  { id: 'd7', s: 'b', org_id: '' },
];
const ALL = DOCS.map((d) => d.id);

/** The fake op in memory: the principal holds a membership (of the role, when given) on the row's org. */
class MemberFilter extends NativeFilter {
  readonly op = OP;
  constructor(private readonly principal: string) {
    super();
  }

  matches(args: unknown, subject: unknown): boolean {
    const a = (args ?? {}) as MemberArgs;
    const { id, org_id: org } = subject as { id: string; org_id?: unknown };
    let found: boolean;
    if (a.attr !== undefined) {
      const roles = MEMBERS.filter((m) => m.principal_id === this.principal && m.scope_type === 'org' && typeof org === 'string' && m.scope_id === org && m.role !== null).map((m) => m.role as string);
      found = (roles.length > 0 ? roles.sort()[0] : a.attr.dflt) === a.attr.want;
    } else {
      const scoped = (m: Membership): boolean => {
        if (a.case) return m.scope_id === (org == null ? id : org);
        const viaOrg = typeof org === 'string' && m.scope_id === org && (!a.path || m.scope_type === 'org');
        return viaOrg || (a.path === true && m.scope_type === 'ndoc' && m.scope_id === id);
      };
      found = MEMBERS.some((m) => scoped(m) && ((m.principal_id === this.principal && (a.role === undefined || m.role === a.role)) || (a.loose === true && m.role === 'public')));
      if (a.restricted !== undefined) found = found && !RULES.some((r) => r.scope_id === id);
    }
    return a.negate === true ? !found : found;
  }
}

// The current fixture (the compiler is registered in DI once and reads it).
const fixture: { table?: string; rules?: string; Membership?: Model } = {};

class MemberCompiler extends OrmNativeCompiler {
  readonly op = OP;
  compile(args: unknown, builder: IWhereBuilder<unknown>, model: never, principal: Principal): void {
    const a = (args ?? {}) as MemberArgs;
    const org = scopeColumnsOf(model).find((c) => c.scopeType === 'org');
    if (org === undefined) throw new AuthzConfigError('no org scope column');
    const exists = (into: IWhereBuilder<unknown>) => {
      if (a.attr !== undefined) {
        const { want, dflt } = a.attr;
        const x = identifier('attr_x');
        const roles = sql`SELECT MIN(${x}.${identifier('role')}) FROM ${identifier(fixture.table!)} ${x} WHERE ${x}.${identifier('principal_id')} = ${principal.id} AND ${x}.${identifier('scope_type')} = ${'org'} AND ${x}.${identifier('scope_id')} = ${outerColumn(into, org.column)}`;
        const test = sql`COALESCE((${roles}), ${dflt}) = ${want}`;
        whereSql(into, a.negate ? sql`NOT (${test})` : test);
        return;
      }
      const m = correlatedQuery(into, a.via === 'model' ? (fixture.Membership as never) : fixture.table!);
      m.where('principal_id', principal.id);
      if (a.role !== undefined) m.where('role', a.role);
      if (a.loose) m.orWhere('role', 'public');
      if (a.case) whereSql(m, sql`${subColumn(m, 'scope_id')} = CASE WHEN ${outerColumn(m, org.column)} IS NULL THEN ${outerColumn(m, 'id')} ELSE ${outerColumn(m, org.column)} END`);
      else if (a.path)
        m.where(function (this: IWhereBuilder<unknown>) {
          this.where(function (this: IWhereBuilder<unknown>) {
            this.where('scope_type', 'org');
            correlate(this, 'scope_id', org.column);
          }).orWhere(function (this: IWhereBuilder<unknown>) {
            this.where('scope_type', 'ndoc');
            correlate(this, 'scope_id', 'id');
          });
        });
      else correlate(m, 'scope_id', org.column);
      if (a.restricted === 'top') {
        const r = correlatedQuery(into, fixture.rules!);
        correlate(r, 'scope_id', 'id');
        m.whereNotExists(r);
      } else if (a.restricted === 'group')
        m.where(function (this: IWhereBuilder<unknown>) {
          const r = correlatedQuery(this, fixture.rules!);
          correlate(r, 'scope_id', 'id');
          this.whereNotExists(r);
        });
      if (a.negate) into.whereNotExists(m);
      else into.whereExist(m);
    };
    if (a.nested)
      builder.where(function (this: IWhereBuilder<unknown>) {
        exists(this);
      });
    else exists(builder);
  }
}

describe('authz-orm native compilers: correlated sub-queries', function () {
  this.timeout(600000);
  let db: TestDb;
  let pg = false;

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
    await (await testHost.domains()).service('root');
    DI.register(MemberCompiler).as(OrmNativeCompiler);
  });

  after(async () => {
    DI.unregister(MemberCompiler);
    DI.uncache(MemberCompiler);
    DI.uncache(OrmNativeCompiler);
    await db?.close();
  });

  const memories = new Map(PRINCIPALS.map((p) => [p.id, new Memory(new Map([[OP, new MemberFilter(p.id)]]))]));
  const memoryOf = (p: Principal) => memories.get(p.id)!;

  async function define(dialect: Dialect, docs: { relationScope?: 'where' | 'join'; name?: string } = {}) {
    const Membership = await db.define({ name: 'Membership', columns: { principal_id: 'TEXT', scope_id: 'TEXT', scope_type: 'TEXT', role: 'TEXT' }, rows: MEMBERS }, dialect);
    fixture.Membership = Membership;
    fixture.table = db.table(Membership);
    fixture.rules = db.table(await db.define({ name: 'Rule', columns: { scope_id: 'TEXT' }, rows: RULES }, dialect));
    const Doc = await db.define(
      {
        name: docs.name ?? 'NDoc',
        columns: { s: 'TEXT', org_id: 'TEXT' },
        rows: DOCS,
        decorate: (cls, proto) => {
          AccessResource('ndoc', { relationScope: docs.relationScope ?? 'where' })(cls);
          ScopeColumn('org_id', 'org')(proto, 'org_id');
        },
      },
      dialect,
    );
    return { Membership, Doc };
  }

  for (const dialect of ['sqlite', 'postgres'] as const) {
    describe(dialect, () => {
      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      describe('compiler', () => {
        let Doc: Model;
        let rows: ModelBase[];

        before(async function () {
          if (dialect === 'postgres' && !pg) return this.skip();
          ({ Doc } = await define(dialect));
          rows = await allRows(Doc);
        });

        after(async () => {
          await db.clear();
        });

        /** The rows of a twice-cloned, re-aliased copy of the compiled query, and the count of a clone. */
        const cloned = (f: ResourceFilter, principal: Principal) =>
          asSystem(async () => {
            const q = (Doc as any).query();
            compileResidual(f, q, contextOf(Doc, principal));
            const copy = (await q.clone().clone().setAlias('copy')) as ModelBase[];
            return { ids: copy.map((r) => (r as unknown as { id: string }).id).sort(), count: Number(await q.clone().selectCount()) };
          });

        const verify = async (f: ResourceFilter, principal: Principal, shape?: (q: IWhereBuilder<unknown>) => void) => {
          const out: string[][] = [];
          for (const g of [f, not(f)]) {
            const what = `${dialect} ${principal.id} ${JSON.stringify(g)}`;
            const memory = await memoryOf(principal).ids(g, principal, rows);
            const sql = await sqlIds(Doc, g, principal, shape);
            expect(sql, what).to.deep.equal(memory);
            const copy = await cloned(g, principal);
            expect(copy.ids, `clone: ${what}`).to.deep.equal(memory);
            expect(copy.count, `count of a clone: ${what}`).to.equal(memory.length);
            out.push(sql);
          }
          return { yes: out[0], no: out[1] };
        };

        systemIt('an EXISTS over another table, correlated with the row, equals the evaluator alone, under not and inside or', async () => {
          expect((await verify(member(), alice)).yes).to.deep.equal(['d1', 'd2', 'd6']);
          expect((await verify(member(), bob)).yes).to.deep.equal(['d2', 'd6']);
          expect((await verify(member({ role: 'editor' }), alice)).yes).to.deep.equal(['d1']);
          expect((await verify(member(), user('ALICE'))).yes).to.deep.equal(['d4']);
          expect((await verify(member(), user('dave'))).yes).to.deep.equal([]);
          expect((await verify(or(cmp('s', 'eq', 'a'), member()), bob)).yes).to.deep.equal(['d1', 'd2', 'd3', 'd5', 'd6']);
          expect((await verify(and(not(member()), cmp('s', 'eq', 'a')), alice)).yes).to.deep.equal(['d3', 'd5']);
          // d6 has no s: NOT (s = 'b') is UNKNOWN there.
          expect((await verify(or(not(member({ role: 'viewer' })), cmp('s', 'eq', 'b')), alice)).no).to.deep.equal([]);
          expect((await verify(member({ negate: true }), alice)).yes).to.deep.equal(['d3', 'd4', 'd5', 'd7']);
          expect((await verify(member({ via: 'model' }), alice)).yes).to.deep.equal(['d1', 'd2', 'd6']);
        });

        systemIt('a correlatedQuery nested in another correlates with the filtered row, also in clones and their counts', async () => {
          for (const restricted of ['top', 'group'] as const) {
            expect((await verify(member({ restricted }), alice)).yes).to.deep.equal(['d2', 'd6']);
            expect((await verify(member({ restricted }), bob)).yes).to.deep.equal(['d2', 'd6']);
            expect((await verify(member({ restricted, nested: true }), alice)).no).to.deep.equal(['d1', 'd3', 'd4', 'd5', 'd7']);
            expect((await verify(or(member({ restricted }), cmp('s', 'eq', 'a')), bob)).yes).to.deep.equal(['d1', 'd2', 'd3', 'd5', 'd6']);
          }
          const q = (Doc as any).query();
          compileResidual(member({ restricted: 'top' }), q, contextOf(Doc, alice));
          const { expression } = q.clone().clone().toDB() as { expression: string };
          expect(expression).to.not.match(/\$authz_n\d+\$['"`]?\s*\.\s*['"`]?id['"`]?\s*\)/);
        });

        systemIt('onPath: an OR of two correlations in where groups of one EXISTS', async () => {
          expect((await verify(member({ path: true }), alice)).yes).to.deep.equal(['d1', 'd2', 'd3', 'd6']);
          expect((await verify(member({ path: true }), bob)).yes).to.deep.equal(['d1', 'd2', 'd6']);
          expect((await verify(member({ path: true }), user('carol'))).yes).to.deep.equal(['d3']);
          expect((await verify(member({ path: true, role: 'editor' }), bob)).yes).to.deep.equal(['d1', 'd2', 'd6']);
          expect((await verify(member({ path: true, restricted: 'group' }), bob)).yes).to.deep.equal(['d2', 'd6']);
          expect((await verify(member({ path: true, nested: true }), user('dave'))).yes).to.deep.equal(['d5']);
          const q = (Doc as any).query();
          compileResidual(member({ path: true }), q, contextOf(Doc, alice));
          const { expression } = q.toDB() as { expression: string };
          expect(expression.match(/EXISTS/g)).to.have.length(1);
        });

        systemIt('the outer column in a CASE inside an EXISTS and in a COALESCE over a scalar sub-select', async () => {
          // d5 has no org: the CASE falls back to the row's own id, where dave holds m11.
          expect((await verify(member({ case: true }), user('dave'))).yes).to.deep.equal(['d5']);
          expect((await verify(member({ case: true }), alice)).yes).to.deep.equal(['d1', 'd2', 'd6']);
          expect((await verify(member({ case: true, restricted: 'top' }), bob)).yes).to.deep.equal(['d2', 'd6']);
          expect((await verify(member({ attr: { want: 'editor', dflt: 'none' } }), alice)).yes).to.deep.equal(['d1']);
          expect((await verify(member({ attr: { want: 'none', dflt: 'none' } }), alice)).yes).to.deep.equal(['d3', 'd4', 'd5', 'd7']);
          expect((await verify(member({ attr: { want: 'none', dflt: 'none' }, nested: true }), bob)).yes).to.deep.equal(['d1', 'd3', 'd4', 'd5', 'd7']);
        });

        systemIt('a sub-query whose correlations all sit in where groups refuses a top-level OR, which would reach around them', async () => {
          const q = (Doc as any).query();
          compileResidual(member({ path: true, loose: true }), q, contextOf(Doc, alice));
          expect(() => q.toDB()).to.throw(AuthzConfigError, /orWhere/);
        });

        /** Runs `fn` with a compiler for `op` that builds `shape` into the native builder. */
        const withShape = async (op: `native:${string}`, shape: (builder: IWhereBuilder<unknown>, principal: Principal, args: any) => void, fn: () => Promise<void>) => {
          // DI keys its instances by class name: one name per op.
          const name = `ShapeCompiler_${op.replace(/\W/g, '_')}`;
          const Shape = {
            [name]: class extends OrmNativeCompiler {
              readonly op = op;
              compile(args: unknown, builder: IWhereBuilder<unknown>, _model: never, principal: Principal): void {
                shape(builder, principal, args);
              }
            },
          }[name];
          DI.register(Shape).as(OrmNativeCompiler);
          try {
            await fn();
          } finally {
            DI.unregister(Shape);
            // The instance is cached by class name, and the next dialect's shape closes over its own tables.
            DI.uncache(Shape);
            DI.uncache(OrmNativeCompiler);
          }
        };

        const fails = (p: Promise<unknown>) =>
          p.then(
            () => undefined,
            (e: unknown) => e,
          );

        systemIt('an orWhere next to a where group that holds a correlation is refused at any depth, as it reaches around it', async () => {
          type Shape = 'group' | 'deep' | 'besideOwn' | 'existsOr' | 'orOfGroups' | 'existsOrExists' | 'plainOr';
          /** A correlatedQuery over the rules, correlated with the row's id, in `g`. */
          const ruleExists = (g: IWhereBuilder<unknown>) => {
            const r = correlatedQuery(g, fixture.rules!);
            correlate(r, 'scope_id', 'id');
            return r;
          };
          const SHAPE = 'native:test.shape' as const;
          const viewerOr = (g: IWhereBuilder<unknown>, column: string, outer: string) =>
            g
              .where(function (this: IWhereBuilder<unknown>) {
                correlate(this, column, outer);
              })
              .orWhere('role', 'viewer');
          await withShape(
            SHAPE,
            (builder, principal, shape: Shape) => {
              const m = correlatedQuery(builder, fixture.table!);
              m.where('principal_id', principal.id);
              if (shape === 'group')
                m.where(function (this: IWhereBuilder<unknown>) {
                  viewerOr(this, 'scope_id', 'org_id');
                });
              else if (shape === 'deep')
                m.where(function (this: IWhereBuilder<unknown>) {
                  this.where(function (this: IWhereBuilder<unknown>) {
                    viewerOr(this, 'scope_id', 'org_id');
                  });
                });
              else if (shape === 'besideOwn') {
                correlate(m, 'scope_id', 'org_id');
                m.where(function (this: IWhereBuilder<unknown>) {
                  viewerOr(this, 'scope_id', 'id');
                });
              } else if (shape === 'existsOr')
                // The correlation sits in a nested sub-query: OR-ed with a plain condition it is reached around too.
                m.where(function (this: IWhereBuilder<unknown>) {
                  this.whereExist(ruleExists(this)).orWhere('role', 'viewer');
                });
              else if (shape === 'existsOrExists')
                m.where(function (this: IWhereBuilder<unknown>) {
                  this.whereExist(ruleExists(this)).orWhere(function (this: IWhereBuilder<unknown>) {
                    this.whereNotExists(ruleExists(this));
                    this.where('role', 'nobody');
                  });
                });
              else if (shape === 'orOfGroups')
                // onPath without its own group: both operands hold a correlation.
                m.where(function (this: IWhereBuilder<unknown>) {
                  this.where(function (this: IWhereBuilder<unknown>) {
                    correlate(this, 'scope_id', 'org_id');
                  }).orWhere(function (this: IWhereBuilder<unknown>) {
                    this.where('scope_type', 'ndoc');
                    correlate(this, 'scope_id', 'id');
                  });
                });
              else {
                // An OR with no correlation on either side, ANDed with one: it cannot reach around it.
                correlate(m, 'scope_id', 'org_id');
                m.where(function (this: IWhereBuilder<unknown>) {
                  this.where('role', 'editor').orWhere('role', 'viewer');
                });
              }
              builder.whereExist(m);
            },
            async () => {
              for (const shape of ['group', 'deep', 'besideOwn', 'existsOr'] as const) {
                for (const f of [{ op: SHAPE, args: shape } as ResourceFilter, not({ op: SHAPE, args: shape } as ResourceFilter)]) {
                  const e = await fails(sqlIds(Doc, f, alice));
                  expect(e, `${dialect} ${shape} ${f.op}`).to.be.instanceOf(AuthzConfigError);
                  expect((e as Error).message).to.match(/orWhere/);
                }
              }
              const f = (args: Shape): ResourceFilter => ({ op: SHAPE, args } as ResourceFilter);
              expect(await sqlIds(Doc, f('orOfGroups'), alice)).to.deep.equal(['d1', 'd2', 'd3', 'd6']);
              // A rule names d1 only; no membership has role 'nobody'.
              expect(await sqlIds(Doc, f('existsOrExists'), alice)).to.deep.equal(['d1']);
              expect(await sqlIds(Doc, not(f('existsOrExists')), alice)).to.deep.equal(['d2', 'd3', 'd4', 'd5', 'd6', 'd7']);
              expect(await sqlIds(Doc, f('plainOr'), alice)).to.deep.equal(['d1', 'd2', 'd6']);
              expect(await sqlIds(Doc, not(f('plainOr')), alice)).to.deep.equal(['d3', 'd4', 'd5', 'd7']);
            },
          );
        });

        systemIt('an sql fragment cannot close the brackets it is wrapped in', async () => {
          const ESCAPE = 'native:test.escape' as const;
          await withShape(
            ESCAPE,
            (builder, principal, args: 'brackets' | 'named@' | 'named:') => {
              if (args === 'brackets') whereSql(builder, sql`1 = 0)) OR ((1 = 1`);
              else {
                // SQLite reads @x and :x as parameters that take the next binding: the restriction below would lose its principal.
                const m = correlatedQuery(builder, fixture.table!);
                correlate(m, 'scope_id', 'org_id');
                whereSql(m, args === 'named@' ? sql`@x IS NULL` : sql`:x IS NULL`);
                m.where('principal_id', principal.id);
                builder.whereNotExists(m);
              }
            },
            async () => {
              for (const [args, message] of [
                ['brackets', /bracket/],
                ['named@', /parameter/],
                ['named:', /parameter/],
              ] as const) {
                const op = { op: ESCAPE, args } as ResourceFilter;
                for (const f of [op, not(op), and(cmp('s', 'eq', 'zzz'), op)]) {
                  const e = await fails(sqlIds(Doc, f, alice));
                  expect(e, `${dialect} ${JSON.stringify(f)}`).to.be.instanceOf(AuthzConfigError);
                  expect((e as Error).message).to.match(message);
                }
              }
            },
          );
        });

        systemIt('an array in an sql fragment binds one value per element, so IN (…) and NOT EXISTS read the list', async () => {
          const IN = 'native:test.in' as const;
          await withShape(
            IN,
            (builder, _principal, args: { ids: string[]; negate?: boolean }) => {
              const m = correlatedQuery(builder, fixture.table!);
              correlate(m, 'scope_id', 'org_id');
              whereSql(m, sql`${subColumn(m, 'principal_id')} IN (${args.ids})`);
              if (args.negate) builder.whereNotExists(m);
              else builder.whereExist(m);
            },
            async () => {
              const f = (ids: string[], negate = false): ResourceFilter => ({ op: IN, args: { ids, negate } } as ResourceFilter);
              expect(await sqlIds(Doc, f(['alice', 'bob']), alice)).to.deep.equal(['d1', 'd2', 'd6']);
              expect(await sqlIds(Doc, f(['alice', 'bob'], true), alice)).to.deep.equal(['d3', 'd4', 'd5', 'd7']);
              expect(await sqlIds(Doc, f(['carol']), alice)).to.deep.equal(['d1', 'd3']);
              expect(await sqlIds(Doc, f(['carol'], true), alice)).to.deep.equal(['d2', 'd4', 'd5', 'd6', 'd7']);
              const e = await fails(sqlIds(Doc, f([]), alice));
              expect(e).to.be.instanceOf(AuthzConfigError);
              expect((e as Error).message).to.match(/empty array/);
            },
          );
        });

        systemIt('a Date binds as the orm stores datetimes and a bigint as an integer, so an expiry check and its NOT EXISTS hold', async () => {
          // The orm writes datetimes as `yyyy-MM-dd HH:mm:ss.SSS` (SQLite TEXT, which sorts above any number).
          const Grant = await db.define(
            {
              name: 'Grant',
              columns: { principal_id: 'TEXT', scope_id: 'TEXT', expires_at: dialect === 'sqlite' ? 'DATETIME' : 'TIMESTAMP', n: dialect === 'sqlite' ? 'INTEGER' : 'BIGINT' },
              rows: [
                { id: 'g1', principal_id: 'alice', scope_id: 'o1', expires_at: '2020-01-01 00:00:00.000', n: 1 },
                { id: 'g2', principal_id: 'alice', scope_id: 'o2', expires_at: '2099-01-01 00:00:00.000', n: '9007199254740993' },
              ],
            },
            dialect,
          );
          const grants = db.table(Grant);
          const EXPIRY = 'native:test.expiry' as const;
          type Args = { test: 'live' | 'expired' | 'small' | 'big'; negate?: boolean };
          await withShape(
            EXPIRY,
            (builder, principal, args: Args) => {
              const m = correlatedQuery(builder, grants);
              correlate(m, 'scope_id', 'org_id');
              m.where('principal_id', principal.id);
              const now = new Date();
              const at = subColumn(m, 'expires_at');
              if (args.test === 'live') whereSql(m, sql`${at} > ${now}`);
              else if (args.test === 'expired') whereSql(m, sql`${at} < ${now}`);
              else if (args.test === 'small') whereSql(m, sql`1 IN (${[1n, 2n]})`);
              else whereSql(m, sql`${subColumn(m, 'n')} = ${9007199254740993n}`);
              if (args.negate) builder.whereNotExists(m);
              else builder.whereExist(m);
            },
            async () => {
              const f = (test: Args['test'], negate = false): ResourceFilter => ({ op: EXPIRY, args: { test, negate } } as ResourceFilter);
              // g1 (o1) expired in 2020, g2 (o2) lives until 2099.
              expect(await sqlIds(Doc, f('live'), alice)).to.deep.equal(['d2', 'd6']);
              expect(await sqlIds(Doc, f('live', true), alice)).to.deep.equal(['d1', 'd3', 'd4', 'd5', 'd7']);
              // The restriction form: an expired grant hides its org's rows.
              expect(await sqlIds(Doc, f('expired', true), alice)).to.deep.equal(['d2', 'd3', 'd4', 'd5', 'd6', 'd7']);
              expect(await sqlIds(Doc, f('expired'), alice)).to.deep.equal(['d1']);
              expect(await sqlIds(Doc, f('small'), alice)).to.deep.equal(['d1', 'd2', 'd6']);
              expect(await sqlIds(Doc, f('small', true), alice)).to.deep.equal(['d3', 'd4', 'd5', 'd7']);
              expect(await sqlIds(Doc, f('big'), alice)).to.deep.equal(['d2', 'd6']);
              expect(await sqlIds(Doc, f('big', true), alice)).to.deep.equal(['d1', 'd3', 'd4', 'd5', 'd7']);
            },
          );
        });

        systemIt("the sub-query's own orWhere stays inside its correlation", async () => {
          // `scope = org AND (principal = ? OR role = 'public')`, never `… OR role = 'public'` on any org.
          expect((await verify(member({ loose: true }), bob)).yes).to.deep.equal(['d2', 'd3', 'd6']);
          expect((await verify(member({ loose: true, role: 'viewer' }), bob)).yes).to.deep.equal(['d3']);
        });

        systemIt('the outer alias is read when the query compiles: an alias set later, nested groups, a clone', async () => {
          const late = (q: IWhereBuilder<unknown>) => void (q as unknown as { setAlias(a: string): void }).setAlias('late');
          expect((await verify(member(), alice, late)).yes).to.deep.equal(['d1', 'd2', 'd6']);
          expect((await verify(member({ nested: true }), alice, late)).yes).to.deep.equal(['d1', 'd2', 'd6']);
          // An alias set before compiling and changed after it: the nested group must not keep the first.
          const ids = async (f: ResourceFilter) =>
            (
              (await asSystem(() => {
                const q = (Doc as any).query().setAlias('first');
                compileResidual(f, q, contextOf(Doc, alice));
                return q.setAlias('second');
              })) as ModelBase[]
            )
              .map((r) => (r as unknown as { id: string }).id)
              .sort();
          expect(await ids(member({ nested: true }))).to.deep.equal(['d1', 'd2', 'd6']);
          expect(await ids(not(member({ nested: true })))).to.deep.equal(['d3', 'd4', 'd5', 'd7']);
          const cloned = (await asSystem(() => {
            const q = (Doc as any).query();
            compileResidual(member(), q, contextOf(Doc, alice));
            return q.clone().setAlias('copy');
          })) as ModelBase[];
          expect(cloned.map((r) => (r as unknown as { id: string }).id).sort()).to.deep.equal(['d1', 'd2', 'd6']);
        });

        systemIt('the SQL is one EXISTS over the other table under an alias of its own, the principal bound once', async () => {
          const q = (Doc as any).query();
          compileResidual(member(), q, contextOf(Doc, alice));
          const { expression, bindings } = q.toDB() as { expression: string; bindings: unknown[] };
          expect(expression).to.match(/EXISTS \( SELECT 1 FROM .*\$authz_n\d+\$/);
          expect(bindings.filter((b) => b === 'alice')).to.have.length(1);
        });

        systemIt('correlatedQuery and correlate refuse what they cannot qualify', async () => {
          const q = (Doc as any).query();
          expect(() => correlatedQuery(q, fixture.table!)).to.throw(AuthzConfigError, /OrmNativeCompiler/);
          const Bad = class BadCompiler extends OrmNativeCompiler {
            readonly op = 'native:test.badcorrelate' as const;
            compile(args: unknown, builder: IWhereBuilder<unknown>): void {
              const m = correlatedQuery(builder, fixture.table!);
              if (String(args).startsWith('outer:')) whereSql(m, sql`${subColumn(m, 'scope_id')} = ${outerColumn(m, String(args).slice(6))}`);
              else if (String(args).startsWith('sub:')) whereSql(m, sql`${subColumn(m, String(args).slice(4))} = ${outerColumn(m, 'org_id')}`);
              else correlate(m, 'scope_id', String(args));
              builder.whereExist(m);
            }
          };
          DI.register(Bad).as(OrmNativeCompiler);
          try {
            for (const args of ['nope', 'outer:nope']) expect(() => compileResidual({ op: 'native:test.badcorrelate', args } as ResourceFilter, (Doc as any).query(), contextOf(Doc, alice))).to.throw(AuthzConfigError, /nope is not a column/);
            // The sub-query over a raw table has no model to check its own columns against.
            expect(() => compileResidual({ op: 'native:test.badcorrelate', args: 'sub:nope' } as ResourceFilter, (Doc as any).query(), contextOf(Doc, alice))).to.not.throw();
            const plain = (Doc as any).query();
            expect(() => correlate(plain, 'scope_id', 'org_id')).to.throw(AuthzConfigError, /correlatedQuery/);
            plain.where(function (this: IWhereBuilder<unknown>) {
              expect(() => correlate(this, 'scope_id', 'org_id')).to.throw(AuthzConfigError, /correlatedQuery/);
              expect(() => outerColumn(this, 'org_id')).to.throw(AuthzConfigError, /OrmNativeCompiler/);
            });
            expect(() => outerColumn(plain, 'org_id')).to.throw(AuthzConfigError, /OrmNativeCompiler/);
            expect(() => whereSql(plain, sql`1 = 1`)).to.throw(AuthzConfigError, /OrmNativeCompiler/);
          } finally {
            DI.unregister(Bad);
            DI.uncache(OrmNativeCompiler);
          }
        });

        systemIt('a lazy statement in a native fragment is refused: the orm would move it behind an OR', async () => {
          class Late extends LazyQueryStatement {
            build(): IQueryStatementResult {
              return { Statements: ['1 = 1'], Bindings: [] };
            }
            clone(): Late {
              return new Late(this.callback, this.context);
            }
          }
          const Lazy = class LazyCompiler extends OrmNativeCompiler {
            readonly op = 'native:test.lazy' as const;
            compile(_args: unknown, builder: IWhereBuilder<unknown>): void {
              builder.where('s', 'a');
              builder.where(function (this: IWhereBuilder<unknown>) {
                this.Statements.push(new Late(undefined as never, this));
              });
            }
          };
          DI.register(Lazy).as(OrmNativeCompiler);
          try {
            expect(() => compileResidual({ op: 'native:test.lazy' } as ResourceFilter, (Doc as any).query(), contextOf(Doc, alice))).to.throw(AuthzConfigError, /native:test.lazy.*lazy statement/);
          } finally {
            DI.unregister(Lazy);
            DI.uncache(OrmNativeCompiler);
          }
        });

        systemIt(`property: SQL selects exactly the rows the evaluator holds for, f and not f (seed ${SEED}, ${RUNS} runs)`, async () => {
          const args = pick<MemberArgs>([{}, { role: 'editor' }, { role: 'viewer' }, { loose: true }, { via: 'model' }, { negate: true }, { nested: true }, { role: 'editor', loose: true, nested: true }, { restricted: 'top' }, { restricted: 'group', nested: true }, { path: true }, { path: true, restricted: 'group', negate: true }, { case: true }, { attr: { want: 'editor', dflt: 'none' } }, { attr: { want: 'none', dflt: 'none' }, negate: true }]);
          const leaf = fc.oneof(args.map(member), pick([cmp('s', 'eq', 'a'), cmp('org_id', 'eq', 'o2'), cmp('s', 'null'), { op: 'true' } as ResourceFilter, { op: 'false' } as ResourceFilter]));
          const tree = fc.letrec<{ node: ResourceFilter }>((self) => ({
            node: fc.oneof({ depthSize: 'small', withCrossShrink: true }, { weight: 3, arbitrary: leaf }, { weight: 1, arbitrary: fc.array(self('node'), { maxLength: 3 }).map((xs) => and(...xs)) }, { weight: 1, arbitrary: fc.array(self('node'), { maxLength: 3 }).map((xs) => or(...xs)) }, { weight: 1, arbitrary: self('node').map(not) }),
          }));
          let selected = 0;
          await fc.assert(
            fc.asyncProperty(tree.node, pick(PRINCIPALS), async (f, principal) => {
              const r = await verify(f, principal);
              selected += r.yes.length;
            }),
            { seed: SEED, numRuns: RUNS },
          );
          expect(selected, 'the runs select rows').to.be.greaterThan(RUNS);
        });

        // Last: it changes the rows the other cases read.
        systemIt('an update and a delete without an alias correlate with their table', async () => {
          const table = db.table(Doc);
          const run = async (kind: 'update' | 'delete', f: ResourceFilter) => {
            await asSystem(() => {
              const q = kind === 'update' ? (Doc as any).update({ s: 'u' }) : (Doc as any).destroy(ALL);
              compileResidual(f, q, { ...contextOf(Doc, bob), op: kind });
              return q;
            });
            const after = (await db.raw(`SELECT id, s FROM "${table}"`, [], dialect)) as { id: string; s: string | null }[];
            return after
              .filter((r) => (kind === 'update' ? r.s === 'u' : true))
              .map((r) => r.id)
              .sort();
          };
          expect(await run('update', member())).to.deep.equal(['d2', 'd6']);
          expect(await run('delete', member())).to.deep.equal(['d1', 'd3', 'd4', 'd5', 'd7']);
        });
      });

      describe('through the query middleware', () => {
        const undo: (() => void | Promise<void>)[] = [];
        let domainSeq = 0;

        afterEach(async () => {
          for (const fn of undo.splice(0).reverse()) await fn();
          await db.clear();
        });

        const setConfig = (path: string[], value: unknown) => {
          const config = testHost.config();
          const before = config.get<unknown>(path);
          config.set(path, value);
          undo.push(() => (before === undefined ? config.unset(path) : config.set(path, before)));
        };

        /** A model whose votes may hold the fake op; the engine needs a NativeFilter for it at boot. */
        class NativeModel extends StaticModel {
          init(ctx: ModelInitContext): void {
            super.init(ctx);
            ctx.registerNativeFilter(new MemberFilter(''));
          }
        }

        async function host(votes: VoteTable) {
          const ds = await testHost.domains();
          const name = `nat${dialect}${++domainSeq}`;
          const permissions = Object.fromEntries(['ndoc', 'nnote'].flatMap((t) => ['read', 'create', 'update', 'delete'].map((a) => [`${t}:${a}`, { types: [t] }])));
          setConfig(['authz', 'domains', name], { permissions, combine: { default: { algorithm: 'deny-overrides', models: ['m1'] } }, cache: { maxEntries: 0 } });
          setConfig(['authz', 'orm', 'domain'], name);
          const container: IContainer = ds.create(name, 'root');
          undo.push(() => (ds.names().includes(name) ? container.dispose() : undefined));
          container.register(testHost.instance(new NativeModel({ name: 'm1', votes, capabilities: { residuals: [...CORE_FILTER_OPS, OP] } }))).as(AuthorizationModel);
          container.register(testHost.instance(new RecordingAudit())).as(DecisionAudit);
          await ds.service(name);
        }

        const as = <T>(p: Principal, fn: () => T | Promise<T>): Promise<T> => runWithPrincipal(p, async () => fn());
        const idsOf = (rows: readonly unknown[]): string[] => rows.map((r) => String((r as { id: unknown }).id)).sort();
        const permitAll = (when: ResourceFilter): VoteTable => Object.fromEntries(['read', 'update', 'delete'].map((a) => [`ndoc:${a}`, { permitWhen: when }]));

        it("a list, a caller's orWhere, a clone and its count read only the rows the native residual allows", async () => {
          await host(permitAll(member()));
          const { Doc } = (await define(dialect)) as { Doc: any };
          expect(idsOf(await as(bob, () => Doc.query()))).to.deep.equal(['d2', 'd6']);
          expect(idsOf(await as(bob, () => Doc.query().where('s', 'b').orWhere('s', 'a')))).to.deep.equal(['d2']);
          const { q } = await as(bob, () => ({ q: Doc.query().setAlias('d') }));
          expect(idsOf(await as(bob, () => q.clone()))).to.deep.equal(['d2', 'd6']);
          expect(Number(await as(bob, () => q.clone().selectCount()))).to.equal(2);
          const { w } = await as(bob, () => ({ w: Doc.query().where('s', 'b').orWhere('s', 'a') }));
          expect(idsOf(await as(bob, () => w.clone())), "a clone keeps the caller's orWhere").to.deep.equal(['d2']);
          expect(Number(await as(bob, () => w.clone().selectCount()))).to.equal(1);
        });

        it('nested and grouped correlations (restriction, onPath, CASE, COALESCE): a list, its clones and a count of a clone', async () => {
          const shapes: [MemberArgs, string[]][] = [
            [{ restricted: 'top' }, ['d2', 'd6']],
            [{ restricted: 'group' }, ['d2', 'd6']],
            [{ path: true }, ['d1', 'd2', 'd3', 'd6']],
            [{ case: true, restricted: 'top' }, ['d2', 'd6']],
            [{ attr: { want: 'none', dflt: 'none' } }, ['d3', 'd4', 'd5', 'd7']],
          ];
          for (const [args, want] of shapes) {
            await host(permitAll(member(args)));
            const { Doc } = (await define(dialect)) as { Doc: any };
            const what = JSON.stringify(args);
            expect(idsOf(await as(alice, () => Doc.query())), what).to.deep.equal(want);
            const { q } = await as(alice, () => ({ q: Doc.query() }));
            expect(idsOf(await as(alice, () => q.clone())), what).to.deep.equal(want);
            expect(idsOf(await as(alice, () => q.clone().clone())), what).to.deep.equal(want);
            expect(Number(await as(alice, () => q.clone().selectCount())), what).to.equal(want.length);
            expect(idsOf(await as(alice, () => q)), what).to.deep.equal(want);
            for (const fn of undo.splice(0).reverse()) await fn();
            await db.clear();
          }
        });

        it('under not and inside or, from the residual a model votes', async () => {
          await host(permitAll(or(cmp('s', 'eq', 'c'), not(member({ role: 'viewer' })))));
          const { Doc } = (await define(dialect)) as { Doc: any };
          // alice is a viewer in o2 only.
          expect(idsOf(await as(alice, () => Doc.query()))).to.deep.equal(['d1', 'd3', 'd4', 'd5', 'd7']);
        });

        it('an update and a delete reach only the rows the native residual allows', async () => {
          await host(permitAll(member()));
          const { Doc } = (await define(dialect)) as { Doc: any };
          const table = db.table(Doc);
          await as(bob, () => Doc.update({ s: 'u' }).whereIn('id', ALL));
          const updated = (await db.raw(`SELECT id FROM "${table}" WHERE s = 'u'`, [], dialect)) as { id: string }[];
          expect(idsOf(updated)).to.deep.equal(['d2', 'd6']);
          await as(bob, () => Doc.destroy(ALL));
          expect(idsOf(await db.raw(`SELECT id FROM "${table}"`, [], dialect))).to.deep.equal(['d1', 'd3', 'd4', 'd5', 'd7']);
        });

        for (const relationScope of ['where', 'join'] as const) {
          it(`a populated relation correlates with the relation's alias (relationScope '${relationScope}')`, async () => {
            await host(permitAll(member()));
            const { Doc } = await define(dialect, { relationScope });
            const Note = (await db.define(
              {
                name: 'NNote',
                columns: { doc_id: 'TEXT' },
                rows: DOCS.map((d) => ({ id: `n${d.id.slice(1)}`, doc_id: d.id })),
                decorate: (_cls, proto) => BelongsTo(Doc as never, 'doc_id', 'id')(proto, 'doc'),
              },
              dialect,
            )) as any;
            (db.orm as unknown as { wireRelations(): void }).wireRelations();
            const rows = (await as(bob, () => Note.query().select('id', 'nid').populate('doc').asRaw())) as Record<string, unknown>[];
            const seen = rows
              .map((r) => [String(r.nid), String(r['$doc$.id'] ?? null)])
              .filter(([, d]) => d !== 'null')
              .map(([n]) => n)
              .sort();
            expect(seen).to.deep.equal(['n2', 'n6']);
            if (relationScope === 'where') expect(rows.map((r) => String(r.nid)).sort()).to.deep.equal(['n2', 'n6']);
            else expect(rows).to.have.length(DOCS.length);
          });
        }
      });
    });
  }
});

describe('authz-orm native sql fragments', () => {
  const refused = (make: () => unknown, message: RegExp) => expect(make).to.throw(AuthzConfigError, message);

  it('refuse literal text that could leave the brackets the fragment is wrapped in, or comment the rest out', () => {
    refused(() => sql`1 = 0)) OR ((1 = 1`, /bracket/);
    refused(() => sql`(1 = 1`, /bracket/);
    refused(() => sql`1 = 1)`, /bracket/);
    refused(() => sql`) OR (`, /bracket/);
    refused(() => sql`1 = 1; DROP TABLE x`, /;/);
    refused(() => sql`1 = 1 -- rest`, /--/);
    refused(() => sql`1 = 1 /* rest */`, /\/\*/);
    refused(() => sql`1 = 1 # rest`, /#/);
    refused(() => sql`'unterminated`, /quote/);
    refused(() => sql`${'a'} = 'b`, /quote/);
    refused(() => sql`x = '${'v'}'`, /quoted/);
    const pgEscaped = `x = E'${String.fromCharCode(92)}'' OR 1 = 1`;
    refused(() => sql(Object.assign([pgEscaped], { raw: [pgEscaped] }) as unknown as TemplateStringsArray), /backslash/);
    // SQLite reads [a] and PG reads $$a$$ as quoted names and strings: their contents are not scanned here.
    refused(() => sql`[x'] OR (1 = 1) OR [']`, /\[/);
    refused(() => sql`$$x'$$ OR (1 = 1) OR $$'$$`, /\$/);
    refused(() => sql`x = ?`, /\?/);
    // A comment made of the end of one part and the start of a nested fragment.
    refused(() => sql`(0 -${sql`-x`}\n= 1) OR (1 = 1)`, /--/);
    refused(() => sql`1 = 1 /${sql`* x */`}`, /\/\*/);
    refused(() => sql`x = '${sql`a`}${'v'}'`, /quoted/);
    // SQLite named parameters take the next binding.
    refused(() => sql`@x IS NULL`, /parameter/);
    refused(() => sql`:x IS NULL`, /parameter/);
    refused(() => sql`${'a'}:b = 1`, /parameter/);
    refused(() => sql`x = @${sql`y`}`, /parameter/);
    // orm-postgres turns every ? into $n, also inside a literal.
    refused(() => sql`role <> '?'`, /\?/);
  });

  it('accept brackets, quotes and comment marks inside quoted literals, PG casts and containment, and nested fragments', () => {
    expect(() => sql`'(' <> ')' AND '--;/*[$#:x@y' <> ''''`).to.not.throw();
    expect(() => sql`"a""(b" IS NULL AND \`c\`\`)\` IS NULL`).to.not.throw();
    expect(() => sql`x::text = 'a' AND a @> b AND a <@ b AND ${'v'}::int = 1`).to.not.throw();
    expect(() => sql`NOT (${sql`(1 = ${1})`}) AND COALESCE((${sql`SELECT 1`}), ${2}) = ${2}`).to.not.throw();
  });

  it('bind scalars, dates and buffers; expand arrays one binding per element; refuse other values', () => {
    expect(() => sql`${'a'} ${1} ${1n} ${true} ${null} ${new Date(0)} ${Buffer.from('x')}`).to.not.throw();
    const f = sql`x IN (${['a', 1, null]})`;
    const bound = f.parts.filter((p) => typeof p !== 'string').map((p) => (p as { value: unknown }).value);
    expect(bound).to.deep.equal(['a', 1, null]);
    expect(f.parts.filter((p) => typeof p === 'string').join('')).to.equal('x IN (, , )');
    refused(() => sql`x IN (${[]})`, /empty array/);
    refused(() => sql`x IN (${[['a']]})`, /array/);
    refused(() => sql`x = ${{ a: 1 }}`, /object/);
    refused(() => sql`x IN (${[{ a: 1 }]})`, /object/);
    refused(() => sql`x = ${undefined}`, /undefined/);
    refused(() => sql`x = ${() => 1}`, /function/);
  });
});
