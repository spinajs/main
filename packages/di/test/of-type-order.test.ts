import 'mocha';
import { expect } from 'chai';
import { spy } from 'sinon';
import { AsyncService, Autoinject, Container, IInstanceCheck, NewInstance, PerChildInstance, PerInstanceCheck } from '../src/index.js';

const delay = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

abstract class Stage extends AsyncService {}

class SlowStage extends Stage {
  public async resolve() {
    await delay(30);
  }
}

class MidStage extends Stage {
  public async resolve() {
    await delay(10);
  }
}

class FastStage extends Stage {
  public async resolve() {
    await Promise.resolve();
  }
}

class SyncPlugin {}

@PerChildInstance()
class ScopedStage extends Stage {
  public async resolve() {
    await delay(5);
  }
}

@NewInstance()
class FreshStage extends Stage {
  public async resolve() {
    await Promise.resolve();
  }
}

class FailingStage extends Stage {
  public async resolve() {
    await delay(5);
    throw new Error('stage failed');
  }
}

const names = (items: unknown[]) => items.map((i) => (i as object).constructor.name);

function stages(...types: (typeof Stage)[]) {
  const c = new Container();
  for (const t of types) {
    c.register(t).as(Stage);
  }
  return c;
}

describe('Array.ofType order', () => {
  it('returns elements in registration order, not in the order their creation finished', async () => {
    const c = stages(SlowStage, MidStage, FastStage);

    const all = await c.resolve(Array.ofType(Stage));

    expect(names(all)).to.deep.equal(['SlowStage', 'MidStage', 'FastStage']);
  });

  it('keeps registration order on the cached collection', async () => {
    const c = stages(SlowStage, FastStage);
    await c.resolve(Array.ofType(Stage));

    expect(names(await c.resolve(Array.ofType(Stage)))).to.deep.equal(['SlowStage', 'FastStage']);
    expect(names(c.get(Array.ofType(Stage)))).to.deep.equal(['SlowStage', 'FastStage']);
  });

  it('puts a sync element registered after an async one after it', async () => {
    const c = new Container();
    c.register(SlowStage).as('Plugins');
    c.register(SyncPlugin).as('Plugins');

    expect(names(await c.resolve(Array.ofType('Plugins')))).to.deep.equal(['SlowStage', 'SyncPlugin']);
  });

  it('places an element registered after the first build last', async () => {
    const c = stages(SlowStage, MidStage);
    await c.resolve(Array.ofType(Stage));
    c.register(FastStage).as(Stage);

    expect(names(await c.resolve(Array.ofType(Stage)))).to.deep.equal(['SlowStage', 'MidStage', 'FastStage']);
  });

  it('places an element resolved on its own before the list in its registration slot', async () => {
    const c = stages(SlowStage, MidStage, FastStage);
    const fast = await c.resolve(FastStage);

    const all = await c.resolve(Array.ofType(Stage));

    expect(names(all)).to.deep.equal(['SlowStage', 'MidStage', 'FastStage']);
    expect(all[2]).to.equal(fast);
  });

  it('gives two concurrent list resolves the same ordered list', async () => {
    const c = stages(SlowStage, MidStage, FastStage);

    const [a, b] = await Promise.all([c.resolve(Array.ofType(Stage)), c.resolve(Array.ofType(Stage))]);

    expect(names(a)).to.deep.equal(['SlowStage', 'MidStage', 'FastStage']);
    expect(names(b)).to.deep.equal(['SlowStage', 'MidStage', 'FastStage']);
    expect(a.every((x, i) => x === b[i])).to.be.true;
  });
});

