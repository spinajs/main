import * as chai from 'chai';
import 'mocha';
import { ModelBase } from '@spinajs/orm';
import { History, historyModels, historySpecOf, registerHistory } from '../src/registry.js';
import type { TrackedModel, TrackedRow } from '../src/types.js';
import { HistoryConfigError } from '../src/errors.js';

const expect = chai.expect;

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
});
