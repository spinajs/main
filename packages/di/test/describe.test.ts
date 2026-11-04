import 'mocha';
import { expect } from 'chai';

import { AsyncService, Autoinject, Container, forgetPendingProperties, Inject, LazyInject, NewInstance, PerChildInstance, pendingProperties, PROPERTY_TYPE_RESOLVER } from '../src/index.js';
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

@PerChildInstance()
class PerChild {}

// Applied by hand: TypeScript emits `design:type` only for decorators it applies itself, so these have no metadata.
class ExplicitWithoutMetadata {
  public dep: Dep;
}
Autoinject(Dep)(ExplicitWithoutMetadata.prototype, 'dep');

class Untyped {
  public dep: Dep;
}
NewInstance()(Untyped);
Autoinject()(Untyped.prototype, 'dep');

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

  // The pending-property table is process-wide.
  after(() => {
    forgetPendingProperties(ExplicitWithoutMetadata);
    forgetPendingProperties(Untyped);
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

  it('flags a token resolving while its implementation is in flight', async () => {
    c.register(Slow).as('slowToken');
    const resolving = c.resolve('slowToken');

    expect(c.describe().services.find((s) => s.token === 'slowToken')).to.deep.include({ resolving: true });

    releaseSlow();
    await resolving;
    expect(c.describe().services.find((s) => s.token === 'slowToken')).to.deep.include({ resolving: false });
  });

  it('reports the per-child lifetime and the generated name of an anonymous class', () => {
    c.register(PerChild).asSelf();
    c.register(class {}).as('anonymous');
    expect(implementationsOf(c, 'PerChild')[0].lifetime).to.eq('per-child');
    expect(implementationsOf(c, 'anonymous')[0].name).to.match(/^AnonymousClass#\d+$/);
  });

  it('lists a class whose property nothing types with the error and its declared lifetime', () => {
    c.register(Untyped).asSelf();
    const [impl] = implementationsOf(c, 'Untyped');
    expect(impl).to.include({ lifetime: 'new-instance', instantiated: false });
    expect(impl.injects).to.deep.eq([]);
    expect(impl.error).to.match(/Untyped\.dep/);
  });

  it('describes a property typed only by its decorator without consulting the type resolver or marking boot-check state', () => {
    let consulted = 0;
    c.register({ typeOf: () => void consulted++ }).asValue(PROPERTY_TYPE_RESOLVER.key);
    c.register(ExplicitWithoutMetadata).asSelf();
    expect(implementationsOf(c, 'ExplicitWithoutMetadata')[0].injects).to.deep.eq([{ token: 'Dep', kind: 'property', optional: false, array: false, property: 'dep' }]);
    expect(pendingProperties().find((p) => p.owner === ExplicitWithoutMetadata)).to.not.have.property('boundSingle');
    expect(consulted).to.eq(0);
  });

  it('hands out copies of the registration lists', () => {
    c.register(Impl).as(Contract);
    const [, list] = [...c.Registry.entries()].find(([key]) => key === 'Contract')!;
    (list as unknown[]).push(Fresh);
    expect(c.getRegisteredTypes(Contract)).to.deep.eq([Impl]);
  });
});
