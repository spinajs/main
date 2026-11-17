import { DefaultConditionCompiler, TRUE } from '@spinajs/authz';
import type { PermissionDef } from '@spinajs/authz';
import { planFilter } from '@spinajs/authz-orm';
import type { PlanTermCompiler } from '@spinajs/authz-orm';
import { fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import { Wrapper } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';
import * as chai from 'chai';
import fc from 'fast-check';
import 'mocha';

import { AUTHZ_REBAC_TUPLE_TABLE, DbTupleStore, NamespaceSchema, RebacModel, RebacTuplesTerm } from '../../src/index.js';
import type { CaveatConfig, NamespaceConfig, Tuple, TupleCaveat, TupleSubject } from '../../src/index.js';
import { bootDb, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';
import { ref, set, tuple, user } from '../support/world.js';

const expect = chai.expect;

const DOCS = 'list_caveat_doc';
const DOC_IDS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
const USERS = ['u1', 'u2', 'u3'];
const CAVEATS: CaveatConfig = {
  c_ip: { params: { 'env.ip': 'string' }, expr: { attr: 'env.ip', eq: 'a' } },
  c_lvl: { params: { 'env.lvl': 'int', 'env.min': 'int' }, expr: { attr: 'env.lvl', gte: { ref: 'env.min' } } },
  // A tuple context naming principal.id must not change who is asking.
  c_who: { params: { 'principal.id': 'string' }, expr: { attr: 'principal.id', eq: 'u1' } },
};
/** Each env decides some caveats and leaves others unknown. */
const ENVS = [{}, { ip: 'a' }, { ip: 'b' }, { lvl: 1 }, { lvl: 3, ip: 'a' }];
const NAMESPACES: NamespaceConfig = {
  user: {},
  group: { relations: { member: ['user', 'user with c_ip', 'user with c_who', 'group#member with c_lvl'] } },
  folder: { relations: { viewer: ['user', 'group#member', 'user with c_lvl'] }, permissions: { view: 'viewer' } },
  doc: {
    relations: { owner: ['user'], viewer: ['user', 'user with c_ip', 'user with c_who', 'group#member', 'group#member with c_lvl'], parent: ['folder', 'folder with c_ip'] },
    permissions: { read: { union: ['owner', 'viewer', 'parent->view'] }, shared: { intersection: ['viewer', 'parent->view'] } },
  },
};
const INPUTS = [
  { name: 'doc:read', types: ['doc'], list: true },
  { name: 'doc:shared', types: ['doc'], list: true },
];
const PERMISSIONS = { 'doc:read': 'doc#read', 'doc:shared': 'doc#shared' };
const SCHEMA = NamespaceSchema.compile(NAMESPACES, PERMISSIONS, CAVEATS);

const caveat: fc.Arbitrary<TupleCaveat | undefined> = fc.option(
  fc.oneof(
    fc.constant({ name: 'c_ip' }),
    fc.integer({ min: 0, max: 3 }).map((min) => ({ name: 'c_lvl', context: { 'env.min': min } })),
    fc.constantFrom({ name: 'c_who' }, { name: 'c_who', context: { 'principal.id': 'u2' } }),
  ),
  { nil: undefined },
);
const people = fc.oneof(
  fc.constantFrom(...USERS).map((id): TupleSubject => user(id)),
  fc.constantFrom('g1', 'g2').map((id) => set('group', id, 'member')),
);
const bare: fc.Arbitrary<Tuple> = fc.oneof(
  fc.record({ d: fc.constantFrom(...DOC_IDS), s: fc.constantFrom(...USERS) }).map(({ d, s }) => tuple(ref('doc', d), 'owner', user(s))),
  fc.record({ d: fc.constantFrom(...DOC_IDS), s: people }).map(({ d, s }) => tuple(ref('doc', d), 'viewer', s)),
  fc.record({ d: fc.constantFrom(...DOC_IDS), f: fc.constantFrom('f1', 'f2') }).map(({ d, f }) => tuple(ref('doc', d), 'parent', { type: 'folder', id: f })),
  fc.record({ f: fc.constantFrom('f1', 'f2'), s: people }).map(({ f, s }) => tuple(ref('folder', f), 'viewer', s)),
  fc.record({ g: fc.constantFrom('g1', 'g2'), s: people }).map(({ g, s }) => tuple(ref('group', g), 'member', s)),
);
// Only what the namespaces admit is stored, so most caveats land where a relation takes them.
const tuples = fc
  .uniqueArray(fc.tuple(bare, caveat), { maxLength: 14, selector: ([t]) => JSON.stringify(t) })
  .map((list) => list.map(([t, c]): Tuple => (c ? { ...t, caveat: c } : t)).filter((t) => SCHEMA.problem(t) === undefined));

for (const engine of ['sqlite', 'postgres'] as const) {
  /** Task 9: `.accessible()` SQL over conditional tuples returns exactly the rows the check permits for that env. */
  describe(`authz-rebac: list plans agree with checks over conditional tuples (${engine})`, function () {
    this.timeout(600_000);
    let db: TestDb;
    let model: RebacModel;
    const compilers = new Map<string, PlanTermCompiler>([['rebac.tuples', new RebacTuplesTerm()]]);
    const ctx = () => fakeEvaluationContext({ permissions: INPUTS, conditions: new DefaultConditionCompiler() });

    before(async function () {
      db = await bootDb('lists_caveats', engine === 'postgres' ? this : undefined);
      model = new RebacModel({ store: new DbTupleStore(), namespaces: NAMESPACES, permissions: PERMISSIONS, caveats: CAVEATS, limit: { maxDepth: 4, maxCalls: 10_000 } });
      await model.init(fakeModelInitContext({ permissions: INPUTS, model: model.name }));
      await db.driver.schema().createTable(DOCS, (t) => {
        t.string('id', 64).primaryKey();
      });
      await db.driver
        .insert()
        .into(DOCS)
        .values(DOC_IDS.map((id) => ({ id })));
    });

    after(async () => {
      await db?.dispose();
    });

    async function accessible(who: string, permission: string, env: Readonly<Record<string, unknown>>): Promise<string[]> {
      const plan = await model.listPlan({ principal: userPrincipal(who), permission: { name: permission } as PermissionDef, type: 'doc', env }, ctx());
      if (plan.kind !== 'terms') return [];
      const filter = planFilter({ kind: 'filter', permit: plan.permit, deny: plan.deny }, { type: 'doc', id: Wrapper.Text('id'), relation: () => undefined, ancestorTable: 'authz_resource_ancestor', now: () => db.driver.now(), from: (table, alias) => db.driver.select<unknown>().from(table, alias) }, compilers);
      if (filter.kind !== 'where') return filter.kind === 'all' ? [...DOC_IDS] : [];
      const rows = await db.driver
        .select()
        .select('id')
        .from(DOCS)
        .where(function (this: IWhereBuilder<unknown>) {
          filter.apply(this);
        })
        .asRaw<{ id: unknown }[]>();
      return rows.map((r) => String(r.id)).sort();
    }

    async function permitted(who: string, permission: string, env: Readonly<Record<string, unknown>>): Promise<string[]> {
      const out: string[] = [];
      for (const id of DOC_IDS) if ((await model.evaluate({ principal: userPrincipal(who), permission, resource: ref('doc', id), env }, ctx())).permitWhen === TRUE) out.push(id);
      return out;
    }

    it('returns the rows the check permits, on random conditional tuples and envs', async () => {
      await fc.assert(
        fc.asyncProperty(tuples, fc.constantFrom(...ENVS), async (world, env) => {
          await rawQuery(db.driver, `DELETE FROM ${AUTHZ_REBAC_TUPLE_TABLE}`);
          await new DbTupleStore().write(world, [], user('admin'));
          model.invalidate(['rebac']);
          for (const permission of Object.keys(PERMISSIONS)) {
            for (const who of USERS) expect(await accessible(who, permission, env), `${who} ${permission} ${JSON.stringify(env)}`).to.deep.equal(await permitted(who, permission, env));
          }
        }),
        { numRuns: Number(process.env.LIST_CAVEATS_RUNS ?? 100) },
      );
    });
  });
}
