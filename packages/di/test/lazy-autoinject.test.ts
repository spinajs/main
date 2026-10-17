import 'mocha';
import { expect } from 'chai';

import { AsyncService, Autoinject, DI, Lazy, NewInstance, PerChildInstance } from '../src/index.js';

abstract class Store {
  abstract name(): string;
}

class RootStore extends Store {
  public static Built = 0;
  constructor() {
    super();
    RootStore.Built++;
  }
  name() {
    return 'root';
  }
}

class ChildStore extends Store {
  name() {
    return 'child';
  }
}

abstract class Missing {}

class AsyncDep extends AsyncService {
  public ready = false;
  public async resolve() {
    await new Promise((res) => setTimeout(res, 2));
    this.ready = true;
    await super.resolve();
  }
}

class Flaky extends AsyncService {
  public static Fail = true;
  public async resolve() {
    if (Flaky.Fail) {
      throw new Error('Flaky failed');
    }
    await super.resolve();
  }
}

class Holder {
  @Autoinject(Store, { lazy: true })
  public Store: Lazy<Store>;
}

@PerChildInstance()
class PerChildHolder {
  @Autoinject(Store, { lazy: true })
  public Store: Lazy<Store>;

  @Autoinject(Store)
  public Eager: Store;
}

class SingletonHolder {
  @Autoinject(Store, { lazy: true })
  public Store: Lazy<Store>;

  @Autoinject(Store)
  public Eager: Store;
}

