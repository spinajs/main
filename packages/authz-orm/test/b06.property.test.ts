import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { GLOBAL, SYSTEM, runWithPrincipal } from '@spinajs/authz';
import type { Principal, PrincipalRef, ResourceFilter, ResourceRef, Value, Vote } from '@spinajs/authz';
import { FakeRbacModel, FakeTupleModel, FakeTupleStore, StaticModel, agentPrincipal, arb, fixtureDsl, testHost, userPrincipal } from '@spinajs/authz-testing';
import type { FakeGrant, ScriptedVote, Tuple } from '@spinajs/authz-testing';

import { TestDb } from './support/db.js';
import type { Dialect } from './support/db.js';
import { OrmTables, TupleTables, agree, bootDomain, emptyAgreement, useTupleCompiler } from './support/b06.js';
import type { Agreement, Row, TableSpec } from './support/b06.js';

const expect = chai.expect;

// Plan L4 task 10: check ⇔ filter through the host and the middleware, on SQLite and Postgres.
// The judge is the engine (`check` with the row as subject): these worlds include the coercions
// where the kit's evaluateFilter differs from it (numeric strings, booleans against 0 and 1,
// boolean ordering). Where conventions §5 compiles a leaf "sound only" the SQL may report UNKNOWN
// for a row the engine decides: the ⇔ worlds keep such inputs out (`exactOnly`), and a run of the
// raw votes asserts the sound direction for them.
const SEED = 20261010;
// The lane acceptance runs AUTHZ_ORM_B06_RUNS=100 or more; the default keeps the package suite short.
const RUNS = Number(process.env.AUTHZ_ORM_B06_RUNS ?? 20);

const TYPE = 'b06doc';
const READ = `${TYPE}:read`;
const WRITE = `${TYPE}:write`;

const u0 = userPrincipal('u0', { attributes: { pool: 'a', level: 1 } });
const u1 = userPrincipal('u1', { attributes: { pool: 'b', level: 2 } });
const u2 = userPrincipal('u2');
const PRINCIPALS: readonly Principal[] = [u0, u1, u2, agentPrincipal('bot', u0, { delegation: 'inherit' }), agentPrincipal('bot2', u1, { delegation: 'intersect' })];
const SUBJECTS = [u0, u1, u2, ...PRINCIPALS.slice(3)].map((p) => ({ type: p.type, id: p.id }));

const P1: ResourceRef = { type: 'project', id: 'p1' };
const P2: ResourceRef = { type: 'project', id: 'p2' };
const NODES: readonly ResourceRef[] = [GLOBAL, P1, P2, { type: 'project', id: 'p9' }, { type: 'org', id: '1' }, { type: 'org', id: '2' }, { type: TYPE, id: 'r1' }, { type: TYPE, id: 'r2' }];
// A type-level scope matches any node of the type (B39/F3).
const SCOPES: readonly ResourceRef[] = [...NODES, { type: 'project' }, { type: 'org' }, { type: TYPE }, { type: 'other' }];

const SPEC: TableSpec = {
  type: TYPE,
  permissions: [READ, WRITE],
  columns: { name: 'text', status: 'text', code: 'text', owner: 'text', n: 'int', r: 'real', flag: 'bool', project_id: 'text', org_id: 'int' },
  owner: 'owner',
  scopeColumns: [
    { column: 'project_id', scopeType: 'project' },
    { column: 'org_id', scopeType: 'org' },
  ],
};

const pick = <T>(xs: readonly T[]) => fc.constantFrom(...xs);
const nullable = <T>(a: fc.Arbitrary<T>) => fc.oneof({ weight: 4, arbitrary: a }, { weight: 1, arbitrary: fc.constant(null) });

// `name` may hold canonical number strings; `status` holds only number-like strings that are not
// canonical ('01', '1.0'), which every comparison with a number reads as UNKNOWN, in SQL too;
// `code` holds '1' or strings that are no number, compared with the number 1 only (`exactOnly`).
const NAMES = ['a', 'b', 'A', '', 'a%b', 'a_b', 'a/b', 'a/b/c', '1', '10', '-1', '1.5', '01'];
const STATUSES = ['open', 'closed', 'Open', '01', '1.0', 'u0'];
const CODES = ['1', '1', 'x', 'abc'];
const OWNERS = ['u0', 'u1', 'u2', 'bot', 'U0'];

