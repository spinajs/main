import { AuthzConfigError } from '@spinajs/authz';
import type { AuthorizationModel, PermissionDef } from '@spinajs/authz';
import { generateRls } from '@spinajs/authz-orm';
import type { PlanRow, RlsSqlContext } from '@spinajs/authz-orm/plan';
import { fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import { Wrapper } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';

import { DbTupleStore, MemoryTupleStore, RebacModel, RebacRlsPlanSource, RebacRlsSubjectKeys, RebacRlsTerm, RebacTuplesTerm, parseRebacRlsExpr, rebacRlsExpr } from '../../src/index.js';
import type { NamespaceConfig, RebacRlsExpr } from '../../src/index.js';
import { caveatModel } from '../support/caveat-world.js';
import { bootDb, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';
import { TUPLES, ref, setup, tuple, user } from '../support/world.js';
import type { Setup } from '../support/world.js';

const expect = chai.expect;

const DOCS = 'rls_doc';
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const def = (name: string) => ({ name }) as PermissionDef;
const d4 = ref('doc', 'd4');

/** One permission per route to a conditional relation, and `p_plain`, which reaches none. */
const ROUTES: NamespaceConfig = {
  user: {},
  group: { relations: { member: ['user', 'user with c_ip'] } },
  folder: { relations: { viewer: ['user'], cviewer: ['user with c_ip'] }, permissions: { view: 'viewer', cview: 'cviewer' } },
  doc: {
    relations: { plain: ['user'], direct: ['user with c_ip'], team: ['group#member'], parent: ['folder'], cparent: ['folder with c_ip'] },
    permissions: {
      p_plain: { union: ['plain', 'parent->view'] },
      p_direct: 'direct',
      p_set: 'team',
      p_arrow: 'parent->cview',
      p_tupleset: 'cparent->view',
      p_union: { union: ['plain', 'direct'] },
      p_inter: { intersection: ['plain', 'team'] },
      p_excl: { exclusion: { base: 'plain', subtract: 'direct' } },
    },
  },
};
const ROUTE_PERMISSIONS = ['p_plain', 'p_direct', 'p_set', 'p_arrow', 'p_tupleset', 'p_union', 'p_inter', 'p_excl'];

async function routesModel(): Promise<RebacModel> {
  const tuples = [{ ...tuple(ref('group', 'g1'), 'member', user('u3')), caveat: { name: 'c_ip' } }, tuple(ref('group', 'g2'), 'member', user('u3'))];
  const permissions = Object.fromEntries(ROUTE_PERMISSIONS.map((p) => [`doc:${p}`, `doc#${p}`]));
  const model = new RebacModel({ store: new MemoryTupleStore(tuples), namespaces: ROUTES, permissions, caveats: { c_ip: { params: { 'env.ip': 'string' }, expr: { attr: 'env.ip', eq: 'a' } } } });
  await model.init(fakeModelInitContext({ permissions: ROUTE_PERMISSIONS.map((p) => ({ name: `doc:${p}`, types: ['doc'], list: true })), model: model.name }));
  return model;
}

/**
 * rebac.rls rendered against SQLite: `ctx.subjectKeys` is the only Postgres-specific part of the SQL, so a
 * SQLite list of the session keys stands in for it and the rest runs as the policy would.
 */
const ctxFor = (keys: readonly string[]): RlsSqlContext => ({
  type: 'doc',
  table: `"${DOCS}"`,
  id: `"${DOCS}"."id"`,
  relation: () => undefined,
  ancestorTable: 'authz_resource_ancestor',
  subjectKeys: `SELECT value FROM json_each(${lit(JSON.stringify(keys))})`,
  principals: '',
  now: 'CURRENT_TIMESTAMP',
  literal: lit,
  ident: (n) => `"${n}"`,
});

describe('authz-rebac: rebac.rls, the ReBAC list plan for any principal', function () {
  this.timeout(60_000);
  let db: TestDb;
  let world: Setup;

  before(async () => {
    db = await bootDb('rls');
    await db.driver.schema().createTable(DOCS, (table) => {
      table.string('id', 64).primaryKey();
    });
    await db.driver
      .insert()
      .into(DOCS)
      .values(['d1', 'd2', 'd3', 'd4'].map((id) => ({ id })));
    await new DbTupleStore().write(TUPLES, [], user('admin'));
    // SQLite's parser nests fewer sub-queries than the default maxDepth 8 unrolls to; three hops reach every fixture row.
    world = await setup({ limit: { maxDepth: 3, maxCalls: 10_000 } });
  });

  after(async () => {
    await db?.dispose();
  });

  async function rlsRows(who: string): Promise<string[]> {
    const keys = await new RebacRlsSubjectKeys().keys(world.model, userPrincipal(who));
    const plan = new RebacRlsPlanSource().plan(world.model, def('doc:read'), 'doc');
    if (plan.kind !== 'terms') throw new Error('expected terms');
    const sql = new RebacRlsTerm().renderSql(plan.permit[0].args, ctxFor(keys));
    const rows = (await rawQuery(db.driver, `SELECT id FROM "${DOCS}" WHERE ${sql}`)) as { id: unknown }[];
    return rows.map((r) => String(r.id)).sort();
  }

  async function listRows(who: string): Promise<string[]> {
    const plan = await world.model.listPlan({ principal: userPrincipal(who), permission: def('doc:read'), type: 'doc' }, world.context());
    if (plan.kind === 'abstain') return [];
    if (plan.kind !== 'terms') throw new Error(`unexpected ${plan.kind}`);
    const row: PlanRow = { type: 'doc', id: Wrapper.Text('id'), relation: () => undefined, ancestorTable: 'authz_resource_ancestor', now: () => db.driver.now(), from: (table, alias) => db.driver.select<unknown>().from(table, alias) };
    const rows = await db.driver
      .select()
      .select('id')
      .from(DOCS)
      .where(function (this: IWhereBuilder<unknown>) {
        new RebacTuplesTerm().apply(plan.permit[0].args, this, row);
      })
      .asRaw<{ id: unknown }[]>();
    return rows.map((r) => String(r.id)).sort();
  }

  it("gives each principal the rows its .accessible() list plan gives, the usersets read from the session's keys", async () => {
    for (const who of ['alice', 'bob', 'olga', 'carol', 'frank', 'nobody']) {
      expect(await rlsRows(who), who).to.deep.equal(await listRows(who));
    }
    expect(await rlsRows('olga')).to.deep.equal(['d1']);
    expect(await rlsRows('carol')).to.deep.equal(['d2']);
  });

  it('puts the usersets that hold the principal into its session keys, nested ones included', async () => {
    expect([...(await new RebacRlsSubjectKeys().keys(world.model, userPrincipal('olga')))].sort()).to.deep.equal(['group:eng#member', 'group:ops#member', 'user:olga']);
  });

  it('unrolls tuple-to-userset to the model maxDepth and refuses an exclusion', () => {
    const expr = rebacRlsExpr(world.model.schema(), 'doc', 'read', 2) as { any: RebacRlsExpr[] };
    expect(expr.any.slice(0, 2)).to.deep.equal([{ tuples: 'owner' }, { tuples: 'viewer' }]);
    expect(expr.any[2]).to.deep.equal({ any: [{ arrow: { tupleset: 'parent', type: 'folder', expr: { any: [{ tuples: 'viewer' }, { any: [{ arrow: { tupleset: 'parent', type: 'folder', expr: { any: [{ tuples: 'viewer' }, { any: [] }] } } }] }] } } }] });
    expect(() => new RebacRlsPlanSource().plan(world.model, def('doc:view'), 'doc')).to.throw(/exclusion/);
    expect(() => new RebacRlsPlanSource().plan({ name: 'rebac' } as AuthorizationModel, def('doc:read'), 'doc')).to.throw(/not a RebacModel/);
  });

  it('follows no conditional tuple, neither a relation tuple nor an arrow', async () => {
    const sql = new RebacRlsTerm().renderSql({ any: [{ tuples: 'viewer' }, { arrow: { tupleset: 'parent', type: 'folder', expr: { tuples: 'viewer' } } }] }, ctxFor(['user:x']));
    expect(sql.match(/\.caveat_key IS NULL/g)).to.have.length(3);
    const conditional = [{ ...tuple(d4, 'viewer', user('xavier')), caveat: { name: 'c' } }, { ...tuple(d4, 'parent', { type: 'folder', id: 'f1' }), caveat: { name: 'c' } }];
    const store = new DbTupleStore();
    await store.write(conditional, [], user('admin'));
    try {
      expect(await rlsRows('xavier')).to.deep.equal([]);
      // frank views f1: only the unconditional parent tuple of d2 leads to it.
      expect(await rlsRows('frank')).to.deep.equal(['d2']);
    } finally {
      await store.write([], conditional, user('admin'));
    }
  });

  it('refuses a permission that reaches a conditional relation: AUTHZ020, or TRUE under partial', async () => {
    const conditional = await caveatModel();
    expect(() => new RebacRlsPlanSource().plan(conditional, def('doc:read'), 'doc')).to.throw(/conditional relation doc#viewer/);
    const permissions = { get: (name: string) => (name === 'doc:read' ? ({ name, resource: 'doc', action: 'read', types: ['doc'], list: true, source: 'test' } as PermissionDef) : undefined) };
    const generate = (mode: true | 'partial') => generateRls({ models: [conditional], permissions, resources: [{ type: 'doc', table: DOCS, idColumn: 'id', relations: () => undefined, ancestorTable: 'authz_resource_ancestor', mode }], sources: new Map([['rebac', new RebacRlsPlanSource()]]), compilers: new Map([['rebac.rls', new RebacRlsTerm()]]) });
    const strict = await generate(true);
    expect(strict.diagnostics.filter((d) => d.permission === 'doc:read').map((d) => d.code)).to.deep.equal(['AUTHZ020']);
    const partial = await generate('partial');
    expect(partial.diagnostics.filter((d) => d.permission === 'doc:read').map((d) => d.code)).to.deep.equal(['AUTHZ021']);
    expect(partial.up.find((s) => s.includes('FOR SELECT'))).to.match(/USING \(TRUE\)$/);
  });

  it('refuses every route to a conditional relation: subject set, arrow, tupleset, union, intersection, exclusion', async () => {
    const model = await routesModel();
    expect(new RebacRlsPlanSource().plan(model, def('doc:p_plain'), 'doc').kind).to.equal('terms');
    const reached: Record<string, RegExp> = {
      p_direct: /conditional relation doc#direct/,
      p_set: /conditional relation group#member/,
      p_arrow: /conditional relation folder#cviewer/,
      p_tupleset: /conditional relation doc#cparent/,
      p_union: /conditional relation doc#direct/,
      p_inter: /conditional relation group#member/,
      // List support refuses an exclusion before the conditional walk runs.
      p_excl: /exclusion/,
    };
    for (const [p, message] of Object.entries(reached)) expect(() => new RebacRlsPlanSource().plan(model, def(`doc:${p}`), 'doc'), p).to.throw(message);
  });

  it('gives a conditional membership no session key', async () => {
    expect([...(await new RebacRlsSubjectKeys().keys(await routesModel(), userPrincipal('u3')))].sort()).to.deep.equal(['group:g2#member', 'user:u3']);
  });

  it('refuses the query-builder form: .accessible() plans never hold it', () => {
    expect(() => new RebacRlsTerm().apply()).to.throw(/row level security term/);
  });

  it('parses the term before rendering it and names the first malformed node', () => {
    const term = new RebacRlsTerm();
    const rendering = (args: unknown) => () => term.renderSql(args, ctxFor([]));
    expect(rendering('viewer')).to.throw(AuthzConfigError, /rebac\.rls: args must be an object/);
    expect(rendering({ tuples: 'viewer', all: [] })).to.throw(/args must have exactly one of/);
    expect(rendering({ tuples: '' })).to.throw(/tuples must be a non-empty string/);
    expect(rendering({ arrow: { tupleset: 'parent' } })).to.throw(/arrow\.type must be a non-empty string/);
    expect(rendering({ arrow: { tupleset: 'parent', type: 'folder', expr: { tuples: 'viewer' }, sql: '1 = 1' } })).to.throw(/arrow\.sql is not a known key/);
    expect(rendering({ any: [{ tuples: 'viewer' }, { tuples: 7 }] })).to.throw(/any\[1\]\.tuples must be a non-empty string/);
    expect(rendering({ none: [] })).to.throw(/none is not a known key/);
    expect(rendering({ any: new Array<unknown>(1) })).to.throw(/any\[0\] must be an object/);
    const hole = new Array<unknown>(3);
    hole[0] = { tuples: 'viewer' };
    hole[2] = { tuples: 'owner' };
    expect(rendering({ all: hole })).to.throw(/all\[1\] must be an object/);
    hole.length = 2;
    expect(rendering({ all: hole })).to.throw(/all\[1\] must be an object/);
    const expr = rebacRlsExpr(world.model.schema(), 'doc', 'read', 2);
    expect(parseRebacRlsExpr(expr)).to.deep.equal(expr);
  });
});
