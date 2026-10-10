import { AuthzConfigError, SCOPE_CONDITION_OP } from '@spinajs/authz';
import type { EvaluationContext, Policy, Principal, ResourceFilter, ResourceRef, ScopeAttributeSchema, ScopeConditionArgs } from '@spinajs/authz';
import { OrmNativeCompiler } from '@spinajs/authz-orm';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { IdentifierQuoter } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';

import { ConditionScopeOrmCompiler, OrmRbacScopePathSource, RBAC_SQLITE_TERM_DEPTH, RbacPathSql, RbacScopeAttributeSource, RbacScopeDefaults, ormRbacScopeLayers, rbacDialectOf, scopeConditionSql } from '../../src/orm/index.js';
import { sqliteParserDepth } from '../../src/orm/compile/sqlite-depth.js';
import { KINDS, RootOrm } from '../orm/root-orm.js';
import { user } from '../orm/orm-world.js';
import { NODES, PERMISSION, SCOPE_DOCS, ScopeWorld, ScopeWorldAttributeSource, scopeLeaves } from './scope-world.js';

/*
 * `native:condition.scope` leaves in SQL (ConditionScopeOrmCompiler) against the in-memory leaf
 * (SCOPE_CONDITION_FILTER: the check's own read and comparison), test kind by op by attribute value: values stored,
 * from a schema default, missing, null, an object, a list, a scalar above the path, numeric strings, long numbers,
 * strings with escapes, booleans against 0 and 1; on a store type (team), adapter types (org, project), the row's
 * own type (doc), an adapter attribute (org `tier`), nodes that are missing, have the id '' or are absent. Each leaf
 * and its NOT are listed: a doc the adapter finds is in exactly one of them (the flag is two-valued there), a doc
 * it cannot find in neither. `true` / `false`: SQL lists only rows the leaf holds on, and all of them unless SQL
 * cannot decide the value (documented in compile/scope-leaf.ts); `fault`: all rows the leaf holds on, more only
 * where SQL cannot read the layer.
 */

const MISSING = Symbol('missing');
const OBJECT = Symbol('object');
const ABOVE = Symbol('above');
type Value = string | number | boolean | typeof MISSING | typeof OBJECT | typeof ABOVE;

const VALUES: readonly Value[] = [0, 1, 3, -2.5, 1234567890.1234567, 1e21, 'gold', '3', '03', '', 'a"b', 'x\\y', true, false, OBJECT, ABOVE, MISSING];

// org: a scalar default, team: a list, project: null; doc none.
const SCHEMAS: readonly ScopeAttributeSchema[] = [
  { scopeType: 'org', schema: {}, defaults: { p: { v: 7 } } },
  { scopeType: 'team', schema: {}, defaults: { p: { v: [1, 2] } } },
  { scopeType: 'project', schema: {}, defaults: { p: { v: null } } },
];

const stored = (v: Value): Record<string, unknown> => (v === MISSING ? {} : v === OBJECT ? { p: { v: { k: 1 } } } : v === ABOVE ? { p: 5 } : { p: { v } });

type Cmp = Pick<Extract<ScopeConditionArgs, { op: unknown }>, 'op' | 'value'>;
const LEAVES: readonly Cmp[] = [...[3, 1, 0, '3', 'gold', true, false, 'a"b'].map((value) => ({ op: 'eq' as const, value })), ...[3, 'gold', true].map((value) => ({ op: 'ne' as const, value })), { op: 'in', value: [3, 'gold'] }, { op: 'in', value: ['3', 0] }, { op: 'nin', value: [1, 'x'] }, { op: 'lt', value: 2 }, { op: 'lte', value: '1' }, { op: 'gt', value: 0 }, { op: 'gte', value: 'b' }, { op: 'like', value: 'g%' }, { op: 'glob', value: 'g*' }, { op: 'wildcard', value: '*d' }, { op: 'null', value: true }, { op: 'null', value: false }];
const TIER_LEAVES: readonly Cmp[] = [
  { op: 'eq', value: 'gold' },
  { op: 'ne', value: 'gold' },
  { op: 'null', value: false },
];
const READS: readonly { type: string; path: string; leaves: readonly Cmp[] }[] = [
  { type: 'org', path: 'p.v', leaves: LEAVES },
  { type: 'project', path: 'p.v', leaves: LEAVES },
  { type: 'team', path: 'p.v', leaves: LEAVES },
  { type: 'doc', path: 'p.v', leaves: LEAVES },
  { type: 'org', path: 'tier', leaves: TIER_LEAVES },
];

