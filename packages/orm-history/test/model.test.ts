import * as chai from 'chai';
import 'mocha';
import { ExtensionMethodCollision, Model, ModelBase } from '@spinajs/orm';
import { History, HistoryConfigError, registerHistory } from '../src/index.js';
import type { TrackedModel, TrackedRow } from '../src/index.js';

const expect = chai.expect;

@History()
class Marked extends ModelBase<Marked> implements TrackedRow {
  declare static history: TrackedModel['history'];
  declare history: TrackedRow['history'];
}

class Child extends Marked {}

@History(false)
class OptedOut extends ModelBase<OptedOut> {}

class Plain extends ModelBase<Plain> {}

describe('history members of a marked model', () => {
  it('installs history on the class and its prototype, hidden from enumeration, and a subclass inherits both', () => {
    expect(Marked.history).to.be.a('function');
    expect(Child.history).to.eq(Marked.history);
    expect(Marked.prototype.history).to.be.a('function');
    expect(Object.keys(Marked)).to.not.include('history');
    expect(Object.keys(Marked.prototype)).to.not.include('history');
  });

  it('leaves an unmarked model and an opted-out model without the member', () => {
    expect('history' in Plain).to.eq(false);
    expect('history' in OptedOut).to.eq(false);
    // @ts-expect-error a model that is not marked has no history() in its type
    void Plain.history;
    // @ts-expect-error nor has its row
    void Plain.prototype.history;
  });

  it('refuses the mark on a class that does not declare the members', () => {
    // @ts-expect-error @History() needs `declare static history` and `declare history` on the class
    @History()
    class Undeclared extends ModelBase<Undeclared> {}
    expect(Undeclared).to.be.a('function');
    registerHistory(Undeclared, false);
  });

  it('gives the concrete subclasses of a marked abstract base and their rows the members', () => {
    @History()
    abstract class Shared<M> extends ModelBase<M> implements TrackedRow {
      declare static history: TrackedModel['history'];
      declare history: TrackedRow['history'];
    }
    @Model('history_concrete')
    class Concrete extends Shared<Concrete> {}
    expect(Concrete.history).to.eq(Shared.history).and.to.be.a('function');
    expect(new Concrete().history).to.be.a('function');
    expect(() => Shared.history()).to.throw(HistoryConfigError, '@History on Shared: needs a single-column primary key, it has 0');
  });

  it('refuses the mark on an abstract class that does not declare the members', () => {
    // @ts-expect-error @History() needs `declare static history` and `declare history` on an abstract class too
    @History()
    abstract class Undeclared extends ModelBase<Undeclared> {}
    expect(Undeclared).to.be.a('function');
    registerHistory(Undeclared, false);
  });

  it('takes the members back when the mark is taken back', () => {
    class Later extends ModelBase<Later> {}
    registerHistory(Later);
    expect('history' in Later).to.eq(true);
    registerHistory(Later, false);
    expect('history' in Later).to.eq(false);
  });

  it('refuses a model that has a member named history of its own', () => {
    class Own extends ModelBase<Own> {
      public history(): string {
        return 'mine';
      }
    }
    expect(() => registerHistory(Own)).to.throw(ExtensionMethodCollision, 'model extension history: Own already has a member of that name');
    expect(Object.hasOwn(Own, 'history')).to.eq(false);
  });
});
