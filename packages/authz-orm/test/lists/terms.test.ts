import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, PlanTermSql } from '@spinajs/authz';
import type { SqlFragment, SqlRowContext } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { RawQuery } from '@spinajs/orm';
import type { ModelBase, OrmDriver } from '@spinajs/orm';

import { AccessResource, Owner } from '../../src/index.js';
import { RelationOwnerSql, RelationSelfSql, castText, dialectOf, planTermCompilers, quoterOf } from '../../src/lists/index.js';
import { TestDb } from '../support/db.js';

const expect = chai.expect;

type Rel = { column: string; typeColumn?: string } | undefined;
const row = (over: Partial<SqlRowContext> = {}, relations: { owner?: Rel; self?: Rel } = { owner: { column: 'owner' }, self: { column: 'Uuid' } }): SqlRowContext => ({
  type: 'task',
  rowId: 'CAST("t"."id" AS TEXT)',
  rowColumn: (c) => `"t"."${c}"`,
  ancestorTable: '"authz_resource_ancestor"',
  now: new Date(0),
  dialect: 'sqlite',
  relation: (name) => relations[name],
  ...over,
});
const p = (type: string, id: string) => ({ type, id });

class FlagA extends PlanTermSql {
  readonly op = 'test.flag';
  toSql(): SqlFragment {
    return { sql: '1 = 1', bindings: [] };
  }
}
class FlagB extends FlagA {}

describe('PlanTermSql registry and relation.owner / relation.self', function () {
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

  it('casts to text per dialect and maps driver names', () => {
    expect(castText('sqlite', 'x')).to.equal('CAST(x AS TEXT)');
    expect(castText('postgres', 'x')).to.equal('CAST(x AS TEXT)');
    expect(castText('mysql', 'x')).to.equal('CAST(x AS CHAR(64))');
    expect(castText('mssql', 'x')).to.equal('CAST(x AS NVARCHAR(64))');
    expect(dialectOf(db.driver())).to.equal('sqlite');
    expect(dialectOf({ Options: { Driver: 'orm-driver-mysql-ssh' } } as unknown as OrmDriver)).to.equal('mysql');
    expect(dialectOf({ Options: { Driver: 'orm-driver-mssql' } } as unknown as OrmDriver)).to.equal('mssql');
    expect(() => dialectOf({ Options: { Driver: 'orm-driver-oracle', Name: 'x' } } as unknown as OrmDriver)).to.throw(AuthzConfigError, /orm-driver-oracle/);
    expect(quoterOf(db.driver())('task')).to.equal('`task`');
  });

  it('lists the registered compilers by op, relation.owner and relation.self built in', () => {
    const undo = testHost.registerInRoot(PlanTermSql, FlagA);
    try {
      const map = planTermCompilers();
      expect(map.get('relation.owner')).to.be.instanceOf(RelationOwnerSql);
      expect(map.get('relation.self')).to.be.instanceOf(RelationSelfSql);
      expect(map.get('test.flag')).to.be.instanceOf(FlagA);
    } finally {
      undo();
    }
  });

  it('refuses two compilers for one op', () => {
    const undo = [testHost.registerInRoot(PlanTermSql, FlagA), testHost.registerInRoot(PlanTermSql, FlagB)];
    try {
      expect(() => planTermCompilers()).to.throw(AuthzConfigError, /two PlanTermSql compilers for op "test\.flag" \(FlagA, FlagB\)/);
    } finally {
      undo.forEach((u) => u());
    }
  });

  it('relation.owner without a type column matches user principals only', () => {
    const c = new RelationOwnerSql();
    expect(c.toSql({ principals: [p('user', 'alice'), p('agent', 'bot'), p('user', 'bob')] }, row())).to.deep.equal({ sql: 'CAST("t"."owner" AS TEXT) IN (?, ?)', bindings: ['alice', 'bob'] });
    expect(c.toSql({ principals: [p('agent', 'bot')] }, row())).to.deep.equal({ sql: '1 = 0', bindings: [] });
    expect(c.toSql({ principals: [p('user', '1')] }, row({ dialect: 'mssql' })).sql).to.equal('CAST("t"."owner" AS NVARCHAR(64)) IN (?)');
  });

  it('relation.owner with a type column matches type and id', () => {
    const c = new RelationOwnerSql();
    const r = row({}, { owner: { column: 'InitiatorId', typeColumn: 'InitiatorType' } });
    expect(c.toSql({ principals: [p('user', 'alice'), p('agent', 'bot'), p('user', 'bob')] }, r)).to.deep.equal({
      sql: '("t"."InitiatorType" = ? AND CAST("t"."InitiatorId" AS TEXT) IN (?, ?)) OR ("t"."InitiatorType" = ? AND CAST("t"."InitiatorId" AS TEXT) IN (?))',
      bindings: ['user', 'alice', 'bob', 'agent', 'bot'],
    });
  });

  it('relation.self matches the self column against user principals', () => {
    expect(new RelationSelfSql().toSql({ principals: [p('user', 'u1')] }, row())).to.deep.equal({ sql: 'CAST("t"."Uuid" AS TEXT) IN (?)', bindings: ['u1'] });
  });

  it('refuses malformed args and a type without the relation', () => {
    const owner = new RelationOwnerSql();
    for (const bad of [null, {}, { principals: 'alice' }, { principals: [{ type: 'user' }] }, { principals: [{ type: 'user', id: 1 }] }]) {
      expect(() => owner.toSql(bad, row()), JSON.stringify(bad)).to.throw(AuthzConfigError);
    }
    expect(() => owner.toSql({ principals: [] }, row({}, {}))).to.throw(AuthzConfigError, /no owner column/);
    expect(() => new RelationSelfSql().toSql({ principals: [] }, row({}, {}))).to.throw(AuthzConfigError, /no self column/);
  });

  it('relation.owner runs on SQLite against an integer column', async () => {
    const Task = (await db.define({
      name: 'Task',
      columns: { owner_id: 'INTEGER' },
      rows: [
        { id: 'a', owner_id: 1 },
        { id: 'b', owner_id: 2 },
      ],
      decorate: (cls, proto) => {
        AccessResource('task')(cls);
        Owner()(proto, 'owner_id');
      },
    })) as typeof ModelBase;
    const table = db.table(Task);
    const f = new RelationOwnerSql().toSql({ principals: [p('user', '1'), p('user', 'x')] }, row({ rowColumn: (col) => `"${table}"."${col}"` }, { owner: { column: 'owner_id' } }));
    const rows = (await db
      .driver()
      .select()
      .from(table)
      .where(RawQuery.create(f.sql, [...f.bindings]))) as { id: string }[];
    expect(rows.map((r) => r.id)).to.deep.equal(['a']);
  });
});
