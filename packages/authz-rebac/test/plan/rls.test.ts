import type { AuthorizationModel, PermissionDef } from '@spinajs/authz';
import type { PlanRow, RlsSqlContext } from '@spinajs/authz-orm/plan';
import { userPrincipal } from '@spinajs/authz-testing';
import { Wrapper } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';

import { DbTupleStore, RebacRlsPlanSource, RebacRlsSubjectKeys, RebacRlsTerm, RebacTuplesTerm, rebacRlsExpr } from '../../src/index.js';
import type { RebacRlsExpr } from '../../src/index.js';
import { bootDb, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';
import { TUPLES, setup, user } from '../support/world.js';
import type { Setup } from '../support/world.js';

const expect = chai.expect;

const DOCS = 'rls_doc';
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const def = (name: string) => ({ name }) as PermissionDef;

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

  it('refuses the query-builder form: .accessible() plans never hold it', () => {
    expect(() => new RebacRlsTerm().apply()).to.throw(/row level security term/);
  });
});
