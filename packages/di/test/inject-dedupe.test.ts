import 'mocha';
import { expect } from 'chai';

import { Autoinject, Container, DI, IContainer, Inject } from '../src/index.js';

describe('a property autoinject does not hide a constructor injection of the same type', () => {
  it('passes the container to the constructor when a property also autoinjects it', () => {
    @Inject(Container)
    class Both {
      @Autoinject(Container)
      public viaProperty: IContainer;

      constructor(public viaConstructor: IContainer) {}
    }

    const child = DI.child();
    const instance = child.resolve(Both);

    expect(instance.viaConstructor).to.equal(child);
    expect(instance.viaProperty).to.equal(child);
  });

  it('keeps a constructor injection inherited from a base class with a property autoinject', () => {
    @Inject(Container)
    class Base {
      constructor(public viaConstructor: IContainer) {}
    }

    class Derived extends Base {
      @Autoinject(Container)
      public viaProperty: IContainer;
    }

    const child = DI.child();
    const instance = child.resolve(Derived);

    expect(instance.viaConstructor).to.equal(child);
    expect(instance.viaProperty).to.equal(child);
  });
});
