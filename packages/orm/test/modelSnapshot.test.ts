/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import util from 'node:util';
import { DateTime } from 'luxon';
import { ConnectionConf, FakeSqliteDriver, FakeMysqlDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeUpdateQueryCompiler, FakeInsertQueryCompiler, FakeTableQueryCompiler } from './misc.js';
import { Orm } from '../src/orm.js';
import { SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, TableQueryCompiler } from '../src/interfaces.js';
import { DbPropertyHydrator, NonDbPropertyHydrator, ModelHydrator } from '../src/hydrators.js';
import { Model1 } from './mocks/models/Model1.js';
import { Model4 } from './mocks/models/Model4.js';
import { IModelChange, UNCOPYABLE } from '../src/snapshot.js';
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

      // and changes() has to read the same set back, or the column it never snapshotted is
      // compared against undefined and reported changed on every save
      expect(m.changes().map((c) => c.Column)).to.not.include('Owner');
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

  it('clearSnapshot puts the model back to "never loaded"', () => {
    const m = new Model1();
    m.takeSnapshot();
    m.clearSnapshot();

    expect(m.Snapshot).to.equal(null);
  });

  it('snapshotRelation is a no-op when there is no snapshot', () => {
    const m = new Model1();
    m.snapshotRelation('Nope');
    expect(m.Snapshot).to.equal(null);
  });

  it('IsNew is true until a snapshot exists and true again after clearSnapshot', () => {
    const m = new Model1();
    expect(m.IsNew).to.equal(true);

    m.takeSnapshot();
    expect(m.IsNew).to.equal(false);

    m.clearSnapshot();
    expect(m.IsNew).to.equal(true);
  });

  it('changes() reports every column with OldValue undefined when there is no snapshot', () => {
    const m = new Model1();
    m.Id = 1;
    m.Bar = 'x';

    const changes = m.changes();

    expect(changes.find((c) => c.Column === 'Bar')).to.deep.equal({ Column: 'Bar', OldValue: undefined, NewValue: 'x' });
    expect(changes.map((c) => c.Column)).to.include('Id');
  });

  it('changes() is empty right after takeSnapshot', () => {
    const m = new Model1();
    m.Id = 1;
    m.Bar = 'x';
    m.takeSnapshot();

    expect(m.changes()).to.deep.equal([]);
  });

  it('changes() names exactly the differing columns with old and new values', () => {
    const m = new Model1();
    m.Id = 1;
    m.Bar = 'x';
    m.takeSnapshot();

    m.Bar = 'y';

    expect(m.changes()).to.deep.equal([{ Column: 'Bar', OldValue: 'x', NewValue: 'y' }]);
  });

  it('changes() ignores a write that restores the original value', () => {
    const m = new Model1();
    m.Bar = 'x';
    m.takeSnapshot();

    m.Bar = 'y';
    m.Bar = 'x';

    expect(m.changes()).to.deep.equal([]);
  });

  it('changes() sees an in-place mutation of a mutable column value', () => {
    const m = new Model1() as any;
    m.Bar = { tags: ['a'] };
    m.takeSnapshot();

    m.Bar.tags.push('b');

    expect(m.changes()).to.deep.equal([{ Column: 'Bar', OldValue: { tags: ['a'] }, NewValue: { tags: ['a', 'b'] } }]);
  });

  it('changes() compares DateTime by instant, not identity', () => {
    const m = new Model1() as any;
    m.Bar = DateTime.fromISO('2020-01-01T00:00:00.000Z');
    m.takeSnapshot();

    m.Bar = DateTime.fromISO('2020-01-01T00:00:00.000Z');
    expect(m.changes()).to.deep.equal([]);

    m.Bar = DateTime.fromISO('2021-01-01T00:00:00.000Z');
    expect(m.changes().map((c: IModelChange) => c.Column)).to.deep.equal(['Bar']);
  });

  it('changes() compares a Buffer by content', () => {
    const m = new Model1() as any;
    m.Bar = Buffer.from('ab');
    m.takeSnapshot();

    m.Bar = Buffer.from('ab');
    expect(m.changes()).to.deep.equal([]);

    m.Bar = Buffer.from('ac');
    expect(m.changes().map((c: IModelChange) => c.Column)).to.deep.equal(['Bar']);
  });

  it('changes() reports an UNCOPYABLE baseline as changed, with OldValue undefined', () => {
    class Opaque {
      constructor(public v: number) {}
    }
    const m = new Model1() as any;
    m.Bar = new Opaque(1);
    m.takeSnapshot();

    expect(m.Snapshot!.Columns.get('Bar')).to.equal(UNCOPYABLE);
    expect(m.changes()).to.deep.equal([{ Column: 'Bar', OldValue: undefined, NewValue: m.Bar }]);
  });

  it('changes() reports a belongsTo foreign key re-pointed through the relation', () => {
    const m = new Model1();
    (m as any).OwnerId = 1;
    m.takeSnapshot();

    m.Owner.attach(new Model4({ Id: 2 }));

    expect(m.changes()).to.deep.equal([{ Column: 'OwnerId', OldValue: 1, NewValue: 2 }]);
  });

  it('changes() reports a detached belongsTo as a change to null', () => {
    const m = new Model1();
    (m as any).OwnerId = 1;
    m.takeSnapshot();

    m.Owner.detach();

    expect(m.changes()).to.deep.equal([{ Column: 'OwnerId', OldValue: 1, NewValue: null }]);
  });

  it('changes() does not report a belongsTo that was never attached or populated', () => {
    const m = new Model1();
    (m as any).OwnerId = 1;
    m.takeSnapshot();

    expect(m.Owner.Value).to.equal(undefined);
    expect(m.changes()).to.deep.equal([]);
  });

  it('IsDirty is true on a model that was never in the database', () => {
    const m = new Model1();
    expect(m.IsDirty).to.equal(true);
  });

  it('IsDirty is false right after takeSnapshot and true after a column write', () => {
    const m = new Model1();
    m.Bar = 'x';
    m.takeSnapshot();
    expect(m.IsDirty).to.equal(false);

    m.Bar = 'y';
    expect(m.IsDirty).to.equal(true);
  });

  it('IsDirty is false again once the original value is written back', () => {
    const m = new Model1();
    m.Bar = 'x';
    m.takeSnapshot();

    m.Bar = 'y';
    m.Bar = 'x';

    expect(m.IsDirty).to.equal(false);
  });

  it('IsDirty sees an in-place mutation of a mutable column value', () => {
    const m = new Model1() as any;
    m.Bar = { tags: ['a'] };
    m.takeSnapshot();

    m.Bar.tags.push('b');

    expect(m.IsDirty).to.equal(true);
  });

  it('IsDirty has no setter', () => {
    const m = new Model1();
    m.takeSnapshot();

    expect(() => {
      (m as any).IsDirty = true;
    }).to.throw(TypeError);
  });

  it('a constructed model is a plain instance, not a Proxy', () => {
    const m = new Model1();
    expect(Object.getPrototypeOf(m)).to.equal(Model1.prototype);
    expect(util.types.isProxy(m)).to.equal(false);
  });

  it('toSql(true) is narrowed to the columns changes() reports', () => {
    const m = new Model1();
    m.Id = 1;
    m.Bar = 'x';
    m.takeSnapshot();

    m.Bar = 'y';

    expect(Object.keys(m.toSql(true) as object)).to.deep.equal(['Bar']);
  });
});
