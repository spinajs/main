import 'mocha';
import { expect } from 'chai';

import { AsyncService, Autoinject, DI, Injectable } from '../src/index.js';

abstract class Store {
  abstract name(): string;
}

@Injectable(Store)
class MemoryStore extends Store {
  name() {
    return 'memory';
  }
}

abstract class Missing {}

class AsyncDep extends AsyncService {
  public ready = false;
  public async resolve() {
    this.ready = true;
    await super.resolve();
  }
}

class Checked {
  @Autoinject(Store, { check: true })
  public Store: Store;
}

class CheckedMissing {
  @Autoinject(Missing, { check: true })
  public Missing: Missing;
}

class Optional {
  @Autoinject(Missing, { optional: true })
  public Missing: Missing | undefined;

  @Autoinject(Store, { optional: true })
  public Store: Store | undefined;
}

class AsyncChecked {
  @Autoinject(AsyncDep, { check: true })
  public Dep: AsyncDep;
}

describe('@Autoinject check and optional', () => {
  beforeEach(() => {
    DI.clear();
    DI.register(MemoryStore).as(Store);
  });

  it('check injects the registered implementation', () => {
    expect(DI.resolve(Checked).Store).to.be.instanceOf(MemoryStore);
  });

  it('check rejects the resolve when nothing is registered, instead of building the abstract base', async () => {
    let error: unknown;
    try {
      await (DI.resolve(CheckedMissing) as unknown as Promise<CheckedMissing>);
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).to.contain('Type Missing is not registered at container');
  });

  it('optional injects undefined when nothing is registered, and the implementation when one is', () => {
    const o = DI.resolve(Optional);
    expect(o.Missing).to.equal(undefined);
    expect(o.Store).to.be.instanceOf(MemoryStore);
  });

  it('resolves in the resolving child container', () => {
    const child = DI.child();
    class ChildStore extends Store {
      name() {
        return 'child';
      }
    }
    child.register(ChildStore).as(Store);
    expect(child.resolve(Checked).Store.name()).to.equal('child');
  });

  it('awaits an async service', async () => {
    DI.register(AsyncDep).asSelf();
    const holder = await (DI.resolve(AsyncChecked) as unknown as Promise<AsyncChecked>);
    expect(holder.Dep.ready).to.equal(true);
  });

  it('refuses check or optional on an array property', () => {
    expect(() => {
      class Bad {
        @Autoinject(Store, { optional: true })
        public Stores: Store[];
      }
      return Bad;
    }).to.throw('check and optional take a single class');
  });

  it('passes options to the constructor with check', () => {
    class Opts {
      constructor(public options: any) {}
    }
    class Holder {
      @Autoinject(Opts, { check: true, options: { x: 1 } })
      public Opts: Opts;
    }
    DI.register(Opts).asSelf();
    expect(DI.resolve(Holder).Opts.options).to.deep.equal({ x: 1 });
  });

  it('passes options to the constructor with optional', () => {
    class Opts {
      constructor(public options: any) {}
    }
    class Holder {
      @Autoinject(Opts, { optional: true, options: { x: 1 } })
      public Opts: Opts | undefined;
    }
    DI.register(Opts).asSelf();
    expect(DI.resolve(Holder).Opts?.options).to.deep.equal({ x: 1 });
  });

  it('refuses check together with optional', () => {
    expect(() => {
      class Bad {
        @Autoinject(Store, { check: true, optional: true })
        public Store: Store;
      }
      return Bad;
    }).to.throw('check and optional exclude each other');
  });

  it('refuses check on Array.chainOf', () => {
    expect(() => {
      class Bad {
        @Autoinject(Array.chainOf(Store), { check: true })
        public Stores: Store[];
      }
      return Bad;
    }).to.throw('check and optional take a single class');
  });

  it('rejects without an unhandled rejection when a check dependency is missing next to a rejecting async one', async () => {
    class Failing extends AsyncService {
      public async resolve() {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('async boom');
      }
    }
    class Holder {
      @Autoinject(Failing)
      public Failing: Failing;

      @Autoinject(Missing, { check: true })
      public Missing: Missing;
    }
    DI.register(Failing).asSelf();

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.once('unhandledRejection', onUnhandled);
    try {
      let error: unknown;
      try {
        await (DI.resolve(Holder) as unknown as Promise<Holder>);
      } catch (e) {
        error = e;
      }
      expect(error).to.be.instanceOf(Error);
      await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setImmediate(r));
      expect(unhandled).to.have.length(0);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});