describe('Array.ofType and a concurrent single resolve', () => {
  it('a single resolve while the list is creating that type gets the instance, not the list', async () => {
    const c = stages(SlowStage, FastStage);

    const list = c.resolve(Array.ofType(Stage));
    const one = c.resolve(SlowStage);

    const [all, slow] = await Promise.all([list, one]);

    expect(slow).to.be.instanceOf(SlowStage);
    expect(all[0]).to.equal(slow);
  });

  it('a single resolve of the base while the list is creating its last registration gets that instance', async () => {
    const c = stages(FastStage, SlowStage);

    const list = c.resolve(Array.ofType(Stage));
    const one = c.resolve(Stage);

    const [all, last] = await Promise.all([list, one]);

    expect(last).to.be.instanceOf(SlowStage);
    expect(all[1]).to.equal(last);
  });

  it('a list resolve while a single resolve is creating an element still contains that element', async () => {
    const c = stages(SlowStage, FastStage);

    const one = c.resolve(SlowStage);
    const list = c.resolve(Array.ofType(Stage));

    const [slow, all] = await Promise.all([one, list]);

    expect(names(all)).to.deep.equal(['SlowStage', 'FastStage']);
    expect(all[0]).to.equal(slow);
  });
});

describe('Array.ofType in child containers and with other lifetimes', () => {
  it('a child resolving a list its parent owns gets registration order', async () => {
    const parent = stages(SlowStage, MidStage, FastStage);

    expect(names(await parent.child().resolve(Array.ofType(Stage)))).to.deep.equal(['SlowStage', 'MidStage', 'FastStage']);
  });

  it('a list owned by the child follows the child registration order, with a singleton the parent cached', async () => {
    const parent = stages(SlowStage);
    await parent.resolve(SlowStage);
    const child = parent.child();
    child.register(FastStage).as(Stage);
    child.register(SlowStage).as(Stage);
    child.register(MidStage).as(Stage);

    expect(names(await child.resolve(Array.ofType(Stage)))).to.deep.equal(['FastStage', 'SlowStage', 'MidStage']);
  });

  it('keeps a @PerChildInstance element in its slot, in the owner and in a child', async () => {
    const parent = stages(SlowStage, ScopedStage, FastStage);

    expect(names(await parent.child().resolve(Array.ofType(Stage)))).to.deep.equal(['SlowStage', 'ScopedStage', 'FastStage']);
    expect(names(await parent.resolve(Array.ofType(Stage)))).to.deep.equal(['SlowStage', 'ScopedStage', 'FastStage']);
  });

  it('leaves a @NewInstance element out and keeps the others in order', async () => {
    const c = stages(SlowStage, FreshStage, FastStage);

    expect(names(await c.resolve(Array.ofType(Stage)))).to.deep.equal(['SlowStage', 'FastStage']);
    expect(names(await c.resolve(Array.ofType(Stage)))).to.deep.equal(['SlowStage', 'FastStage']);
  });

  it('rejects when an element rejects, and caches the others in order', async () => {
    const c = stages(SlowStage, FailingStage, FastStage);

    let error: Error | undefined;
    try {
      await c.resolve(Array.ofType(Stage));
    } catch (err) {
      error = err as Error;
    }
    await delay(40);

    expect(error?.message).to.equal('stage failed');
    expect(names(c.get(Array.ofType(Stage)))).to.deep.equal(['SlowStage', 'FastStage']);
    expect(c.Cache.getResolutionStats().activeResolutions).to.equal(0);
  });
});

describe('the resolved Array.ofType list held by a consumer', () => {
  it('a rebuild does not reorder a held list the consumer sorted, it only appends the new element', async () => {
    const c = stages(SlowStage, MidStage);
    const held = await c.resolve(Array.ofType(Stage));
    held.reverse();

    c.register(FastStage).as(Stage);
    const again = await c.resolve(Array.ofType(Stage));

    expect(again).to.equal(held);
    expect(names(held)).to.deep.equal(['MidStage', 'SlowStage', 'FastStage']);
  });

  it('a list that never stops rebuilding ( a @NewInstance element ) leaves the held order alone', async () => {
    const c = stages(SlowStage, FreshStage, FastStage);
    const held = await c.resolve(Array.ofType(Stage));
    held.reverse();

    await c.resolve(Array.ofType(Stage));

    expect(names(held)).to.deep.equal(['FastStage', 'SlowStage']);
  });
});

describe('di.resolved events for Array.ofType elements', () => {
  it('emits di.resolved.<base> for an element the list joined while a single resolve was creating it', async () => {
    const c = stages(SlowStage, FastStage);
    const seen: string[] = [];
    c.on('di.resolved.Stage', (_c: unknown, instance: object) => seen.push(instance.constructor.name));

    await Promise.all([c.resolve(SlowStage), c.resolve(Array.ofType(Stage))]);

    expect(seen.sort()).to.deep.equal(['FastStage', 'SlowStage']);
  });
});

