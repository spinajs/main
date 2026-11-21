import * as chai from 'chai';
import 'mocha';
import type { Constructor } from '@spinajs/di';
import { ModelBase, UuidConverter, updateModelDescriptor } from '@spinajs/orm';
import { History, historyModels, historySpecOf, registerHistory } from '../src/registry.js';
import type { TrackedModel, TrackedRow } from '../src/types.js';
import { HistoryConfigError } from '../src/errors.js';

const expect = chai.expect;

// The descriptor a model's ORM decorators would write, without a connection or a table behind it.
function keyed(model: Constructor<ModelBase>, softDelete = ''): void {
  updateModelDescriptor(model, (d) => {
    d.TableName = model.name.toLowerCase();
    d.PrimaryKey.push('id');
    d.SoftDelete.DeletedAt = softDelete;
  });
}

describe('@History', () => {
  it('rejects columns together with exclude', () => {
    class A extends ModelBase {}
    expect(() => registerHistory(A, { columns: ['x'], exclude: ['y'] })).to.throw(HistoryConfigError, '@History on A: columns and exclude cannot be combined');
  });

  it('rejects an empty column list, a long entity and an empty trail name', () => {
    class B extends ModelBase {}
    expect(() => registerHistory(B, { columns: [] })).to.throw(HistoryConfigError, '@History on B: columns must name at least one column');
    expect(() => registerHistory(B, { entity: 'x'.repeat(129) })).to.throw(HistoryConfigError, '@History on B: entity must be 1 to 128 characters');
    expect(() => registerHistory(B, { trail: ' ' })).to.throw(HistoryConfigError, '@History on B: trail must be a non-empty trail name');
  });

  it('registers a decorated class and gives it the history members it declares', () => {
    @History({ trail: 'billing' })
    class C extends ModelBase implements TrackedRow {
      declare static history: TrackedModel['history'];
      declare history: TrackedRow['history'];
    }
    expect(historyModels()).to.include(C);
    expect(C.history).to.be.a('function');
    expect(C.prototype.history).to.be.a('function');
  });

  it('keeps an opted-out class and its subclasses untracked', () => {
    @History(false)
    class D extends ModelBase {}
    class E extends D {}
    expect(historyModels()).to.not.include(D);
    expect(historySpecOf(D)).to.eq(undefined);
    expect(historySpecOf(E)).to.eq(undefined);
  });

  it('replaces a mark with a second one and takes it back with false', () => {
    class F extends ModelBase implements TrackedRow {
      declare static history: TrackedModel['history'];
      declare history: TrackedRow['history'];
    }
    keyed(F);
    registerHistory(F, { trail: 'billing' });
    expect(historySpecOf(F)?.trail).to.eq('billing');
    registerHistory(F, { trail: 'ledger' });
    expect(historySpecOf(F)?.trail).to.eq('ledger');
    expect(historyModels().filter((m) => m === F)).to.have.length(1);
    expect(F.history).to.be.a('function');

    registerHistory(F, false);
    expect(F.history).to.eq(undefined);
    expect(F.prototype.history).to.eq(undefined);
    expect(historyModels()).to.not.include(F);
    expect(historySpecOf(F)).to.eq(undefined);
  });
});

describe('history spec of a model', () => {
  it('keeps the soft-delete column out of exclude, as column mode keeps it in columns', () => {
    class Account extends ModelBase {}
    keyed(Account, 'deleted_at');
    registerHistory(Account, { exclude: ['deleted_at', 'last_seen_at'] });
    expect(historySpecOf(Account)?.exclude).to.deep.eq(new Set(['last_seen_at']));
  });

  class Ledger extends ModelBase {}
  keyed(Ledger);
  registerHistory(Ledger);

  it('reads the key of a subclass with ORM metadata of its own from its base', () => {
    class BranchLedger extends Ledger {}
    updateModelDescriptor(BranchLedger, (d) => {
      d.TableName = 'branch_ledger';
    });
    expect(historySpecOf(BranchLedger)).to.include({ model: BranchLedger, entity: 'branch_ledger', pk: 'id' });
  });

  // The ORM refuses the statements of such a class too ("has no model descriptor; decorate it with @Model").
  it('refuses a subclass without ORM metadata of its own', () => {
    class PlainLedger extends Ledger {}
    expect(() => historySpecOf(PlainLedger)).to.throw(HistoryConfigError, '@History on PlainLedger: needs a single-column primary key, it has 0');
  });

  it('refuses a key that @Uuid() stores as bytes', () => {
    class Device extends ModelBase {}
    keyed(Device);
    // What @Uuid() writes into the descriptor.
    updateModelDescriptor(Device, (d) => {
      d.Converters.set('id', { Class: UuidConverter });
    });
    registerHistory(Device);
    expect(() => historySpecOf(Device)).to.throw(HistoryConfigError, '@History on Device: its primary key id is stored as bytes by @Uuid(), which has no text for a subject id; history needs a string or integer key');
  });
});