const rows = (dialect: Dialect): fc.Arbitrary<Row[]> =>
  fc
    .array(
      fc.record({
        name: nullable(pick(NAMES)),
        status: nullable(pick(STATUSES)),
        code: nullable(pick(CODES)),
        owner: nullable(pick(OWNERS)),
        n: nullable(pick([0, 1, 2, 10, -1])),
        r: nullable(pick([0.5, 1, 1.5, -2])),
        // SQLite keeps any integer in a BOOLEAN column; the converter reads only 1 as true.
        flag: nullable(dialect === 'sqlite' ? pick<unknown>([0, 1, 2, 2, true, false]) : fc.boolean()),
        project_id: nullable(pick(['p1', 'p2'])),
        org_id: nullable(pick([1, 2])),
      }),
      { minLength: 3, maxLength: 7 },
    )
    .map((rs) => rs.map((r, i) => ({ id: `r${i}`, ...r })));

const FIELDS = ['name', 'status', 'code', 'owner', 'n', 'r', 'flag', 'nope'];
// Votes of one leaf over the typed columns, which decide rows far more often than deep votes do.
const LEAF_FIELDS = ['flag', 'code', 'n', 'name'];
const VALUES: readonly (string | number)[] = ['a', 'b', 'A', '', 'a/b', '1', '01', '10', '1.0', '-1', 'open', 'u0', 'x', 0, 1, 2, 10, -1, 1.5];
const REFS = ['principal.id', 'principal.attributes.pool', 'principal.attributes.level'];

const LEVEL = 'principal.attributes.level';
const isRef = (v: unknown, ref: string): boolean => v !== null && typeof v === 'object' && (v as { ref?: unknown }).ref === ref;

/**
 * A string column compared with a number is exact in SQL only where the cell equals the number's
 * text (conventions §5: "sound only"), and `name` holds canonical number strings: on `name` a number
 * becomes its text. On `code` ('1' or no number) a number becomes 1, where the pair is exact: TRUE
 * or FALSE on '1', UNKNOWN elsewhere, in both. On both the ref that binds to a number (`level`)
 * becomes one that binds to a string (`pool`). Everything else stays as the kit's arbitrary drew it.
 */
function exactOnly(f: ResourceFilter): ResourceFilter {
  switch (f.op) {
    case 'and':
    case 'or':
      return { ...f, args: f.args.map(exactOnly) };
    case 'not':
      return { ...f, arg: exactOnly(f.arg) };
    case 'cmp': {
      if ((f.field !== 'name' && f.field !== 'code') || f.value === undefined) return f;
      const exact = (v: unknown): unknown => (typeof v === 'number' ? (f.field === 'name' ? String(v) : 1) : isRef(v, LEVEL) ? { ref: 'principal.attributes.pool' } : v);
      return { ...f, value: (Array.isArray(f.value) ? f.value.map(exact) : exact(f.value)) as Value };
    }
    default:
      return f;
  }
}

const scripted =
  (map: (f: ResourceFilter) => ResourceFilter) =>
  (v: Vote): ScriptedVote => ({
    permitWhen: map(v.permitWhen),
    denyWhen: map(v.denyWhen),
    cacheable: v.cacheable,
    ...(v.denies ? { denies: v.denies.map((d) => ({ ...d, when: map(d.when) })) } : {}),
    ...(v.error !== undefined ? { error: v.error } : {}),
    ...(v.reason ? { reason: v.reason } : {}),
  });

const LEAF_VALUES: readonly (string | number)[] = ['1', 'x', 0, 1, 2];
const LEAF_COMPARATORS = ['eq', 'ne', 'in', 'nin', 'lt', 'gte', 'null', 'notnull'] as const;

const vote = (model: string): fc.Arbitrary<Vote> =>
  fc.oneof(
    { weight: 1, arbitrary: arb.vote({ model, fields: FIELDS, values: VALUES, relations: ['owner'], scopes: SCOPES, refs: REFS, depth: 3 }) },
    // A permit of one leaf, with nothing to deny it.
    { weight: 2, arbitrary: arb.vote({ model, fields: LEAF_FIELDS, values: LEAF_VALUES, comparators: LEAF_COMPARATORS, relations: [], scopes: [], refs: [], depth: 1, errors: false }).map((v): Vote => ({ model, permitWhen: v.permitWhen, denyWhen: { op: 'false' }, cacheable: v.cacheable })) },
  );
const votes = (model: string, map: (f: ResourceFilter) => ResourceFilter = exactOnly) => fc.record({ [READ]: vote(model).map(scripted(map)), [WRITE]: vote(model).map(scripted(map)) });

const permissionsConfig = (names: readonly string[], type: string) => Object.fromEntries(names.map((p) => [p, { types: [type] }]));