@PerInstanceCheck()
class CheckedPlugin implements IInstanceCheck {
  public __checkInstance__(): boolean {
    return true;
  }
}

@PerInstanceCheck()
class CheckedStage extends Stage implements IInstanceCheck {
  public async resolve() {
    await delay(10);
  }
  public __checkInstance__(): boolean {
    return true;
  }
}

describe('Array.ofType with a @PerInstanceCheck element', () => {
  it('includes the element when it was resolved on its own before the list', () => {
    const c = new Container();
    c.register(SyncPlugin).as('Plugins');
    c.register(CheckedPlugin).as('Plugins');
    const checked = c.resolve(CheckedPlugin);

    const all = c.resolve(Array.ofType('Plugins'));

    expect(names(all)).to.deep.equal(['SyncPlugin', 'CheckedPlugin']);
    expect(all[1]).to.equal(checked);
  });

  it('keeps the element in its registration slot when the other elements are async', async () => {
    const c = stages(SlowStage, CheckedStage, FastStage);
    const checked = await c.resolve(CheckedStage);

    const all = await c.resolve(Array.ofType(Stage));

    expect(names(all)).to.deep.equal(['SlowStage', 'CheckedStage', 'FastStage']);
    expect(all[1]).to.equal(checked);
  });

  it('the list settles: the next resolve returns the cached list without rebuilding', () => {
    const c = new Container();
    c.register(SyncPlugin).as('Plugins');
    c.register(CheckedPlugin).as('Plugins');
    c.resolve(CheckedPlugin);
    const first = c.resolve(Array.ofType('Plugins'));

    const getOrCreate = spy(c.Cache, 'getOrCreate');
    const again = c.resolve(Array.ofType('Plugins'));

    expect(again).to.equal(first);
    expect(getOrCreate.called).to.be.false;
  });

  it('a class registered under two bases is in both lists resolved concurrently', async () => {
    const c = new Container();
    c.register(CheckedStage).as(Stage);
    c.register(CheckedStage).as('Checked');

    const [all, checked] = await Promise.all([c.resolve(Array.ofType(Stage)), c.resolve(Array.ofType('Checked'))]);

    expect(names(all)).to.deep.equal(['CheckedStage']);
    expect(names(checked)).to.deep.equal(['CheckedStage']);
    expect(checked[0]).to.equal(all[0]);
  });
});

@PerInstanceCheck()
class Counted extends AsyncService implements IInstanceCheck {
  public static built = 0;
  public tenant?: string;
  // resolve options are appended to the constructor arguments after the injected dependencies (container.ts getNewInstance)
  constructor(options?: { tenant?: string }) {
    super();
    Counted.built++;
    this.tenant = options?.tenant;
  }
  public async resolve() {
    await delay(10);
  }
  public __checkInstance__(options?: unknown[]): boolean {
    return (this.tenant ?? undefined) === (options?.[0] as { tenant?: string } | undefined)?.tenant;
  }
}

