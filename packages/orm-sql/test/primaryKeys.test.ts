/* eslint-disable @typescript-eslint/no-floating-promises */
import { expect } from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm, SelectQueryBuilder, DeleteQueryBuilder, SortOrder, extractModelDescriptor, IColumnDescriptor, Dataset } from '@spinajs/orm';
import { wherePk, whereAnyPk, whereNotAnyPk, orderByPk, normalizePkTuple, pkValueOf, pkKeyString } from '@spinajs/orm';
import { ConnectionConf, FakeSqliteDriver } from './fixture.js';
import { Model1 } from './Models/Model1.js';
import { CompositeKeyModel } from './Models/CompositeKeyModel.js';
import * as sinon from 'sinon';
import { SqlSelectQueryCompiler, SqlDeleteQueryCompiler } from '../src/compilers.js';

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
    sinon.restore();
  });

  /**
   * FakeSqliteDriver.executeOnDb returns `true`, which the SELECT path cannot `.map()` over.
   * Any test that actually EXECUTES a finder ( rather than only building it ) needs rows.
   */
  function stubRows(rows: any[] = []) {
    return sinon.stub(FakeSqliteDriver.prototype, 'executeOnDb').resolves(rows);
  }

  function col(Name: string, over: Partial<IColumnDescriptor> = {}): IColumnDescriptor {
    return {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: false,
      PrimaryKey: false,
      AutoIncrement: false,
      Name,
      Converter: null as any,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null as any,
      Aggregate: false,
      Virtual: false,
      ...over,
    } as IColumnDescriptor;
  }

  /**
   * `select(column)` validates the column against `descriptor.Columns`, which is filled from
   * the driver's `tableInfo`. FakeSqliteDriver returns null there, so a model that names its
   * key columns explicitly ( as `exists` does ) needs the table described.
   */
  async function describeCompositeTable() {
    const stub = sinon.stub(FakeSqliteDriver.prototype, 'tableInfo');
    stub.returns(Promise.resolve(null as any));
    stub.withArgs('composite_table', undefined).returns(Promise.resolve([col('TenantId', { PrimaryKey: true }), col('Code', { PrimaryKey: true, Type: 'VARCHAR', NativeType: 'VARCHAR' }), col('Name', { Type: 'VARCHAR', NativeType: 'VARCHAR', Nullable: true })]));
    await DI.get(Orm)!.reloadTableInfo();
    return stub;
  }

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

  // NOTE: these must AWAIT the finder. The query is only compiled when the builder is
  // executed, so reading spy.returnValues[0] synchronously ( as an earlier draft did )
  // sees an empty array and fails with "Cannot read properties of undefined".
  it('Dataset.diff compares composite keys by every column', () => {
    const keys = ['TenantId', 'Code'];
    const a = [{ TenantId: 1, Code: 'a' }, { TenantId: 1, Code: 'b' }];
    const b = [{ TenantId: 1, Code: 'a' }, { TenantId: 2, Code: 'a' }];

    const result = Dataset.diff(a)(b, keys);

    expect(result).to.deep.equal([{ TenantId: 1, Code: 'b' }, { TenantId: 2, Code: 'a' }]);
  });

  it('Dataset.intersection compares composite keys by every column', () => {
    const keys = ['TenantId', 'Code'];
    const a = [{ TenantId: 1, Code: 'a' }, { TenantId: 1, Code: 'b' }];
    const b = [{ TenantId: 1, Code: 'a' }, { TenantId: 2, Code: 'a' }];

    expect(Dataset.intersection(a)(b, keys)).to.deep.equal([{ TenantId: 1, Code: 'a' }]);
  });

  it('Dataset.diff on a single key is unchanged', () => {
    const a = [{ Id: 1 }, { Id: 2 }];
    const b = [{ Id: 2 }, { Id: 3 }];

    expect(Dataset.diff(a)(b, ['Id'])).to.deep.equal([{ Id: 1 }, { Id: 3 }]);
  });

  it('Model.get on a composite key compiles a conjunction', async () => {
    stubRows();
    const spy = sinon.spy(SqlSelectQueryCompiler.prototype, 'compile');
    await CompositeKeyModel.get([4, 'k']);

    const out = spy.returnValues[0];
    // `.first()` appends the LIMIT, hence the trailing `LIMIT ?` and its binding of 1.
    expect(out.expression).to.equal('SELECT * FROM `composite_table` WHERE ( `TenantId` = ? AND `Code` = ? ) ORDER BY `TenantId` DESC, `Code` DESC LIMIT ?');
    expect(out.bindings).to.deep.equal([4, 'k', 1]);
    spy.restore();
  });

  it('Model.find on a composite key compiles a disjunction of conjunctions', async () => {
    stubRows();
    const spy = sinon.spy(SqlSelectQueryCompiler.prototype, 'compile');
    await CompositeKeyModel.find([[1, 'a'], [2, 'b']]);

    const out = spy.returnValues[0];
    expect(out.expression).to.equal('SELECT * FROM `composite_table` WHERE ( ( `TenantId` = ? AND `Code` = ? ) OR ( `TenantId` = ? AND `Code` = ? ) )');
    expect(out.bindings).to.deep.equal([1, 'a', 2, 'b']);
    spy.restore();
  });

  it('Model.find on a single key still compiles to IN', async () => {
    stubRows();
    const spy = sinon.spy(SqlSelectQueryCompiler.prototype, 'compile');
    await Model1.find([1, 2, 3]);

    expect(spy.returnValues[0].expression).to.equal('SELECT * FROM `TestTable1` WHERE `Id` IN (?,?,?)');
    spy.restore();
  });

  it('Model.destroy on a composite key deletes only the named rows', async () => {
    stubRows();
    const spy = sinon.spy(SqlDeleteQueryCompiler.prototype, 'compile');
    await CompositeKeyModel.destroy([[1, 'a']]);

    const out = spy.returnValues[0];
    expect(out.expression).to.equal('DELETE FROM `composite_table` WHERE ( ( `TenantId` = ? AND `Code` = ? ) )');
    expect(out.bindings).to.deep.equal([1, 'a']);
    spy.restore();
  });

  it('Model.exists selects every key column of a composite key', async () => {
    await describeCompositeTable();
    stubRows();
    const spy = sinon.spy(SqlSelectQueryCompiler.prototype, 'compile');
    await (CompositeKeyModel as any).exists([1, 'a']);

    expect(spy.returnValues[0].expression).to.equal('SELECT `TenantId`,`Code` FROM `composite_table` WHERE ( `TenantId` = ? AND `Code` = ? ) LIMIT ?');
    spy.restore();
  });

  it('PrimaryKeyName is the key column list', () => {
    expect(new Model1().PrimaryKeyName).to.deep.equal(['Id']);
    expect(new CompositeKeyModel().PrimaryKeyName).to.deep.equal(['TenantId', 'Code']);
  });

  it('PrimaryKeyValue stays a scalar for single-column keys', () => {
    const m = new Model1();
    m.PrimaryKeyValue = 42;

    expect(m.Id).to.equal(42);
    expect(m.PrimaryKeyValue).to.equal(42);
  });

  it('PrimaryKeyValue is a tuple for composite keys', () => {
    const m = new CompositeKeyModel();
    m.PrimaryKeyValue = [3, 'xyz'];

    expect(m.TenantId).to.equal(3);
    expect(m.Code).to.equal('xyz');
    expect(m.PrimaryKeyValue).to.deep.equal([3, 'xyz']);
  });

  it('PrimaryKeyValue accepts the object form for composite keys', () => {
    const m = new CompositeKeyModel();
    m.PrimaryKeyValue = { Code: 'q', TenantId: 8 };

    expect(m.PrimaryKeyValue).to.deep.equal([8, 'q']);
  });

  it('pkKeyString builds a collision-free grouping key', () => {
    const d = extractModelDescriptor(CompositeKeyModel)!;
    expect(pkKeyString({ TenantId: 1, Code: 'a\u0000b' }, d)).to.not.equal(pkKeyString({ TenantId: 1, Code: 'a' }, d));
  });
});
