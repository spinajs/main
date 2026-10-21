import type { PlanRow } from '@spinajs/authz-orm/plan';
import { Wrapper } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';

import { DbTupleStore, REBAC_TUPLES_PLAN_OP, RebacTuplesTerm } from '../../src/index.js';
import type { RebacPlanExpr } from '../../src/index.js';
import { bootDb } from '../support/db.js';
import type { TestDb } from '../support/db.js';
import { ref, set, tuple, user } from '../support/world.js';

const expect = chai.expect;

const DOCS = 'plan_doc';
const leaf = (relation: string, subjects: string[]): RebacPlanExpr => ({ tuples: { relation, subjects } });

describe('authz-rebac: rebac.tuples on the query builders (sqlite)', function () {
  this.timeout(60_000);
  let db: TestDb;
  const term = new RebacTuplesTerm();

  const row = (): PlanRow => ({
    type: 'doc',
    id: Wrapper.Text('id'),
    relation: () => undefined,
    ancestorTable: 'authz_resource_ancestor',
    now: () => db.driver.now(),
    from: (table, alias) => db.driver.select<unknown>().from(table, alias),
  });

  async function ids(expr: RebacPlanExpr): Promise<string[]> {
    const rows = await db.driver
      .select()
      .select('id')
      .from(DOCS)
      .where(function (this: IWhereBuilder<unknown>) {
        term.apply(expr, this, row());
      })
      .asRaw<{ id: unknown }[]>();
    return rows.map((r) => String(r.id)).sort();
  }

  before(async () => {
    db = await bootDb('plan_term');
    await db.driver.schema().createTable(DOCS, (table) => {
      table.string('id', 64).primaryKey();
    });
    await db.driver
      .insert()
      .into(DOCS)
      .values(['d1', 'd2', 'd3', 'd4'].map((id) => ({ id })));
    const d = (id: string) => ref('doc', id);
    await new DbTupleStore().write(
      [
        tuple(d('d1'), 'owner', user('alice')),
        tuple(d('d2'), 'viewer', set('group', 'eng', 'member')),
        tuple(d('d3'), 'parent', { type: 'folder', id: 'f1' }),
        tuple(d('d3'), 'viewer', user('alice')),
        tuple(d('d4'), 'owner', user('bob')),
        // Same object id in another namespace: must not leak into docs.
        tuple(ref('folder', 'd4'), 'owner', user('alice')),
      ],
      [],
      user('admin'),
    );
  });

  after(async () => {
    await db?.dispose();
  });

  it('has the op the list plans emit', () => {
    expect(term.op).to.equal(REBAC_TUPLES_PLAN_OP);
  });

  it('a leaf keeps the rows with a tuple of the relation naming one of the subjects, in the row namespace only', async () => {
    expect(await ids(leaf('owner', ['user:alice']))).to.deep.equal(['d1']);
    expect(await ids(leaf('viewer', ['group:eng#member', 'user:alice']))).to.deep.equal(['d2', 'd3']);
    expect(await ids(leaf('parent', ['folder:f1']))).to.deep.equal(['d3']);
    expect(await ids(leaf('owner', ['user:carol']))).to.deep.equal([]);
  });

  it('a leaf without subjects keeps no row', async () => {
    expect(await ids(leaf('owner', []))).to.deep.equal([]);
  });

  it('any is OR, all is AND', async () => {
    expect(await ids({ any: [leaf('owner', ['user:alice']), leaf('viewer', ['user:alice'])] })).to.deep.equal(['d1', 'd3']);
    expect(await ids({ all: [leaf('parent', ['folder:f1']), leaf('viewer', ['user:alice'])] })).to.deep.equal(['d3']);
    expect(await ids({ all: [leaf('owner', ['user:alice']), leaf('viewer', ['user:alice'])] })).to.deep.equal([]);
    expect(await ids({ any: [{ all: [leaf('owner', ['user:bob'])] }, leaf('owner', ['user:alice'])] })).to.deep.equal(['d1', 'd4']);
  });

  it('refuses args that are no plan expression', () => {
    expect(() => term.apply({ tuples: 'owner' }, db.driver.select<unknown>().from(DOCS), row())).to.throw('rebac.tuples');
  });
});
