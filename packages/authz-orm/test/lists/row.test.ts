import * as chai from 'chai';
import 'mocha';

import { RawQuery, Wrap } from '@spinajs/orm';
import type { ICompilerOutput, ModelBase, QueryBuilder } from '@spinajs/orm';

import * as root from '../../src/index.js';
import { AccessResource, Owner } from '../../src/index.js';
import * as contract from '../../src/plan/index.js';
import { entryOf } from '../../src/registry.js';
import { planRow } from '../../src/lists/index.js';
import { TestDb } from '../support/db.js';

const expect = chai.expect;

describe('the plan term contract and planRow()', function () {
  this.timeout(60000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open();
  });

  after(async () => {
    await db?.close();
  });

  afterEach(async () => {
    await db.clear();
  });

  it('the plan entry point holds the contract only, the same objects as the root', () => {
    expect(Object.keys(contract).sort()).to.deep.equal(['PlanTermCompiler', 'RELATION_OWNER_OP', 'RELATION_SELF_OP']);
    expect(root.PlanTermCompiler).to.equal(contract.PlanTermCompiler);
    expect([contract.RELATION_OWNER_OP, contract.RELATION_SELF_OP]).to.deep.equal(['relation.owner', 'relation.self']);
  });

  it('describes the row of a query, on the query connection', async () => {
    const Task = (await db.define({
      name: 'Task',
      columns: { id: 'INTEGER', owner_id: 'TEXT' },
      rows: [{ id: 1 }, { id: 2 }],
      decorate: (c, proto) => {
        AccessResource('task')(c);
        Owner()(proto, 'owner_id');
      },
    })) as typeof ModelBase & { query(): QueryBuilder };
    const row = planRow(Task.query(), entryOf(Task)!);

    expect(row.type).to.equal('task');
    expect(row.ancestorTable).to.equal('authz_resource_ancestor');
    expect(row.relation('owner')).to.deep.equal({ column: 'owner_id' });
    expect(row.relation('self')).to.equal(undefined);
    expect(row.id).to.be.instanceOf(Wrap);
    const rows = await db.driver().select().from(db.table(Task)).whereIn(row.id, ['2']).asRaw<{ id: number }[]>();
    expect(rows.map((r) => Number(r.id))).to.deep.equal([2]);
    expect((row.from('authz_assignment', 'authz_s').toDB() as ICompilerOutput).expression).to.equal('SELECT * FROM `authz_assignment` as `authz_s`');
    expect(row.now()).to.be.instanceOf(RawQuery);
    expect(row.now().Query).to.equal(db.driver().now().Query);
  });
});
