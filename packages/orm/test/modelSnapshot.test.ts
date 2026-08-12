/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import { DateTime } from 'luxon';
import { ConnectionConf, FakeSqliteDriver, FakeMysqlDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeUpdateQueryCompiler, FakeInsertQueryCompiler, FakeTableQueryCompiler } from './misc.js';
import { Orm } from '../src/orm.js';
import { SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, TableQueryCompiler } from '../src/interfaces.js';
import { DbPropertyHydrator, NonDbPropertyHydrator, ModelHydrator } from '../src/hydrators.js';
import { Model1 } from './mocks/models/Model1.js';
import { extractModelDescriptor } from '../src/descriptor.js';
import { _prepareColumnDesc } from '../src/decorators.js';
import './../src/bootstrap.js';
import '@spinajs/log';

describe('ModelBase snapshot', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    DI.register(FakeMysqlDriver).as('mysql');

    DI.register(FakeSelectQueryCompiler).as(SelectQueryCompiler);
    DI.register(FakeDeleteQueryCompiler).as(DeleteQueryCompiler);
    DI.register(FakeUpdateQueryCompiler).as(UpdateQueryCompiler);
    DI.register(FakeInsertQueryCompiler).as(InsertQueryCompiler);
    DI.register(FakeTableQueryCompiler).as(TableQueryCompiler);

    DI.register(DbPropertyHydrator).as(ModelHydrator);
    DI.register(NonDbPropertyHydrator).as(ModelHydrator);

    DI.removeAllListeners('di.resolve.Configuration');

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('a freshly constructed model has no snapshot', () => {
    const m = new Model1();
    expect(m.Snapshot).to.equal(null);
  });

  it('takeSnapshot records every column', () => {
    const m = new Model1();
    m.Id = 1;
    m.Bar = 'hello';

    m.takeSnapshot();

    expect(m.Snapshot).to.not.equal(null);
    expect(m.Snapshot!.Columns.get('Id')).to.equal(1);
    expect(m.Snapshot!.Columns.get('Bar')).to.equal('hello');
  });

  it('takeSnapshot skips Virtual columns, including one @Filterable minted over a relation', () => {
    // `@Filterable` ( orm-http ) pushes a `{ Virtual: true }` column descriptor for any decorated
    // property that has no column of its own - relation properties included, which is how
    // `exists` / `n-exists` filters are declared. That makes the descriptor carry a "column" whose
    // value on the model is a Relation, not a column value. Reproduced here without depending on
    // orm-http.
    const descriptor = extractModelDescriptor(Model1)!;
    descriptor.Columns.push(_prepareColumnDesc({ Name: 'Owner', Virtual: true }));

    try {
      const m = new Model1();
      m.Id = 1;

      expect(() => m.takeSnapshot()).to.not.throw();

      // A virtual column has no database column behind it, so it has no place in a diff baseline
      // that exists only to build an UPDATE payload.
      expect(m.Snapshot!.Columns.has('Owner')).to.equal(false);
      expect(m.Snapshot!.Columns.has('Id')).to.equal(true);

      // and changedColumns has to read the same set back, or the column it never snapshotted is
      // compared against undefined and reported changed on every save
      expect(m.changedColumns()).to.not.include('Owner');
    } finally {
      descriptor.Columns = descriptor.Columns.filter((c) => c.Name !== 'Owner');
    }
  });

  it('the snapshot is a value copy - mutating the model does not change it', () => {
    const m = new Model1();
    m.Bar = 'before';
    m.takeSnapshot();

    m.Bar = 'after';

    expect(m.Snapshot!.Columns.get('Bar')).to.equal('before');
  });

  it('the snapshot is a value copy - mutating a mutable column value in place does not change it', () => {
    const m = new Model1() as any;
    m.Bar = { tags: ['a'] };
    m.takeSnapshot();

    m.Bar.tags.push('b');

    expect(m.Snapshot!.Columns.get('Bar')).to.deep.equal({ tags: ['a'] });
  });

  it('changedColumns is empty right after takeSnapshot', () => {
    const m = new Model1();
    m.Id = 1;
    m.Bar = 'x';
    m.takeSnapshot();

    expect(m.changedColumns()).to.deep.equal([]);
  });

  it('changedColumns names only the columns that actually differ', () => {
    const m = new Model1();
    m.Id = 1;
    m.Bar = 'x';
    m.takeSnapshot();

    m.Bar = 'y';

    expect(m.changedColumns()).to.deep.equal(['Bar']);
  });

  it('changedColumns ignores a write that restores the original value', () => {
    const m = new Model1();
    m.Bar = 'x';
    m.takeSnapshot();

    m.Bar = 'y';
    m.Bar = 'x';

    expect(m.IsDirty).to.equal(true);
    expect(m.changedColumns()).to.deep.equal([]);
  });

  // `Bar` rather than `CreatedAt`: only Id / Bar / OwnerId are reflected for TestTable1 in
  // test/misc.ts, and `changedColumns` only ever looks at reflected columns.
  it('changedColumns compares DateTime by instant, not identity', () => {
    const m = new Model1() as any;
    m.Bar = DateTime.fromISO('2020-01-01T00:00:00.000Z');
    m.takeSnapshot();

    m.Bar = DateTime.fromISO('2020-01-01T00:00:00.000Z');
    expect(m.changedColumns()).to.deep.equal([]);

    m.Bar = DateTime.fromISO('2021-01-01T00:00:00.000Z');
    expect(m.changedColumns()).to.deep.equal(['Bar']);
  });

  it('changedColumns lists every column when there is no snapshot', () => {
    const m = new Model1();
    m.Id = 1;
    m.Bar = 'x';

    const changed = m.changedColumns();
    expect(changed).to.include('Id');
    expect(changed).to.include('Bar');
  });

  it('clearSnapshot puts the model back to "never loaded"', () => {
    const m = new Model1();
    m.takeSnapshot();
    m.clearSnapshot();

    expect(m.Snapshot).to.equal(null);
  });

  it('markDirty records the property and flips IsDirty', () => {
    const m = new Model1();
    m.IsDirty = false;

    m.markDirty('Bar');

    expect(m.IsDirty).to.equal(true);
    expect(m.toSql(true)).to.have.property('Bar');
  });

  it('markDirty does not record the same property twice', () => {
    const m = new Model1();
    m.IsDirty = false;

    m.markDirty('Bar');
    m.markDirty('Bar');

    expect((m as any).__dirty_props__).to.deep.equal(['Bar']);
  });

  it('snapshotRelation is a no-op when there is no snapshot', () => {
    const m = new Model1();
    m.snapshotRelation('Nope');
    expect(m.Snapshot).to.equal(null);
  });
});
