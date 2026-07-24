import 'mocha';
import { expect } from 'chai';
import { getInheritedDescriptor, collapseInheritedDescriptor } from '../src/index.js';

const TEST_SYMBOL = Symbol('TEST_DESCRIPTOR');

interface ITestDescriptor {
  Name: string | null;
  Items: string[];
  Entries: Map<string, string>;
}

const createDefault = (): ITestDescriptor => ({
  Name: null,
  Items: [],
  Entries: new Map<string, string>(),
});

/** stand-in for a decorator: grab this class's own descriptor and mutate it */
function decorate(target: object, mutate: (d: ITestDescriptor) => void) {
  mutate(getInheritedDescriptor(target, TEST_SYMBOL, createDefault));
}

describe('descriptor inheritance', () => {
  it('gives each class its own descriptor - a child never mutates its parent', () => {
    class Parent {}
    class Child extends Parent {}

    decorate(Parent, (d) => d.Entries.set('a', 'parent-a'));
    decorate(Child, (d) => d.Entries.set('a', 'child-a'));

    const parent = getInheritedDescriptor(Parent, TEST_SYMBOL, createDefault);
    const child = getInheritedDescriptor(Child, TEST_SYMBOL, createDefault);

    expect(parent).to.not.equal(child);
    expect(parent.Entries.get('a')).to.eq('parent-a');
    expect(child.Entries.get('a')).to.eq('child-a');
  });

  it('inherits map entries and overrides only the redeclared key', () => {
    class Parent {}
    class Child extends Parent {}

    decorate(Parent, (d) => {
      d.Entries.set('keep', 'parent-keep');
      d.Entries.set('override', 'parent-override');
    });
    decorate(Child, (d) => d.Entries.set('override', 'child-override'));

    const child = getInheritedDescriptor(Child, TEST_SYMBOL, createDefault);
    expect(child.Entries.get('keep')).to.eq('parent-keep');
    expect(child.Entries.get('override')).to.eq('child-override');
  });

  it('concatenates arrays down the chain', () => {
    class Parent {}
    class Child extends Parent {}

    decorate(Parent, (d) => d.Items.push('parent'));
    decorate(Child, (d) => d.Items.push('child'));

    expect(getInheritedDescriptor(Child, TEST_SYMBOL, createDefault).Items).to.deep.eq(['parent', 'child']);
  });

  it('inherits a scalar the child does not declare, and prefers the child when it does', () => {
    class Parent {}
    class Silent extends Parent {}
    class Loud extends Parent {}

    decorate(Parent, (d) => (d.Name = 'parent'));
    decorate(Silent, (d) => d.Items.push('x'));
    decorate(Loud, (d) => (d.Name = 'loud'));

    expect(getInheritedDescriptor(Silent, TEST_SYMBOL, createDefault).Name).to.eq('parent');
    expect(getInheritedDescriptor(Loud, TEST_SYMBOL, createDefault).Name).to.eq('loud');
  });

  it('collapses a three level chain base first', () => {
    class A {}
    class B extends A {}
    class C extends B {}

    decorate(A, (d) => {
      d.Entries.set('k', 'a');
      d.Items.push('a');
    });
    decorate(B, (d) => {
      d.Entries.set('k', 'b');
      d.Items.push('b');
    });
    decorate(C, (d) => d.Items.push('c'));

    const c = getInheritedDescriptor(C, TEST_SYMBOL, createDefault);
    expect(c.Entries.get('k')).to.eq('b');
    expect(c.Items).to.deep.eq(['a', 'b', 'c']);
  });

  it('does not duplicate array entries down a four level chain', () => {
    class W {}
    class X extends W {}
    class Y extends X {}
    class Z extends Y {}

    decorate(W, (d) => d.Items.push('w'));
    decorate(X, (d) => d.Items.push('x'));
    decorate(Y, (d) => d.Items.push('y'));
    decorate(Z, (d) => d.Items.push('z'));

    expect(getInheritedDescriptor(Z, TEST_SYMBOL, createDefault).Items).to.deep.eq(['w', 'x', 'y', 'z']);
  });

  it('skips an undecorated class in the middle of the chain', () => {
    class P {}
    class Q extends P {}
    class R extends Q {}

    decorate(P, (d) => d.Items.push('p'));
    decorate(R, (d) => d.Items.push('r'));

    expect(getInheritedDescriptor(R, TEST_SYMBOL, createDefault).Items).to.deep.eq(['p', 'r']);
  });

  it('keys by class identity, so two classes sharing a name stay separate', () => {
    // the override case: an app names its subclass exactly like the parent
    const makeParent = () => class Same {};
    const Parent = makeParent();
    class Same extends Parent {}

    expect(Parent.name).to.eq(Same.name);

    decorate(Parent, (d) => d.Entries.set('who', 'parent'));
    decorate(Same, (d) => d.Entries.set('who', 'child'));

    expect(getInheritedDescriptor(Parent, TEST_SYMBOL, createDefault).Entries.get('who')).to.eq('parent');
    expect(getInheritedDescriptor(Same, TEST_SYMBOL, createDefault).Entries.get('who')).to.eq('child');
  });

  it('collapseInheritedDescriptor does not store anything', () => {
    class Parent {}
    class Child extends Parent {}

    decorate(Parent, (d) => d.Entries.set('a', 'parent-a'));

    const collapsed = collapseInheritedDescriptor(Child, TEST_SYMBOL, createDefault);
    expect(collapsed.Entries.get('a')).to.eq('parent-a');
    expect(Reflect.getOwnMetadata(TEST_SYMBOL, Child)).to.be.undefined;
  });

  it('works on prototypes as well as constructors', () => {
    class Parent {}
    class Child extends Parent {}

    decorate(Parent.prototype, (d) => d.Entries.set('a', 'parent-a'));
    decorate(Child.prototype, (d) => d.Entries.set('b', 'child-b'));

    const child = getInheritedDescriptor(Child.prototype, TEST_SYMBOL, createDefault);
    expect(child.Entries.get('a')).to.eq('parent-a');
    expect(child.Entries.get('b')).to.eq('child-b');
    expect(getInheritedDescriptor(Parent.prototype, TEST_SYMBOL, createDefault).Entries.has('b')).to.be.false;
  });
});