// The list key must differ from the class name. With `.as('Counted')` the collection and the class share one
// cache key, so a list resolve after a single resolve finds the class instance, sees nothing unresolved and
// returns it without consulting options: test 2 could never pass.
describe('@PerInstanceCheck: single and list resolves share one path', () => {
  beforeEach(() => {
    Counted.built = 0;
  });

  it('a single and a list resolve racing build the class once', async () => {
    const c = new Container();
    c.register(Counted).as('Reports');

    const [one, list] = await Promise.all([c.resolve(Counted), c.resolve(Array.ofType('Reports'))]);

    expect(Counted.built).to.equal(1);
    expect(list[0]).to.equal(one);
  });

  it('an instance a list builds for its options is cached under the class', async () => {
    const c = new Container();
    c.register(Counted).as('Reports');
    await c.resolve(Counted, [{ tenant: 'a' }]);

    const list = await c.resolve(Array.ofType('Reports'), [{ tenant: 'b' }]);
    const b = await c.resolve(Counted, [{ tenant: 'b' }]);

    expect(b).to.equal(list[0]);
    expect(Counted.built).to.equal(2);
  });

  // getTypeName(Array.ofType('Reports')) === 'Reports', so the list event is di.resolved.Reports
  it('created through a list: di.resolved fires once for the class and once for the list key', async () => {
    const c = new Container();
    c.register(Counted).as('Reports');
    const onClass = spy();
    const onList = spy();
    c.on('di.resolved.Counted', onClass);
    c.on('di.resolved.Reports', onList);

    await c.resolve(Array.ofType('Reports'));

    expect(onClass.callCount).to.equal(1);
    expect(onList.callCount).to.equal(1);
  });

  it('a cached instance joining a list fires the list event once, not the class event again', async () => {
    const c = new Container();
    c.register(Counted).as('Reports');
    await c.resolve(Counted);
    const onClass = spy();
    const onList = spy();
    c.on('di.resolved.Counted', onClass);
    c.on('di.resolved.Reports', onList);

    await c.resolve(Array.ofType('Reports'));
    await c.resolve(Array.ofType('Reports'));

    expect(onClass.callCount).to.equal(0);
    expect(onList.callCount).to.equal(1);
  });

  it('two identical list resolves racing build the element once', async () => {
    const c = new Container();
    c.register(Counted).as('Reports');
    const onList = spy();
    c.on('di.resolved.Reports', onList);

    const [first, second] = await Promise.all([c.resolve(Array.ofType('Reports')), c.resolve(Array.ofType('Reports'))]);

    expect(Counted.built).to.equal(1);
    expect(onList.callCount).to.equal(1);
    expect(first).to.have.length(1);
    expect(second).to.have.length(1);
    expect(second[0]).to.equal(first[0]);
  });

  it('a single resolve after the list returns the list element', async () => {
    const c = new Container();
    c.register(Counted).as('Reports');

    const list = await c.resolve(Array.ofType('Reports'));
    const one = await c.resolve(Counted);

    expect(one).to.equal(list[0]);
    expect(Counted.built).to.equal(1);
  });

  // @Autoinject resolves with [undefined] options, a direct or list resolve with undefined: both mean "no options".
  it('an autoinjecting consumer racing a list resolve shares the element', async () => {
    class NeedsCounted {
      @Autoinject(Counted)
      public counted!: Counted;
    }
    const c = new Container();
    c.register(Counted).as('Reports');

    const [list, needs] = await Promise.all([c.resolve(Array.ofType('Reports')), c.resolve(NeedsCounted)]);

    expect(Counted.built).to.equal(1);
    expect(needs.counted).to.equal(list[0]);
  });

  it('a list element that finishes after abandonPending() is rejected and cached under neither key', async () => {
    const c = new Container();
    c.register(Counted).as('Reports');

    const pending = c.resolve(Array.ofType('Reports')) as unknown as Promise<Counted[]>;
    c.Cache.abandonPending();
    const error = await pending.then(
      () => undefined,
      (err: Error) => err,
    );

    expect(error?.message).to.match(/Counted finished resolving after the container was restored/);
    expect(c.Cache.has(Counted)).to.be.false;
    expect(c.Cache.has('Reports') ? c.Cache.get('Reports') : []).to.be.empty;
  });
});

@PerInstanceCheck()
class Loop implements IInstanceCheck {
  @Autoinject(Loop)
  public self!: Loop;
  public __checkInstance__(): boolean {
    return true;
  }
}

describe('@PerInstanceCheck: circular dependency', () => {
  it('a single resolve reports the cycle', () => {
    const c = new Container();
    c.register(Loop).asSelf();
    expect(() => c.resolve(Loop)).to.throw(/Circular dependency detected for Loop/);
  });

  it('a list resolve reports the cycle', () => {
    const c = new Container();
    c.register(Loop).as('Loops');
    expect(() => c.resolve(Array.ofType('Loops'))).to.throw(/Circular dependency detected for Loop/);
  });

  it('an autoinjected self-dependency is caught on its first re-entry', () => {
    const c = new Container();
    c.register(Loop).asSelf();
    const resolve = spy(c, 'resolve');

    expect(() => c.resolve(Loop)).to.throw(/Circular dependency detected for Loop/);
    expect(resolve.callCount).to.equal(2);
  });
});
