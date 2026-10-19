import 'mocha';
import { expect } from 'chai';

import { Autoinject, Container, DI, IContainer, Inject, Injectable, NewInstance, PerChildInstance, ResolveType, Singleton } from '../src/index.js';

const resolverOf = (type: new (...args: any[]) => unknown) => DI.RootContainer.extractDescriptor(type).resolver;

describe('a subclass inherits the lifetime of its base class', () => {
  class Dep {}

  it('keeps @NewInstance() when the subclass adds a property injection', () => {
    @NewInstance()
    class Base {}

    class Sub extends Base {
      @Autoinject(Dep)
      public dep: Dep;
    }

    expect(resolverOf(Sub)).to.eq(ResolveType.NewInstance);
    expect(DI.resolve(Sub)).to.not.equal(DI.resolve(Sub));
    expect(DI.resolve(Sub).dep).to.be.instanceOf(Dep);
  });

  it('keeps @NewInstance() when the subclass adds a constructor injection', () => {
    @NewInstance()
    class Base {}

    @Inject(Dep)
    class Sub extends Base {
      constructor(public dep: Dep) {
        super();
      }
    }

    expect(resolverOf(Sub)).to.eq(ResolveType.NewInstance);
    expect(DI.resolve(Sub)).to.not.equal(DI.resolve(Sub));
  });

  it('keeps @PerChildInstance() when the subclass adds a property injection', () => {
    @PerChildInstance()
    class Base {}

    class Sub extends Base {
      @Autoinject(Container)
      public container: IContainer;
    }

    const a = DI.child();
    const b = DI.child();

    expect(resolverOf(Sub)).to.eq(ResolveType.PerChildContainer);
    expect(a.resolve(Sub)).to.equal(a.resolve(Sub));
    expect(a.resolve(Sub)).to.not.equal(b.resolve(Sub));
    expect(a.resolve(Sub).container).to.equal(a);
  });

  it('keeps the lifetime of an @Injectable base for a subclass registered in its place', () => {
    @NewInstance()
    @Injectable()
    class Limiter {
      constructor(public readonly name: string) {}
    }

    @Injectable(Limiter)
    class CustomLimiter extends Limiter {
      @Autoinject(Dep)
      public dep: Dep;
    }

    const a = DI.resolve(Limiter, ['a']);
    const b = DI.resolve(Limiter, ['b']);

    expect(a).to.be.instanceOf(CustomLimiter);
    expect(a).to.not.equal(b);
    expect([a.name, b.name]).to.deep.eq(['a', 'b']);
  });

  it('passes the lifetime through every level and over an undecorated class', () => {
    @NewInstance()
    class Base {}

    class Middle extends Base {
      @Autoinject(Dep)
      public dep: Dep;
    }

    class Plain extends Middle {}

    class Leaf extends Plain {
      @Autoinject(Container)
      public container: IContainer;
    }

    expect(resolverOf(Middle)).to.eq(ResolveType.NewInstance);
    expect(resolverOf(Leaf)).to.eq(ResolveType.NewInstance);
    expect(DI.resolve(Leaf)).to.not.equal(DI.resolve(Leaf));
  });

  it('lets a lifetime decorator on the subclass override the inherited one', () => {
    @NewInstance()
    class Base {}

    @Singleton()
    class SingleSub extends Base {
      @Autoinject(Dep)
      public dep: Dep;
    }

    @PerChildInstance()
    class ChildSub extends Base {
      @Autoinject(Dep)
      public dep: Dep;
    }

    const child = DI.child();

    expect(resolverOf(SingleSub)).to.eq(ResolveType.Singleton);
    expect(DI.resolve(SingleSub)).to.equal(DI.resolve(SingleSub));
    expect(resolverOf(ChildSub)).to.eq(ResolveType.PerChildContainer);
    expect(child.resolve(ChildSub)).to.equal(child.resolve(ChildSub));
    expect(resolverOf(Base)).to.eq(ResolveType.NewInstance);
  });

  it('defaults to Singleton when no base class declares a lifetime', () => {
    class Base {}

    class Sub extends Base {
      @Autoinject(Dep)
      public dep: Dep;
    }

    expect(resolverOf(Sub)).to.eq(ResolveType.Singleton);
    expect(DI.resolve(Sub)).to.equal(DI.resolve(Sub));
  });
});