type Kleene = boolean | null;
type Scalar = string | number | boolean;

const ORDER_OPS = new Set(['lt', 'lte', 'gt', 'gte']);

const isScalar = (v: unknown): v is Scalar => typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number';
const canonicalNumber = (s: string): number | undefined => (Number.isFinite(Number(s)) && String(Number(s)) === s ? Number(s) : undefined);
/** A number whose JSON text SQL compares exactly: at most 15 characters, no exponent. */
const short = (n: number): boolean => JSON.stringify(n).length <= 15 && !/e/i.test(JSON.stringify(n));
const kleeneAny = (xs: readonly Kleene[]): Kleene => (xs.includes(true) ? true : xs.includes(null) ? null : false);
const kleeneNot = (x: Kleene): Kleene => (x === null ? null : !x);

/** `eq` of a present scalar attribute and a literal as SQL decides it; null where SQL leaves it undecided. */
function sqlEquals(v: Scalar, lit: Scalar): Kleene {
  if (typeof v === 'number') {
    if (typeof lit === 'boolean') return short(v) && (v === 0 || v === 1) ? (v === 1) === lit : null;
    const n = typeof lit === 'number' ? lit : canonicalNumber(lit);
    return n !== undefined && short(v) ? v === n : null;
  }
  if (typeof v === 'string') {
    // A stored text holding an escape may spell the literal another way.
    if (typeof lit === 'string') return v === lit ? true : JSON.stringify(v).includes('\\') ? null : false;
    // Only the number's own text is decided: the engine's FALSE for another numeric string looks like its UNKNOWN.
    if (typeof lit === 'number') return v === String(lit) ? true : null;
    return null;
  }
  if (typeof lit === 'boolean') return v === lit;
  return lit === 0 || lit === 1 ? v === (lit === 1) : null;
}

/** The comparison of a present attribute as compile/scope-leaf.ts decides it (no bound); null: SQL cannot tell. */
function sqlTruth(v: unknown, c: Cmp): Kleene {
  if (c.op === 'null') return c.value === false;
  if ((c.op === 'in' || c.op === 'nin') && Array.isArray(c.value) && c.value.length === 0) return c.op === 'nin';
  if (!isScalar(v)) return null;
  switch (c.op) {
    case 'eq':
      return sqlEquals(v, c.value as Scalar);
    case 'ne':
      return kleeneNot(sqlEquals(v, c.value as Scalar));
    case 'in':
      return kleeneAny((c.value as Scalar[]).map((l) => sqlEquals(v, l)));
    case 'nin':
      return kleeneNot(kleeneAny((c.value as Scalar[]).map((l) => sqlEquals(v, l))));
    default: {
      if (!ORDER_OPS.has(c.op) || typeof v !== 'number' || !short(v)) return null;
      const n = typeof c.value === 'number' ? c.value : canonicalNumber(String(c.value));
      if (n === undefined) return null;
      return { lt: v < n, lte: v <= n, gt: v > n, gte: v >= n }[c.op as 'lt' | 'lte' | 'gt' | 'gte'];
    }
  }
}

/** Where compile/scope-leaf.ts leaves a value the engine decides undecided (both flags 0). */
const undecided = (v: unknown, c: Cmp): boolean => sqlTruth(v, c) === null;

const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);
function readOwn(from: unknown, path: readonly string[]): unknown {
  let v = from;
  for (const segment of path) {
    if (UNSAFE.has(segment) || v === null || typeof v !== 'object' || !Object.hasOwn(v, segment)) return undefined;
    v = (v as Record<string, unknown>)[segment];
  }
  return v;
}

/** The engine's value of `scope.<type>.<path>` at the doc, as the check reads it (undefined where it faults). */
async function valueAt(ctx: EvaluationContext, id: string, type: string, path: string): Promise<unknown> {
  const ancestors = await ctx.ancestors({ type: 'doc', id });
  const node = ancestors?.find((a) => a.type === type);
  if (!node || typeof node.id !== 'string') return undefined;
  const attrs = await ctx.attributes({ type, id: node.id });
  return attrs === null ? undefined : readOwn(attrs, path.split('.'));
}