describe('authz-orm B06: check ⇔ filter through the host and the query middleware (property)', function () {
  this.timeout(1200000);
  let db: TestDb;
  let pg = false;
  let release: () => void;

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
    await (await testHost.domains()).service('root');
    release = useTupleCompiler();
  });

  after(async () => {
    release?.();
    await db?.close();
  });

  /** Runs the property; each run boots a fresh domain over the loaded rows and checks every principal, permission and row. */
  async function property<W>(label: string, world: fc.Arbitrary<W>, seed: number, run: (w: W) => Promise<Agreement>): Promise<Agreement> {
    const total = emptyAgreement();
    await fc.assert(
      fc.asyncProperty(world, async (w) => {
        const a = await run(w);
        for (const k of Object.keys(total) as (keyof Agreement)[]) total[k] += a[k];
      }),
      { seed, numRuns: RUNS },
    );
    // The counts show the runs were not trivial (the report quotes them).
    console.log(`      B06 ${label}: ${RUNS} runs, ${total.checks} row checks, ${total.allowed} allowed, ${total.refused} selects refused, ${total.narrower} allowed rows the selects leave out (sound only, ⊆), intersect checks asserted ⇔: ${total.intersectExact} with nothing stripped, ${total.intersectStripped} with the delegate's relation or native ops stripped, ${total.intersectKept} with a native op kept, ${total.intersectAllowed} intersect rows allowed`);
    expect(total.allowed, 'rows allowed').to.be.greaterThan(RUNS);
    expect(total.checks - total.allowed, 'rows denied').to.be.greaterThan(RUNS);
    return total;
  }

  for (const dialect of ['sqlite', 'postgres'] as const) {
    describe(dialect, () => {
      let tables: OrmTables;

      before(async function () {
        if (dialect === 'postgres' && !pg) return this.skip();
        tables = await OrmTables.define(db, SPEC, dialect);
      });

      after(async () => {
        await db.clear();
      });

      it(`FakeRbacModel, alone or with a StaticModel: scoped and relation grants, inherit and intersect agents (seed ${SEED}, ${RUNS} runs)`, async () => {
        const grant: fc.Arbitrary<FakeGrant> = fc.oneof(arb.permissionGlob({ pool: [READ, WRITE] }), fc.record({ permission: pick([READ, WRITE, `${TYPE}:*`]), relation: fc.constant('owner') }));
        // The fake model reads assignments at concrete scopes only: a type-level one would match in the residual and never in a check.
        const assignment = arb.assignment({ subjects: pick(SUBJECTS), roles: ['viewer', 'editor', 'owner'], scopes: NODES, sets: false }).map((a) => ({ subject: a.subject as { type: string; id: string }, role: a.role, scope: a.scope }));
        const world = fc.record({
          rows: rows(dialect),
          roles: fc.record({ viewer: fc.array(grant, { maxLength: 2 }), editor: fc.array(grant, { maxLength: 2 }), owner: fc.array(grant, { maxLength: 2 }) }),
          assignments: fc.array(assignment, { maxLength: 6 }),
          extra: fc.option(fc.tuple(votes('m2'), pick(fixtureDsl.ALGORITHMS)), { nil: undefined }),
        });
        const total = await property(`${dialect} FakeRbacModel`, world, SEED, async (w) => {
          await tables.load(w.rows);
          const models = [new FakeRbacModel({ roles: w.roles, assignments: w.assignments }), ...(w.extra ? [new StaticModel({ name: 'm2', votes: w.extra[0] })] : [])];
          const { service, dispose } = await bootDomain(models, { permissions: permissionsConfig([READ, WRITE], TYPE), combine: w.extra ? fixtureDsl.combine(w.extra[1], 'rbac', 'm2') : fixtureDsl.combine('deny-overrides', 'rbac') });
          try {
            return await agree(service, tables, PRINCIPALS);
          } finally {
            await dispose();
          }
        });
        // The relation grants reach bot2's delegate, so the stripped case is asserted ⇔ too.
        expect(total.intersectStripped, 'stripped intersect checks').to.be.greaterThan(0);
      });

      it(`StaticModel ABAC-like votes (cmp, in/nin, patterns, null, under, owner, principal refs, denies, errors) under every algorithm (seed ${SEED + 1}, ${RUNS} runs)`, async () => {
        const world = fc.record({ rows: rows(dialect), m1: votes('m1'), m2: votes('m2'), algorithm: pick(fixtureDsl.ALGORITHMS) });
        await property(`${dialect} StaticModel`, world, SEED + 1, async (w) => {
          await tables.load(w.rows);
          const models = [new StaticModel({ name: 'm1', votes: w.m1 }), new StaticModel({ name: 'm2', votes: w.m2 })];
          const { service, dispose } = await bootDomain(models, { permissions: permissionsConfig([READ, WRITE], TYPE), combine: fixtureDsl.combine(w.algorithm, 'm1', 'm2') });
          try {
            return await agree(service, tables, PRINCIPALS);
          } finally {
            await dispose();
          }
        });
      });

      it(`StaticModel raw votes, sound-only leaves included: the selects equal each other and hold only allowed rows (seed ${SEED + 3}, ${RUNS} runs)`, async () => {
        const world = fc.record({ rows: rows(dialect), m1: votes('m1', (f) => f), m2: votes('m2', (f) => f), algorithm: pick(fixtureDsl.ALGORITHMS) });
        await property(`${dialect} StaticModel raw`, world, SEED + 3, async (w) => {
          await tables.load(w.rows);
          const models = [new StaticModel({ name: 'm1', votes: w.m1 }), new StaticModel({ name: 'm2', votes: w.m2 })];
          const { service, dispose } = await bootDomain(models, { permissions: permissionsConfig([READ, WRITE], TYPE), combine: fixtureDsl.combine(w.algorithm, 'm1', 'm2') });
          try {
            return await agree(service, tables, PRINCIPALS, { sound: true });
          } finally {
            await dispose();
          }
        });
      });

      describe('FakeTupleModel', () => {
        let docs: OrmTables;
        let tuplesTable: TupleTables;

        before(async function () {
          if (dialect === 'postgres' && !pg) return this.skip();
          docs = await OrmTables.define(db, { type: 'doc', permissions: ['doc:read', 'doc:edit'], columns: { title: 'text' } }, dialect);
          tuplesTable = await TupleTables.define(db, dialect);
        });

        it(`native:fake.tuple compiled to a correlated recursive EXISTS over the world's tuples, inherit and intersect agents (seed ${SEED + 2}, ${RUNS} runs)`, async () => {
          const users = ['u0', 'u1', 'u2', 'u3'];
          const principals = [...users.map((u) => userPrincipal(u)), agentPrincipal('bot', userPrincipal('u1'), { delegation: 'inherit' }), agentPrincipal('bot2', userPrincipal('u2'), { delegation: 'intersect' })];
          const relations: Record<string, string> = { 'doc:read': 'view', 'doc:edit': 'edit' };
          const permissions = Object.keys(relations);
          const bot2Ref: PrincipalRef = { type: 'agent', id: 'bot2' };
          const bot2 = principals[principals.length - 1];
          let refusedByDelegate = 0;
          let allowedByBoth = 0;
          const total = await property(`${dialect} FakeTupleModel`, arb.tupleGraph({ users }), SEED + 2, async (g) => {
            // bot2 owns u3's direct tuples and every other one of u0's.
            const own: Tuple[] = [];
            let k = 0;
            for (const t of g.tuples) {
              const s = t.subject as PrincipalRef;
              if ('object' in t.subject || s.type !== 'user') continue;
              if (s.id === 'u3' || (s.id === 'u0' && k++ % 2 === 0)) own.push({ ...t, subject: bot2Ref });
            }
            const tuples = [...g.tuples, ...own];
            await docs.load(g.rows.doc.map((r) => ({ ...r, title: r.id })));
            await tuplesTable.load(tuples, g.schema);
            const store = new FakeTupleStore();
            await store.write(tuples, [], SYSTEM);
            const model = new FakeTupleModel({ store, schema: g.schema, permissions: Object.fromEntries(permissions.map((p) => [p, `doc#${relations[p]}`])) });
            const { service, dispose } = await bootDomain([model], { permissions: permissionsConfig(permissions, 'doc'), combine: fixtureDsl.combine('deny-overrides', 'rebac') });
            try {
              const agreement = await agree(service, docs, principals, { keep: new Set(model.nativeFilter.principalInArgs === true ? [model.nativeFilter.op] : []) });
              // bot2 is allowed exactly the rows both it and its delegate u2 hold.
              for (const permission of permissions) {
                for (const r of g.rows.doc) {
                  const ref = { type: 'doc', id: r.id };
                  const own = await model.holds(ref, relations[permission], bot2Ref);
                  const delegate = await model.holds(ref, relations[permission], { type: 'user', id: 'u2' });
                  const d = await runWithPrincipal(bot2, () => service.check({ principal: bot2, permission, resource: ref, subject: { ...r, title: r.id } }));
                  if (d.allowed !== (own && delegate)) throw new Error(`bot2 ${permission} ${r.id}: allowed ${d.allowed}, bot2 holds ${own}, u2 holds ${delegate}`);
                  if (d.allowed) allowedByBoth++;
                  else if (own && !delegate) refusedByDelegate++;
                }
              }
              return agreement;
            } finally {
              await dispose();
            }
          });
          expect(total.intersectKept, 'kept intersect checks').to.be.greaterThan(0);
          expect(total.intersectAllowed, 'allowed intersect checks').to.be.greaterThan(0);
          console.log(`      B06 ${dialect} FakeTupleModel: bot2 refused ${refusedByDelegate} doc rows it holds and u2 does not, allowed ${allowedByBoth} rows both hold`);
          expect(refusedByDelegate, 'rows bot2 holds, u2 does not and the check refuses').to.be.greaterThan(0);
          expect(allowedByBoth, 'rows bot2 and u2 hold and the check allows').to.equal(total.intersectAllowed);
        });
      });
    });
  }
});
