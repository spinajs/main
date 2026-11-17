import { DefaultConditionCompiler } from '@spinajs/authz';
import type { PermissionDef, Principal } from '@spinajs/authz';
import { generateRls, planFilter } from '@spinajs/authz-orm';
import type { PlanTermCompiler } from '@spinajs/authz-orm';
import { fakeEvaluationContext, fakeModelInitContext, rlsConformance, userPrincipal } from '@spinajs/authz-testing';
import { Wrapper } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';
import fc from 'fast-check';
import 'mocha';

import { AUTHZ_REBAC_TUPLE_TABLE, DbTupleStore, RebacModel, RebacRlsPlanSource, RebacRlsSubjectKeys, RebacRlsTerm, RebacTuplesTerm } from '../../src/index.js';
import type { NamespaceConfig, Tuple, TupleSubject } from '../../src/index.js';
import { bootDb, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';
import { ref, set, tuple, user } from '../support/world.js';

const DOCS = 'rls_conf_doc';
const CDOCS = 'rls_conf_cdoc';
const BENCH = 'rls_bench_doc';
const ROLE = `spina_rls_rebac_${process.pid}`;

const NAMESPACES: NamespaceConfig = {
  user: {},
  group: { relations: { member: ['user', 'group#member'] } },
  folder: { relations: { parent: ['folder'], viewer: ['user', 'group#member'] }, permissions: { view: { union: ['viewer', 'parent->view'] } } },
  doc: { relations: { parent: ['folder'], owner: ['user'], viewer: ['user', 'group#member'] }, permissions: { read: { union: ['owner', 'viewer', 'parent->view'] } } },
};
const PERMISSIONS = { 'doc:read': 'doc#read' };
/** doc#viewer also admits `user with c_ip`: RLS cannot evaluate it, so `rls: 'partial'` widens doc:read. */
const CONDITIONAL: NamespaceConfig = { ...NAMESPACES, doc: { ...NAMESPACES.doc, relations: { ...NAMESPACES.doc.relations, viewer: ['user', 'group#member', 'user with c_ip'] } } };
const CAVEATS = { c_ip: { params: { 'env.ip': 'string' }, expr: { attr: 'env.ip', eq: 'a' } } } as const;
const PERMISSION_INPUTS = [{ name: 'doc:read', types: ['doc'], list: true }];
const DOC_IDS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
const USERS = ['u1', 'u2', 'u3'];

const people = fc.oneof(
  fc.constantFrom(...USERS).map((id): TupleSubject => user(id)),
  fc.constantFrom('g1', 'g2').map((id) => set('group', id, 'member')),
);
// Folders only point up (f1 -> f2 -> f3), so parent chains end; groups may name each other in a cycle.
const tupleArb: fc.Arbitrary<Tuple> = fc.oneof(
  fc.record({ d: fc.constantFrom(...DOC_IDS), s: fc.constantFrom(...USERS) }).map(({ d, s }) => tuple(ref('doc', d), 'owner', user(s))),
  fc.record({ d: fc.constantFrom(...DOC_IDS), s: people }).map(({ d, s }) => tuple(ref('doc', d), 'viewer', s)),
  fc.record({ d: fc.constantFrom(...DOC_IDS), f: fc.constantFrom('f1', 'f2', 'f3') }).map(({ d, f }) => tuple(ref('doc', d), 'parent', { type: 'folder', id: f })),
  fc.constantFrom(['f1', 'f2'], ['f1', 'f3'], ['f2', 'f3']).map(([a, b]) => tuple(ref('folder', a), 'parent', { type: 'folder', id: b })),
  fc.record({ f: fc.constantFrom('f1', 'f2', 'f3'), s: people }).map(({ f, s }) => tuple(ref('folder', f), 'viewer', s)),
  fc.record({ g: fc.constantFrom('g1', 'g2'), s: people }).map(({ g, s }) => tuple(ref('group', g), 'member', s)),
);
const conditionalArb: fc.Arbitrary<Tuple> = fc.oneof(tupleArb, fc.record({ d: fc.constantFrom(...DOC_IDS), s: fc.constantFrom(...USERS) }).map(({ d, s }) => ({ ...tuple(ref('doc', d), 'viewer', user(s)), caveat: { name: 'c_ip' } })));

/**
 * R3 for ReBAC on Postgres: the generated `doc#read` policy, under a role RLS applies to and the session keys of
 * RebacRlsSubjectKeys, returns the rows of the ReBAC list plan `.accessible('doc:read')` runs, on random tuples.
 */
describe('RLS conformance: ReBAC (postgres)', function () {
  this.timeout(600_000);
  let db: TestDb;
  let model: RebacModel;
  let conditional: RebacModel;
  const compilers = new Map<string, PlanTermCompiler>([
    ['rebac.tuples', new RebacTuplesTerm()],
    ['rebac.rls', new RebacRlsTerm()],
  ]);

  before(async function () {
    db = await bootDb('rls_conformance', this);
    // maxDepth 4 keeps a world's three policy reads near a second; the RLS_BENCH case measures the default 8.
    model = new RebacModel({ store: new DbTupleStore(), namespaces: NAMESPACES, permissions: PERMISSIONS, limit: { maxDepth: Number(process.env.RLS_MAX_DEPTH ?? 4), maxCalls: 10_000 } });
    await model.init(fakeModelInitContext({ permissions: PERMISSION_INPUTS, model: model.name }));
    conditional = new RebacModel({ store: new DbTupleStore(), namespaces: CONDITIONAL, permissions: PERMISSIONS, caveats: CAVEATS, limit: { maxDepth: 4, maxCalls: 10_000 } });
    await conditional.init(fakeModelInitContext({ permissions: PERMISSION_INPUTS, model: conditional.name }));
    for (const table of [DOCS, BENCH, CDOCS]) {
      await db.driver.schema().createTable(table, (t) => {
        t.string('id', 64).primaryKey();
      });
    }
    await db.driver
      .insert()
      .into(DOCS)
      .values(DOC_IDS.map((id) => ({ id })));
    await db.driver
      .insert()
      .into(CDOCS)
      .values(DOC_IDS.map((id) => ({ id })));
    const registry = { get: (name: string) => (name === 'doc:read' ? ({ name, resource: 'doc', action: 'read', types: ['doc'], list: true, source: 'test' } as PermissionDef) : undefined) };
    for (const table of [DOCS, BENCH, CDOCS]) {
      const resource = { type: 'doc', table, idColumn: 'id', relations: () => undefined, ancestorTable: 'authz_resource_ancestor', mode: table === CDOCS ? ('partial' as const) : (true as const) };
      const out = await generateRls({ models: [table === CDOCS ? conditional : model], permissions: registry, resources: [resource], sources: new Map([['rebac', new RebacRlsPlanSource()]]), compilers });
      // doc:update and doc:delete are not in this fixture: their policies match no row.
      const read = out.diagnostics.filter((d) => d.permission === 'doc:read').map((d) => d.code);
      if (read.join() !== (table === CDOCS ? 'AUTHZ021' : '')) throw new Error(JSON.stringify(out.diagnostics));
      for (const sql of out.up) await rawQuery(db.driver, sql);
    }
    await rawQuery(db.driver, `DROP ROLE IF EXISTS "${ROLE}"`);
    await rawQuery(db.driver, `CREATE ROLE "${ROLE}" NOLOGIN`);
    await rawQuery(db.driver, `GRANT USAGE ON SCHEMA public TO "${ROLE}"`);
    await rawQuery(db.driver, `GRANT SELECT ON "${DOCS}", "${BENCH}", "${CDOCS}", "${AUTHZ_REBAC_TUPLE_TABLE}" TO "${ROLE}"`);
  });

  after(async () => {
    if (!db) return;
    await rawQuery(db.driver, `DROP OWNED BY "${ROLE}"`).catch(() => undefined);
    await rawQuery(db.driver, `DROP ROLE IF EXISTS "${ROLE}"`).catch(() => undefined);
    await db.dispose();
  });

  async function load(tuples: readonly Tuple[]): Promise<void> {
    await rawQuery(db.driver, `DELETE FROM "${AUTHZ_REBAC_TUPLE_TABLE}"`);
    await new DbTupleStore().write(tuples, [], user('admin'));
    model.invalidate(['rebac']);
    conditional.invalidate(['rebac']);
  }

  const ids = (rows: { id: unknown }[]): string[] => rows.map((r) => String(r.id)).sort();

  async function accessible(principal: Principal, m: RebacModel = model, table = DOCS): Promise<readonly string[]> {
    const ctx = fakeEvaluationContext({ permissions: PERMISSION_INPUTS, conditions: new DefaultConditionCompiler() });
    const plan = await m.listPlan({ principal, permission: { name: 'doc:read' } as PermissionDef, type: 'doc', env: { ip: 'a' } }, ctx);
    if (plan.kind !== 'terms') return [];
    const filter = planFilter({ kind: 'filter', permit: plan.permit, deny: plan.deny }, { type: 'doc', id: Wrapper.Text('id'), relation: () => undefined, ancestorTable: 'authz_resource_ancestor', now: () => db.driver.now(), from: (table, alias) => db.driver.select<unknown>().from(table, alias) }, compilers);
    if (filter.kind !== 'where') return filter.kind === 'all' ? [...DOC_IDS] : [];
    const rows = await db.driver
      .select()
      .select('id')
      .from(table)
      .where(function (this: IWhereBuilder<unknown>) {
        filter.apply(this);
      })
      .asRaw<{ id: unknown }[]>();
    return ids(rows);
  }

  async function asRole<T>(principal: Principal, sql: string, m: RebacModel = model): Promise<T> {
    const keys = await new RebacRlsSubjectKeys().keys(m, principal);
    return db.driver.transaction(async () => {
      await rawQuery(db.driver, `SET LOCAL ROLE "${ROLE}"`);
      await rawQuery(db.driver, "SELECT set_config('spina.subject_keys', ?, true)", [JSON.stringify(keys)]);
      return (await rawQuery(db.driver, sql)) as T;
    });
  }

  const rls = async (principal: Principal, m: RebacModel = model, table = DOCS): Promise<readonly string[]> => ids(await asRole<{ id: unknown }[]>(principal, `SELECT id FROM "${table}"`, m));

  it('shows each principal the rows .accessible() lists, on random tuples', async () => {
    await rlsConformance<readonly Tuple[]>({
      world: fc.uniqueArray(tupleArb, { maxLength: 14, selector: (t) => JSON.stringify(t) }),
      load,
      comparisons: () => USERS.map((id) => ({ principal: userPrincipal(id), permission: 'doc:read' })),
      accessible: (p) => accessible(p),
      rls: (p) => rls(p),
      numRuns: Number(process.env.RLS_CONFORMANCE_RUNS ?? 30),
    });
  });

  it("widens a permission that reaches a conditional relation to TRUE under rls: 'partial', a superset of .accessible()", async () => {
    await rlsConformance<readonly Tuple[]>({
      world: fc.uniqueArray(conditionalArb, { maxLength: 14, selector: (t) => JSON.stringify([t.object, t.relation, t.subject]) }),
      load,
      comparisons: () => USERS.map((id) => ({ principal: userPrincipal(id), permission: 'doc:read' })),
      accessible: (p) => accessible(p, conditional, CDOCS),
      rls: (p) => rls(p, conditional, CDOCS),
      expectation: () => 'superset',
      numRuns: Number(process.env.RLS_CONFORMANCE_RUNS ?? 30),
    });
  });

  // RLS_BENCH=1: 5000 docs in a binary tree of 300 folders (depth 8), 50 users in 20 nested groups; prints the cost.
  it('measures the doc#read policy on realistic data (RLS_BENCH=1)', async function () {
    if (process.env.RLS_BENCH !== '1') return this.skip();
    await rawQuery(db.driver, `DELETE FROM "${AUTHZ_REBAC_TUPLE_TABLE}"`);
    await rawQuery(db.driver, `INSERT INTO "${BENCH}" SELECT 'b' || g FROM generate_series(1, 5000) g ON CONFLICT DO NOTHING`);
    const row = (ns: string, id: string, rel: string, st: string, sid: string, srel: string) =>
      `SELECT md5(${ns} || ${id} || ${rel} || ${st} || ${sid} || ${srel}), ${ns}, ${id}, ${rel}, ${st} || ':' || ${sid} || CASE WHEN ${srel} = '' THEN '' ELSE '#' || ${srel} END, ${st}, ${sid}, ${srel}, now()`;
    const insert = (select: string) => rawQuery(db.driver, `INSERT INTO "${AUTHZ_REBAC_TUPLE_TABLE}" (tuple_key, namespace, object_id, relation, subject_key, subject_type, subject_id, subject_relation, created_at) ${select} ON CONFLICT DO NOTHING`);
    await insert(`${row("'doc'", "'b' || g", "'parent'", "'folder'", "'f' || (g % 300)", "''")} FROM generate_series(1, 5000) g`);
    await insert(`${row("'folder'", "'f' || g", "'parent'", "'folder'", "'f' || (g / 2)", "''")} FROM generate_series(1, 299) g`);
    await insert(`${row("'folder'", "'f' || (k * 37 % 300)", "'viewer'", "'group'", "'g' || k", "'member'")} FROM generate_series(0, 19) k`);
    await insert(`${row("'group'", "'g' || (j % 20)", "'member'", "'user'", "'u' || j", "''")} FROM generate_series(0, 49) j`);
    await insert(`${row("'group'", "'g' || (k + 1)", "'member'", "'group'", "'g' || k", "'member'")} FROM generate_series(0, 18) k`);
    const who = userPrincipal('u7');
    let t = Date.now();
    const visible = await asRole<{ n: unknown }[]>(who, `SELECT count(*) AS n FROM "${BENCH}"`);
    const rlsMs = Date.now() - t;
    const plan = await asRole<{ 'QUERY PLAN': string }[]>(who, `EXPLAIN (ANALYZE, SUMMARY) SELECT count(*) FROM "${BENCH}"`);
    t = Date.now();
    const keys = await new RebacRlsSubjectKeys().keys(model, who);
    const keysMs = Date.now() - t;
    console.log(`      rebac.rls doc#read, maxDepth ${model.limit().maxDepth}: ${String(visible[0].n)} of 5000 rows, ${rlsMs} ms; ${plan.slice(-2).map((r) => r['QUERY PLAN']).join('; ')}; ${keys.length} session keys in ${keysMs} ms`);
  });
});