const leaf = (args: unknown): ResourceFilter => ({ op: SCOPE_CONDITION_OP, args } as unknown as ResourceFilter);
const not = (f: ResourceFilter): ResourceFilter => ({ op: 'not', arg: f } as ResourceFilter);

/** A principal whose every read throws. */
const untouchable = (): Principal =>
  new Proxy({} as Principal, {
    get: (_t, key) => {
      throw new Error(`the principal was read (${String(key)})`);
    },
  });

describe('authz-rbac orm-compile: native:condition.scope leaves in SQL = the in-memory leaf', function () {
  this.timeout(1800000);

  let db: RootOrm;
  let undoSource: (() => void) | undefined;

  before(async function () {
    db = await RootOrm.open(this, 'a4_scope_leaf');
    await (await testHost.domains()).service('root');
    undoSource = testHost.registerInRoot(RbacScopeAttributeSource, testHost.instance(new ScopeWorldAttributeSource()));
  });

  after(async () => {
    undoSource?.();
    DI.uncache(RbacScopeAttributeSource);
    await db?.close();
  });

  it('is registered as an OrmNativeCompiler for authz-orm to collect', () => {
    expect(DI.RootContainer.hasRegisteredType(OrmNativeCompiler, ConditionScopeOrmCompiler)).to.equal(true);
  });

  for (const kind of KINDS) {
    describe(kind, () => {
      let world: ScopeWorld;
      const p = user('alice');

      before(async () => {
        world = await ScopeWorld.open(db, kind);
      });

      after(async () => {
        await world?.close();
      });

      /** The three-valued answer of SQL per doc: 1, 0, or null where neither the leaf nor its NOT lists it. */
      async function sqlTruth(args: unknown): Promise<Map<string, 1 | 0 | null>> {
        const yes = await world.sql(leaf(args), p);
        const no = await world.sql(not(leaf(args)), p);
        const out = new Map<string, 1 | 0 | null>();
        for (const id of world.docIds()) {
          expect(yes.includes(id) && no.includes(id), `${JSON.stringify(args)}: doc ${id} listed by the leaf and by its NOT`).to.equal(false);
          out.set(id, yes.includes(id) ? 1 : no.includes(id) ? 0 : null);
        }
        return out;
      }

      for (const scenario of [0, 1, 2, 3]) {
        it(`scenario ${scenario}: each leaf lists what the in-memory leaf holds on, all of it where SQL decides the value`, async () => {
          const nodes = NODES.map((n, i): [ResourceRef, Record<string, unknown>] => [n, stored(VALUES[(i + scenario * 4) % VALUES.length])]);
          await world.attributes(nodes, SCHEMAS);
          const ctx = world.context();
          const counts = { true: 0, false: 0, fault: 0, undecided: 0, unreadable: 0, faultWider: 0 };
          const started = Date.now();
          for (const read of READS) {
            const argsOf = [{ v: 1, test: 'fault', type: read.type, path: read.path }, ...read.leaves.flatMap((c) => (['true', 'false'] as const).map((test) => ({ v: 1, test, type: read.type, path: read.path, op: c.op, value: c.value })))];
            for (const args of argsOf) {
              const sql = await sqlTruth(args);
              for (const id of world.docIds()) {
                const at = `${kind}, scenario ${scenario}, doc ${id}, ${JSON.stringify(args)}`;
                if (id === 'x9') {
                  expect(sql.get(id), `a doc the adapter cannot find is UNKNOWN: ${at}`).to.equal(null);
                  continue;
                }
                const mem = await world.memory(args, id, ctx);
                const got = sql.get(id) === 1;
                expect(sql.get(id), `two-valued for a doc the adapter finds: ${at}`).to.not.equal(null);
                if (args.test === 'fault') {
                  if (mem) counts.fault++;
                  expect(!mem || got, `fault: SQL misses a fault: ${at}`).to.equal(true);
                  if (got && !mem) {
                    expect(read.path, `fault: SQL faults where the check reads: ${at}`).to.equal('tier');
                    counts.faultWider++;
                  }
                  continue;
                }
                expect(!got || mem, `SQL lists a row the leaf does not hold on: ${at}`).to.equal(true);
                if (mem && !got) {
                  const v = await valueAt(ctx, id, read.type, read.path);
                  if (read.path === 'tier') counts.unreadable++;
                  else {
                    expect(undecided(v, args as Cmp), `SQL leaves a value it decides undecided (value ${JSON.stringify(v)}): ${at}`).to.equal(true);
                    counts.undecided++;
                  }
                } else if (mem) counts[args.test as 'true' | 'false']++;
              }
            }
          }
          console.log(`      ${kind} scenario ${scenario}: ${Date.now() - started} ms; ${JSON.stringify(counts)}`);
          expect(counts.true, 'TRUE leaves').to.be.at.least(40);
          expect(counts.false, 'FALSE leaves').to.be.at.least(40);
          expect(counts.fault, 'faults').to.be.at.least(8);
        });
      }

      it('faults: no ancestor of the type, a missing node, a node id of "", null and missing attributes; the row as its own node', async () => {
        await world.attributes(
          NODES.map((n) => [n, { p: { v: 1 } }]),
          SCHEMAS,
        );
        const fault = async (type: string, path = 'p.v') => [...(await sqlTruth({ v: 1, test: 'fault', type, path }))].filter(([, v]) => v === 1).map(([id]) => id);
        // 4: no project; 5: no org; 6: org id ''; 7: org o9 has no row; 3 and 5: no team.
        expect(await fault('org')).to.deep.equal(['5', '6', '7']);
        expect(await fault('project')).to.deep.equal(['4']);
        expect(await fault('team')).to.deep.equal(['3', '5']);
        expect(await fault('doc')).to.deep.equal([]);
        expect(await fault('nothing')).to.deep.equal(SCOPE_DOCS.map((d) => String(d.id)));
        // A null default and a missing attribute fault; a list default does not.
        expect(await fault('project', 'p.w')).to.deep.equal(SCOPE_DOCS.map((d) => String(d.id)));
        await world.attributes([], SCHEMAS);
        expect(await fault('project')).to.deep.equal(SCOPE_DOCS.map((d) => String(d.id)));
        expect(await fault('team')).to.deep.equal(['3', '5']);
        const eq1 = [...(await sqlTruth({ v: 1, test: 'true', type: 'org', path: 'p.v', op: 'eq', value: 7 }))].filter(([, v]) => v === 1).map(([id]) => id);
        expect(eq1, 'the schema default').to.deep.equal(['1', '2', '3', '4']);
      });

      it('an adapter attribute (org tier) is a fault in SQL and never TRUE or FALSE: narrower', async () => {
        await world.attributes([], SCHEMAS);
        const ctx = world.context();
        const args = { v: 1, test: 'true', type: 'org', path: 'tier', op: 'eq', value: 'gold' };
        expect(await world.memory(args, '1', ctx), 'the check reads the adapter layer').to.equal(true);
        expect([...(await sqlTruth(args)).values()].filter((v) => v === 1)).to.deep.equal([]);
        expect([...(await sqlTruth({ v: 1, test: 'fault', type: 'org', path: 'tier' })).entries()].filter(([, v]) => v === 1).map(([id]) => id)).to.deep.equal(SCOPE_DOCS.map((d) => String(d.id)));
      });

      it('refuses malformed args and types no leaf reads, naming the op, the domain and the type', async () => {
        const compiler = new ConditionScopeOrmCompiler(DI.RootContainer);
        const cfg = testHost.config();
        const before = cfg.get<unknown>(['authz', 'orm', 'domain']);
        cfg.set(['authz', 'orm', 'domain'], 'a4unit');
        try {
          for (const args of [undefined, null, {}, { v: 1, test: 'maybe', type: 'org', path: 'p.v' }, { v: 2, test: 'fault', type: 'org', path: 'p.v' }, { v: 1, test: 'true', type: 'org', path: 'p.v', op: 'eq' }, { v: 1, test: 'fault', type: 'a.b', path: 'p.v' }, { v: 1, test: 'fault', type: '$global', path: 'p.v' }]) {
            const error = await world
              .run((q) => compiler.compile(args, q, world.Doc, p))
              .then(
                () => undefined,
                (e: unknown) => e,
              );
            expect(error, JSON.stringify(args)).to.be.instanceOf(AuthzConfigError);
            expect((error as Error).message, JSON.stringify(args))
              .to.contain(SCOPE_CONDITION_OP)
              .and.contain('"a4unit"')
              .and.contain("type 'doc'");
          }
        } finally {
          if (before === undefined) cfg.unset(['authz', 'orm', 'domain']);
          else cfg.set(['authz', 'orm', 'domain'], before);
        }
      });

      it('reads no principal (RFC E2-2)', async () => {
        await world.attributes(
          NODES.map((n) => [n, { p: { v: 1 } }]),
          SCHEMAS,
        );
        const compiler = new ConditionScopeOrmCompiler(DI.RootContainer);
        expect(await world.run((q) => compiler.compile({ v: 1, test: 'true', type: 'org', path: 'p.v', op: 'eq', value: 1 }, q, world.Doc, untouchable()))).to.deep.equal(['1', '2', '3', '4']);
      });

      // As canvas's agents-disabled deny: a deny on a scope attribute beside an unconditional permit.
      const POLICIES: readonly Policy[] = [
        { id: 'off', effect: 'deny', permissions: [PERMISSION], when: { attr: 'scope.org.p.v', eq: 1 }, source: 'test' },
        { id: 'all', effect: 'permit', permissions: [PERMISSION], source: 'test' },
      ];

      it('boot: with authz-rbac loaded the adapter compiles the op, and an ABAC model with scopeResiduals boots over doc and lists in SQL', async () => {
        await world.attributes(
          [
            [{ type: 'org', id: 'o1' }, { p: { v: 1 } }],
            [{ type: 'org', id: 'o2' }, { p: { v: 2 } }],
          ],
          SCHEMAS,
        );
        expect(world.adapter.compiles).to.include(SCOPE_CONDITION_OP);
        const service = await world.domain({ policies: POLICIES, algorithm: 'deny-overrides' });
        const residual = await service.filter(p, PERMISSION, 'doc');
        expect(scopeLeaves(residual)).to.not.deep.equal([]);
        const allowed = await world.allowed(p);
        expect(allowed).to.deep.equal(['2', '4']);
        expect(await world.sql(residual, p)).to.deep.equal(allowed);
      });

      it('boot: without the compiler registered, boot refuses the ABAC model (rule 4)', async () => {
        await world.attributes([], SCHEMAS);
        const list = DI.RootContainer.Registry.getTypes(OrmNativeCompiler, false) as unknown[];
        const i = list.indexOf(ConditionScopeOrmCompiler);
        expect(i, 'registered').to.be.at.least(0);
        list.splice(i, 1);
        DI.uncache(OrmNativeCompiler);
        try {
          expect(world.adapter.compiles).to.not.include(SCOPE_CONDITION_OP);
          const error = await world.domain({ policies: POLICIES, algorithm: 'deny-overrides' }).then(
            () => undefined,
            (e: unknown) => e,
          );
          expect(error).to.be.instanceOf(Error);
          expect((error as Error).message)
            .to.contain(SCOPE_CONDITION_OP)
            .and.contain('not compiled by adapter');
        } finally {
          list.splice(i, 0, ConditionScopeOrmCompiler);
          DI.uncache(OrmNativeCompiler);
        }
        expect(world.adapter.compiles).to.include(SCOPE_CONDITION_OP);
      });

      it(`a leaf stays well within the SQLite parser stack a term may take (${RBAC_SQLITE_TERM_DEPTH})`, () => {
        const driver = db.driver(kind);
        const dialect = rbacDialectOf(driver);
        const path = new RbacPathSql(new OrmRbacScopePathSource().path(world.Doc)!, driver.Container.resolve(IdentifierQuoter), dialect);
        const defaults = RbacScopeDefaults.of(SCHEMAS, { ...ormRbacScopeLayers(driver), team: { kind: 'store' } });
        let deepest = 0;
        for (const read of READS) {
          for (const c of [undefined, ...read.leaves]) {
            const args = (c === undefined ? { v: 1, test: 'fault', type: read.type, path: read.path } : { v: 1, test: 'false', type: read.type, path: read.path, op: c.op, value: c.value }) as ScopeConditionArgs;
            deepest = Math.max(deepest, sqliteParserDepth(scopeConditionSql(args, { path, rowType: 'doc', defaults, dialect })));
          }
        }
        console.log(`      deepest leaf: ${deepest} entries`);
        // Postgres has no such stack, and its attribute lookups take a derived level more (attrLookup).
        if (kind === 'sqlite') expect(deepest).to.be.at.most(RBAC_SQLITE_TERM_DEPTH - 20);
      });
    });
  }
});
