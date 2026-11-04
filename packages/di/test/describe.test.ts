import 'mocha';
import { expect } from 'chai';

import { AsyncService, Autoinject, Container, Inject, LazyInject, NewInstance } from '../src/index.js';
import type { ImplementationDescription } from '../src/index.js';

class Dep {}
class CtorDep {}
class LazyDep {}
class OptionalDep {}
class Plugin {}
abstract class Contract {}

@Inject(CtorDep)
class Impl extends Contract {
  @Autoinject(Dep)
  protected dep: Dep;

  @LazyInject(LazyDep)
  protected lazy: LazyDep;

  @Autoinject(OptionalDep, { optional: true })
  protected opt: OptionalDep | undefined;

  @Autoinject(Plugin, { mapFunc: (p: Plugin) => p.constructor.name })
  protected plugins: Map<string, Plugin>;

  public constructor(public readonly ctorDep: CtorDep) {
    super();
  }
}

@NewInstance()
class Fresh {}

let releaseSlow: () => void;

class Slow extends AsyncService {
  public async resolve() {
    await new Promise<void>((done) => (releaseSlow = done));
  }
}

function implementationsOf(c: Container, token: string): ImplementationDescription[] {
  return c.describe().services.find((s) => s.token === token)?.implementations ?? [];
}

describe('Container.describe', () => {
  let c: Container;

  beforeEach(() => {
    c = new Container();
  });

  it('lists the own registrations through Registry.entries', () => {
    c.register(Impl).as(Contract);
    expect([...c.Registry.entries()]).to.deep.include(['Contract', [Impl]]);
  });

  it('describes a class registered as a token with its ctor, property, lazy, optional and mapped injects', () => {
    c.register(Impl).as(Contract);
    const [impl] = implementationsOf(c, 'Contract');
    expect(impl).to.include({ name: 'Impl', kind: 'class', lifetime: 'singleton', instantiated: false, async: false });
    expect(impl.injects).to.have.deep.members([
      { token: 'CtorDep', kind: 'ctor', optional: false, array: false },
      { token: 'Dep', kind: 'property', optional: false, array: false, property: 'dep' },
      { token: 'LazyDep', kind: 'lazy', optional: false, array: false, property: 'lazy' },
      { token: 'OptionalDep', kind: 'property', optional: true, array: false, property: 'opt' },
      { token: 'Plugin', kind: 'property', optional: false, array: true, mapped: true, property: 'plugins' },
    ]);
  });

  it('marks an implementation instantiated once it is resolved', () => {
    c.register(Impl).as(Contract);
    c.resolve(Contract);
    expect(implementationsOf(c, 'Contract')[0].instantiated).to.eq(true);
  });

  it('reports the lifetime of a class and lists values', () => {
    c.register(Fresh).asSelf();
    c.register({ retries: 3 }).asValue('settings');
    expect(implementationsOf(c, 'Fresh')[0].lifetime).to.eq('new-instance');
    expect(implementationsOf(c, 'settings')).to.deep.eq([{ name: 'settings', kind: 'value', lifetime: 'value', instantiated: true, async: false, injects: [] }]);
  });

  it('describes its own registrations only, sorted by token', () => {
    c.register(Impl).as(Contract);
    const child = c.child();
    child.register(Fresh).asSelf();
    child.register(Dep).asSelf();
    expect(child.describe().services.map((s) => s.token)).to.deep.eq(['Dep', 'Fresh']);
  });

  it('marks a factory, an AsyncService class and a resolution in flight', async () => {
    const makeAnswer = () => 42;
    c.register(makeAnswer).as('answer');
    c.register(Slow).asSelf();
    const resolving = c.resolve(Slow);

    expect(implementationsOf(c, 'answer')).to.deep.eq([{ name: 'makeAnswer', kind: 'factory', lifetime: 'factory', instantiated: false, async: false, injects: [] }]);
    expect(c.describe().services.find((s) => s.token === 'Slow')).to.deep.include({ resolving: true });
    expect(implementationsOf(c, 'Slow')[0]).to.include({ async: true });

    releaseSlow();
    await resolving;
    expect(c.describe().services.find((s) => s.token === 'Slow')).to.deep.include({ resolving: false });
  });
});
