import 'mocha';
import { expect } from 'chai';

import { AsyncService, DI, LazyInject, NewInstance, PerChildInstance } from '../src/index.js';

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

@NewInstance()
class Holder {
  @LazyInject(Store)
  public Store: Store;
}

@PerChildInstance()
class PerChildHolder {
  @LazyInject(Store)
  public Store: Store;
}

class SingletonHolder {
  @LazyInject(Store)
  public Store: Store;
}

@PerChildInstance()
class DerivedHolder extends PerChildHolder {}

@PerChildInstance()
class NamedHolder {
  @LazyInject('Region')
  public Region: { name: string };
}

@PerChildInstance()
class ListHolder {
  @LazyInject(Store)
  public Nearest: Store[];

  @LazyInject(Array.chainOf(Store))
  public Chain: Store[];

  @LazyInject(Array.chainOf(Store), { mapFunc: (s: Store) => s.name() })
  public ByName: Map<string, Store>;
}

abstract class AsyncBase extends AsyncService {
  abstract name(): string;
}

class AsyncStore extends AsyncBase {
  name() {
    return 'async';
  }
}

class AsyncListHolder {
  @LazyInject(Array.ofType(AsyncBase), { mapFunc: (s: AsyncBase) => s.name() })
  public ByName: Promise<Map<string, AsyncBase>>;
}

describe('@LazyInject', () => {
  beforeEach(() => {
    DI.clear();
    RootStore.Built = 0;
  });

  it('does not resolve while the owner is built, resolves on read', () => {
    DI.register(RootStore).as(Store);

    const holder = DI.resolve(Holder);
    expect(RootStore.Built).to.eq(0);

    expect(holder.Store.name()).to.eq('root');
    expect(RootStore.Built).to.eq(1);
  });

  it('resolves in the child container that built the owner', () => {
    DI.register(RootStore).as(Store);
    const child = DI.child();
    child.register(ChildStore).as(Store);

    expect(child.resolve(PerChildHolder).Store.name()).to.eq('child');
    expect(DI.resolve(PerChildHolder).Store.name()).to.eq('root');
  });

  it('resolves in the root for a root singleton reached through a child', () => {
    DI.register(RootStore).as(Store);
    DI.register(SingletonHolder).asSelf();
    const child = DI.child();
    child.register(ChildStore).as(Store);

    expect(child.resolve(SingletonHolder).Store.name()).to.eq('root');
  });

  it('resolves from the root for an owner made with new', () => {
    DI.register(RootStore).as(Store);
    DI.child().register(ChildStore).as(Store);

    expect(new PerChildHolder().Store.name()).to.eq('root');
  });

  it('works through inheritance', () => {
    DI.register(RootStore).as(Store);
    const child = DI.child();
    child.register(ChildStore).as(Store);

    expect(child.resolve(DerivedHolder).Store.name()).to.eq('child');
  });

  it('reads a string key from the container that built the owner', () => {
    DI.register({ name: 'root' }).asValue('Region');
    const child = DI.child();
    child.register({ name: 'child' }).asValue('Region');

    expect(child.resolve(NamedHolder).Region.name).to.eq('child');
    expect(new NamedHolder().Region.name).to.eq('root');
  });

  it('resolves a class on an array property as Array.ofType, Array.chainOf as the lineage, mapFunc as a map', () => {
    DI.register(RootStore).as(Store);
    const child = DI.child();
    child.register(ChildStore).as(Store);

    const lists = child.resolve(ListHolder);

    expect(RootStore.Built).to.eq(0);
    expect(lists.Nearest.map((s) => s.name())).to.deep.equal(['child']);
    expect(lists.Chain.map((s) => s.name())).to.deep.equal(['root', 'child']);
    expect([...lists.ByName.keys()]).to.deep.equal(['root', 'child']);
  });

  it('maps a list that resolves to a promise', async () => {
    DI.register(AsyncStore).as(AsyncBase);

    const map = await DI.resolve(AsyncListHolder).ByName;

    expect([...map.keys()]).to.deep.equal(['async']);
  });

  it('refuses a list on a single-value property and an array property without a type', () => {
    expect(() => {
      class Holder {
        @LazyInject(Array.ofType(Store))
        public Store: Store;
      }
      return Holder;
    }).to.throw('@LazyInject(Array.ofType(Store)) needs an array, map or promise property');

    expect(() => {
      class Holder {
        @LazyInject()
        public Stores: Store[];
      }
      return Holder;
    }).to.throw('pass the element type');
  });

  it('cannot be assigned', () => {
    DI.register(RootStore).as(Store);
    const holder = DI.resolve(Holder);

    expect(() => (holder.Store = new ChildStore())).to.throw(TypeError, 'cannot be assigned');
  });
});
