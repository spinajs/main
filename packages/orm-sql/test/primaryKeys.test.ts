/* eslint-disable @typescript-eslint/no-floating-promises */
import { expect } from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm, SelectQueryBuilder, DeleteQueryBuilder, SortOrder, extractModelDescriptor } from '@spinajs/orm';
import { wherePk, whereAnyPk, whereNotAnyPk, orderByPk, normalizePkTuple, pkValueOf, pkKeyString } from '@spinajs/orm';
import { ConnectionConf, FakeSqliteDriver } from './fixture.js';
import { Model1 } from './Models/Model1.js';
import { CompositeKeyModel } from './Models/CompositeKeyModel.js';

function sqb() {
  const connection = DI.get(Orm)!.Connections.get('sqlite')!;
  return connection.Container.resolve(SelectQueryBuilder, [connection]);
}

function dqb() {
  const connection = DI.get(Orm)!.Connections.get('sqlite')!;
  return connection.Container.resolve(DeleteQueryBuilder, [connection]);
}

describe('primary key predicates', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('wherePk on a single-column key compiles to a plain equality (no AND wrapper)', () => {
    const q = sqb().select('*').from('users');
    wherePk(q, extractModelDescriptor(Model1)!, 5);

    const out = q.toDB();
    expect(out.expression).to.equal('SELECT * FROM `users` WHERE `Id` = ?');
    expect(out.bindings).to.deep.equal([5]);
  });

  it('wherePk on a composite key compiles to a parenthesised conjunction', () => {
    const q = sqb().select('*').from('composite_table');
    wherePk(q, extractModelDescriptor(CompositeKeyModel)!, [7, 'abc']);

    const out = q.toDB();
    expect(out.expression).to.equal('SELECT * FROM `composite_table` WHERE ( `TenantId` = ? AND `Code` = ? )');
    expect(out.bindings).to.deep.equal([7, 'abc']);
  });

  it('wherePk accepts an object form for a composite key', () => {
    const q = sqb().select('*').from('composite_table');
    wherePk(q, extractModelDescriptor(CompositeKeyModel)!, { Code: 'abc', TenantId: 7 });

    const out = q.toDB();
    expect(out.expression).to.equal('SELECT * FROM `composite_table` WHERE ( `TenantId` = ? AND `Code` = ? )');
    expect(out.bindings).to.deep.equal([7, 'abc']);
  });

  it('whereAnyPk on a single-column key compiles to IN', () => {
    const q = sqb().select('*').from('users');
    whereAnyPk(q, extractModelDescriptor(Model1)!, [1, 2, 3]);

    const out = q.toDB();
    expect(out.expression).to.equal('SELECT * FROM `users` WHERE `Id` IN (?,?,?)');
    expect(out.bindings).to.deep.equal([1, 2, 3]);
  });

  it('whereAnyPk on a composite key compiles to a disjunction of conjunctions', () => {
    const q = sqb().select('*').from('composite_table');
    whereAnyPk(q, extractModelDescriptor(CompositeKeyModel)!, [[1, 'a'], [2, 'b']]);

    const out = q.toDB();
    expect(out.expression).to.equal('SELECT * FROM `composite_table` WHERE ( ( `TenantId` = ? AND `Code` = ? ) OR ( `TenantId` = ? AND `Code` = ? ) )');
    expect(out.bindings).to.deep.equal([1, 'a', 2, 'b']);
  });

  it('whereAnyPk with no values matches nothing', () => {
    const q = sqb().select('*').from('composite_table');
    whereAnyPk(q, extractModelDescriptor(CompositeKeyModel)!, []);

    expect(q.toDB().expression).to.equal('SELECT * FROM `composite_table` WHERE FALSE');
  });

  it('whereNotAnyPk on a single-column key compiles to NOT IN', () => {
    const q = dqb().from('users');
    whereNotAnyPk(q, extractModelDescriptor(Model1)!, [1, 2]);

    const out = q.toDB();
    expect(out.expression).to.equal('DELETE FROM `users` WHERE `Id` NOT IN (?,?)');
    expect(out.bindings).to.deep.equal([1, 2]);
  });

  it('whereNotAnyPk on a composite key negates each tuple as a disjunction of inequalities', () => {
    const q = dqb().from('composite_table');
    whereNotAnyPk(q, extractModelDescriptor(CompositeKeyModel)!, [[1, 'a'], [2, 'b']]);

    const out = q.toDB();
    expect(out.expression).to.equal('DELETE FROM `composite_table` WHERE ( ( `TenantId` != ? OR `Code` != ? ) AND ( `TenantId` != ? OR `Code` != ? ) )');
    expect(out.bindings).to.deep.equal([1, 'a', 2, 'b']);
  });

  it('whereNotAnyPk with no values adds no condition', () => {
    const q = dqb().from('composite_table').where('Name', 'x');
    whereNotAnyPk(q, extractModelDescriptor(CompositeKeyModel)!, []);

    expect(q.toDB().expression).to.equal('DELETE FROM `composite_table` WHERE `Name` = ?');
  });

  it('orderByPk emits one ORDER BY term per key column', () => {
    const q = sqb().select('*').from('composite_table');
    expect(orderByPk(q, extractModelDescriptor(CompositeKeyModel)!, SortOrder.DESC)).to.equal(true);

    expect(q.getSorts().map((s) => `${s.column}:${s.order}`)).to.deep.equal(['TenantId:DESC', 'Code:DESC']);
  });

  it('normalizePkTuple rejects the wrong arity', () => {
    expect(() => normalizePkTuple(extractModelDescriptor(CompositeKeyModel)!, [1])).to.throw(/expects 2 value/);
  });

  it('normalizePkTuple rejects a scalar for a composite key', () => {
    expect(() => normalizePkTuple(extractModelDescriptor(CompositeKeyModel)!, 1)).to.throw(/composite primary key/);
  });

  it('pkValueOf returns a scalar for a single key and a tuple for a composite one', () => {
    expect(pkValueOf({ Id: 9 }, extractModelDescriptor(Model1)!)).to.equal(9);
    expect(pkValueOf({ TenantId: 1, Code: 'z' }, extractModelDescriptor(CompositeKeyModel)!)).to.deep.equal([1, 'z']);
  });

  it('pkKeyString builds a collision-free grouping key', () => {
    const d = extractModelDescriptor(CompositeKeyModel)!;
    expect(pkKeyString({ TenantId: 1, Code: 'a\u0000b' }, d)).to.not.equal(pkKeyString({ TenantId: 1, Code: 'a' }, d));
  });
});