describe('@Autoinject lazy', () => {
  beforeEach(() => {
    DI.clear();
    RootStore.Built = 0;
    Flaky.Fail = true;
  });

  it('does not resolve while the owner is built, resolves on the first call and keeps the result', async () => {
    DI.register(RootStore).as(Store);

    const holder = DI.resolve(Holder);
    expect(holder.Store).to.be.a('function');
    expect(RootStore.Built).to.equal(0);

    const first = await holder.Store();
    expect(first).to.be.instanceOf(RootStore);
    expect(await holder.Store()).to.equal(first);
    expect(RootStore.Built).to.equal(1);
  });

  it('shares one pending resolve between concurrent calls', async () => {
    DI.register(AsyncDep).asSelf();
    class AsyncHolder {
      @Autoinject(AsyncDep, { lazy: true })
      public Dep: Lazy<AsyncDep>;
    }
    const holder = DI.resolve(AsyncHolder);

    expect(holder.Dep()).to.equal(holder.Dep());
  });

  it('keeps the result per owner instance', async () => {
    @NewInstance()
    class Fresh {}
    @NewInstance()
    class FreshHolder {
      @Autoinject(Fresh, { lazy: true })
      public Fresh: Lazy<Fresh>;
    }

    const a = DI.resolve(FreshHolder);
    const b = DI.resolve(FreshHolder);

    expect(await a.Fresh()).to.equal(await a.Fresh());
    expect(await a.Fresh()).to.not.equal(await b.Fresh());
  });

  it('resolves in the child container that built a per-child owner', async () => {
    DI.register(RootStore).as(Store);
    const child = DI.child();
    child.register(ChildStore).as(Store);

    const holder = child.resolve(PerChildHolder);

    expect((await holder.Store()).name()).to.equal('child');
    expect(await holder.Store()).to.equal(holder.Eager);
    expect((await DI.resolve(PerChildHolder).Store()).name()).to.equal('root');
  });

  it('resolves in the root for a root singleton owner reached through a child, like the eager inject', async () => {
    DI.register(RootStore).as(Store);
    DI.register(SingletonHolder).asSelf();
    const child = DI.child();
    child.register(ChildStore).as(Store);

    const holder = child.resolve(SingletonHolder);

    expect(holder.Eager.name()).to.equal('root');
    expect(await holder.Store()).to.equal(holder.Eager);
  });

  it('resolves registrations made after the owner was built', async () => {
    const holder = DI.resolve(Holder);
    DI.register(RootStore).as(Store);

    expect((await holder.Store()).name()).to.equal('root');
  });

  it('awaits an AsyncService', async () => {
    class AsyncHolder {
      @Autoinject(AsyncDep, { lazy: true })
      public Dep: Lazy<AsyncDep>;
    }

    const dep = await DI.resolve(AsyncHolder).Dep();

    expect(dep).to.be.instanceOf(AsyncDep);
    expect(dep.ready).to.equal(true);
  });

  it('optional gives undefined when nothing is registered, and the implementation when one is', async () => {
    class OptionalHolder {
      @Autoinject(Missing, { lazy: true, optional: true })
      public Missing: Lazy<Missing | undefined>;

      @Autoinject(Store, { lazy: true, optional: true })
      public Store: Lazy<Store | undefined>;
    }
    DI.register(RootStore).as(Store);

    const holder = DI.resolve(OptionalHolder);

    expect(await holder.Missing()).to.equal(undefined);
    expect(await holder.Store()).to.be.instanceOf(RootStore);
  });

  it('check rejects when nothing is registered and resolves once something is', async () => {
    class CheckedHolder {
      @Autoinject(Store, { lazy: true, check: true })
      public Store: Lazy<Store>;
    }
    const holder = DI.resolve(CheckedHolder);

    let error: unknown;
    await holder.Store().catch((e) => (error = e));
    expect((error as Error).message).to.contain('Type Store is not registered at container');

    DI.register(RootStore).as(Store);
    expect(await holder.Store()).to.be.instanceOf(RootStore);
  });

  it('does not keep a rejected resolve', async () => {
    class FlakyHolder {
      @Autoinject(Flaky, { lazy: true })
      public Flaky: Lazy<Flaky>;
    }
    const holder = DI.resolve(FlakyHolder);

    let error: unknown;
    await holder.Flaky().catch((e) => (error = e));
    expect((error as Error).message).to.equal('Flaky failed');

    Flaky.Fail = false;
    const flaky = await holder.Flaky();
    expect(flaky).to.be.instanceOf(Flaky);
    expect(await holder.Flaky()).to.equal(flaky);
  });

  it('passes options to the constructor', async () => {
    class Opts {
      constructor(public options: any) {}
    }
    class OptsHolder {
      @Autoinject(Opts, { lazy: true, options: { x: 1 } })
      public Opts: Lazy<Opts>;
    }

    expect((await DI.resolve(OptsHolder).Opts()).options).to.deep.equal({ x: 1 });
  });

  describe('arrays', () => {
    class NamedStore extends Store {
      name() {
        return 'named';
      }
    }

    class ArrayHolder {
      @Autoinject(Array.ofType(Store), { lazy: true })
      public Stores: Lazy<Store[]>;

      @Autoinject(Array.chainOf(Store), { lazy: true })
      public Chain: Lazy<Store[]>;

      @Autoinject(Array.chainOf(Store), { lazy: true, mapFunc: (s: Store) => s.name() })
      public ByName: Lazy<Map<string, Store>>;
    }

    @PerChildInstance()
    class PerChildArrayHolder extends ArrayHolder {}

    it('Array.ofType gives the nearest registrations, Array.chainOf the whole lineage', async () => {
      DI.register(RootStore).as(Store);
      const child = DI.child();
      child.register(ChildStore).as(Store);
      child.register(NamedStore).as(Store);

      const holder = child.resolve(PerChildArrayHolder);

      expect((await holder.Stores()).map((s) => s.name())).to.deep.equal(['child', 'named']);
      expect((await holder.Chain()).map((s) => s.name())).to.deep.equal(['root', 'child', 'named']);
      expect([...(await holder.ByName()).keys()]).to.deep.equal(['root', 'child', 'named']);
    });

    it('refuses check or optional', () => {
      expect(() => {
        class Bad {
          @Autoinject(Array.ofType(Store), { lazy: true, optional: true })
          public Stores: Lazy<Store[]>;
        }
        return Bad;
      }).to.throw('check and optional take a single class');
    });
  });

  it('refuses lazy without an explicit type', () => {
    expect(() => {
      class Bad {
        @Autoinject({ lazy: true })
        public Store: Lazy<Store>;
      }
      return Bad;
    }).to.throw('lazy needs an explicit type');
  });

  it('refuses an eager Array.ofType', () => {
    expect(() => Autoinject(Array.ofType(Store) as any)).to.throw('Array.ofType(T) needs { lazy: true }');
  });
});
