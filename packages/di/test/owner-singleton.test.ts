import 'mocha';
import { expect } from 'chai';

import { AsyncService, Autoinject, Container, DI, IContainer, IInstanceCheck, Inject, NewInstance, PerChildInstance, PerInstance, PerInstanceCheck } from '../src/index.js';

class Model {}
class A extends Model {}
class B extends Model {}
class C extends Model {}
class Rbac extends Model {}
class RbacChild extends Rbac {}

class Svc {
  public static Created = 0;

  constructor() {
    Svc.Created++;
  }
}

class Store {}
class RootStore extends Store {}
class ChildStore extends Store {}

class Dep {}
class RootDep extends Dep {}
class ChildDep extends Dep {}

@Inject(Dep)
class Consumer {
  @Autoinject()
  public container: Container;

  constructor(public dep: Dep) {}
}

@PerInstance()
class PerInstanceSvc {}

@PerInstanceCheck()
class NamedSvc implements IInstanceCheck {
  constructor(public Name: string) {}

  __checkInstance__(creationOptions: unknown[]): boolean {
    return this.Name === creationOptions[0];
  }
}

@PerChildInstance()
class PerChildSvc {}

@PerChildInstance()
class PerChildModel extends Model {}

@PerChildInstance()
class PerChildOverride extends PerChildModel {}

@NewInstance()
class Fresh {}

@NewInstance()
class FreshModel extends Model {
  public static Created = 0;

  constructor() {
    super();
    FreshModel.Created++;
  }
}

class Plain {}

class Late {}
class LateA extends Late {}

@Inject(Store)
class PlainConsumer {
  constructor(public store: Store) {}
}

class SlowFailing extends AsyncService {
  public async resolve(): Promise<void> {
    await new Promise((res) => setTimeout(res, 5));
    throw new Error('SlowFailing failed');
  }
}

class Throwing {
  constructor() {
    throw new Error('Throwing failed');
  }
}

class SlowSvc extends AsyncService {
  public static Created = 0;

  constructor() {
    super();
    SlowSvc.Created++;
  }

  public async resolve(): Promise<void> {
    await new Promise((res) => setTimeout(res, 10));
    await super.resolve();
  }
}

describe('owner-container singletons (DI-2)', () => {
  beforeEach(() => {
    DI.clear();
    Svc.Created = 0;
    SlowSvc.Created = 0;
  });

  describe('singletons live in the container that owns their registration', () => {
    it('a root singleton resolved first through a child is created once, in root (F4)', () => {
      DI.register(Svc).asSelf();
      const child = DI.child();

      const fromChild = child.resolve(Svc);
      const fromRoot = DI.resolve(Svc);

      expect(fromChild).to.equal(fromRoot);
      expect(Svc.Created).to.equal(1);
      expect(DI.RootContainer.Cache.has(Svc)).to.equal(true);
      expect(child.Cache.has(Svc)).to.equal(false);
      expect(child.get(Svc)).to.equal(fromRoot);
    });

    it('a root registration under a base type is created in root', () => {
      DI.register(RootStore).as(Store);
      const child = DI.child();

      const fromChild = child.resolve(Store);
      const fromRoot = DI.resolve(Store);

      expect(fromChild).to.be.instanceOf(RootStore);
      expect(fromChild).to.equal(fromRoot);
      expect(child.Cache.has(RootStore)).to.equal(false);
    });

    it('a grandchild delegates to root over an empty middle level', () => {
      DI.register(Svc).asSelf();
      const grandchild = DI.child().child();

      const fromGrandchild = grandchild.resolve(Svc);

      expect(DI.resolve(Svc)).to.equal(fromGrandchild);
      expect(Svc.Created).to.equal(1);
    });

    it('resolving in a child writes nothing into its registry', () => {
      DI.register(RootStore).as(Store);
      const child = DI.child();

      child.resolve(Store);

      expect(child.getRegisteredTypes(Store, false)).to.equal(null);
      expect(child.hasRegistered(RootStore, false)).to.equal(false);
    });

    it('PerInstance is cached in the owner', () => {
      DI.register(PerInstanceSvc).asSelf();
      const child = DI.child();

      const fromChild = child.resolve(PerInstanceSvc);

      expect(DI.resolve(PerInstanceSvc)).to.equal(fromChild);
      expect(DI.RootContainer.Cache.has(PerInstanceSvc)).to.equal(true);
      expect(child.Cache.has(PerInstanceSvc)).to.equal(false);
    });

    it('PerInstanceCheck is cached in the owner', () => {
      DI.register(NamedSvc).asSelf();
      const child = DI.child();

      const fromChild = child.resolve(NamedSvc, ['foo']);

      expect(DI.resolve(NamedSvc, ['foo'])).to.equal(fromChild);
      expect(child.resolve(NamedSvc, ['foo'])).to.equal(fromChild);
      expect(DI.RootContainer.Cache.has(NamedSvc)).to.equal(true);
      expect(child.Cache.has(NamedSvc)).to.equal(false);
    });

    it('a root singleton resolved through a child gets root dependencies and the root container', () => {
      DI.register(RootDep).as(Dep);
      DI.register(Consumer).asSelf();
      const child = DI.child();
      child.register(ChildDep).as(Dep);

      const consumer = child.resolve(Consumer);

      expect(consumer.dep).to.be.instanceOf(RootDep);
      expect(consumer.container).to.equal(DI.RootContainer);
      expect(DI.resolve(Consumer)).to.equal(consumer);
    });

    it('a child override is created and cached in the child, root is unaffected', () => {
      DI.register(RootStore).as(Store);
      const child = DI.child();
      child.register(ChildStore).as(Store);

      const fromChild = child.resolve(Store);
      const fromRoot = DI.resolve(Store);

      expect(fromChild).to.be.instanceOf(ChildStore);
      expect(fromRoot).to.be.instanceOf(RootStore);
      expect(child.Cache.has(ChildStore)).to.equal(true);
      expect(DI.RootContainer.Cache.has(ChildStore)).to.equal(false);
      expect(child.resolve(Store)).to.equal(fromChild);
    });

    it('a private instance the child already holds wins over the owner', () => {
      DI.register(ChildStore).asSelf();
      const child = DI.child();
      child.register(ChildStore).as(Store);

      const viaBase = child.resolve(Store);
      const viaClass = child.resolve(ChildStore);

      expect(viaBase).to.be.instanceOf(ChildStore);
      expect(viaClass).to.equal(viaBase);
      expect(DI.resolve(ChildStore)).to.not.equal(viaBase);
    });

    it('the owner emits di.resolved with itself as the container', () => {
      DI.register(Svc).asSelf();
      const child = DI.child();
      const inRoot: unknown[][] = [];
      const inChild: unknown[][] = [];
      const onRoot = (...args: unknown[]) => inRoot.push(args);
      const onChild = (...args: unknown[]) => inChild.push(args);
      DI.on('di.resolved.Svc', onRoot);
      child.on('di.resolved.Svc', onChild);

      try {
        const svc = child.resolve(Svc);
        child.resolve(Svc);

        expect(inRoot).to.have.length(1);
        expect(inRoot[0][0]).to.equal(DI.RootContainer);
        expect(inRoot[0][1]).to.equal(svc);
        expect(inChild).to.have.length(0);
      } finally {
        DI.off('di.resolved.Svc', onRoot);
      }
    });

    it('concurrent async resolution from root and children creates one instance', async () => {
      DI.register(SlowSvc).asSelf();
      const child = DI.child();
      const child2 = DI.child();

      const all = await Promise.all([child.resolve(SlowSvc), DI.resolve(SlowSvc), child2.resolve(SlowSvc), child.resolve(SlowSvc)]);

      expect(SlowSvc.Created).to.equal(1);
      all.forEach((s) => expect(s).to.equal(all[0]));
      expect(DI.RootContainer.Cache.has(SlowSvc)).to.equal(true);
      expect(child.Cache.has(SlowSvc)).to.equal(false);
    });
  });

  describe('Array.ofType over an ancestor list', () => {
    it('a child keeps seeing later root registrations (F5)', () => {
      DI.register(A).as(Model);
      DI.register(B).as(Model);
      const child = DI.child();

      const first = child.resolve(Array.ofType(Model));
      expect(first.map((m) => m.constructor)).to.deep.equal([A, B]);

      DI.register(C).as(Model);
      const second = child.resolve(Array.ofType(Model));

      expect(second.map((m) => m.constructor)).to.deep.equal([A, B, C]);
      expect(child.getRegisteredTypes(Model, false)).to.equal(null);
    });

    it('returns the root instances and leaves nothing in the child', () => {
      DI.register(A).as(Model);
      DI.register(B).as(Model);
      const child = DI.child();

      const fromChild = child.resolve(Array.ofType(Model));
      const fromRoot = DI.resolve(Array.ofType(Model));

      expect(fromChild).to.deep.equal(fromRoot);
      fromChild.forEach((m, i) => expect(m).to.equal(fromRoot[i]));
      expect(child.Cache.has(A)).to.equal(false);
      expect(child.Cache.has(Array.ofType(Model))).to.equal(false);
    });

    it('is served from the owner collection cache', () => {
      DI.register(A).as(Model);
      DI.register(B).as(Model);
      const child = DI.child();

      const fromChild = child.resolve(Array.ofType(Model));

      expect(DI.RootContainer.Cache.has(Array.ofType(Model))).to.equal(true);
      expect(child.resolve(Array.ofType(Model))).to.equal(fromChild);
      expect(DI.resolve(Array.ofType(Model))).to.equal(fromChild);
      expect(child.get(Array.ofType(Model))).to.equal(fromChild);
      expect(child.get(Array.ofType(Model), false)).to.deep.equal([]);
      expect((child as Container).isResolved(Array.ofType(Model))).to.equal(true);
    });

    it('a grandchild over a list the middle container owns uses the middle container', () => {
      DI.register(A).as(Model);
      const middle = DI.child();
      middle.register(B).as(Model);
      const grandchild = middle.child();

      const fromGrandchild = grandchild.resolve(Array.ofType(Model));

      expect(fromGrandchild.map((m) => m.constructor)).to.deep.equal([B]);
      expect(middle.Cache.has(B)).to.equal(true);
      expect(grandchild.Cache.has(B)).to.equal(false);
      expect(DI.RootContainer.Cache.has(B)).to.equal(false);
      expect(middle.resolve(Array.ofType(Model))[0]).to.equal(fromGrandchild[0]);
    });

    it('a NewInstance element is created once per resolve and left out, as in the owner', () => {
      FreshModel.Created = 0;
      DI.register(A).as(Model);
      DI.register(FreshModel).as(Model);
      const child = DI.child();

      expect(child.resolve(Array.ofType(Model)).map((m) => m.constructor)).to.deep.equal([A]);
      expect(FreshModel.Created).to.equal(1);
      expect(child.resolve(Array.ofType(Model)).map((m) => m.constructor)).to.deep.equal([A]);
      expect(FreshModel.Created).to.equal(2);
    });

    it('a NewInstance element next to a PerChildContainer one is created here and left out', () => {
      FreshModel.Created = 0;
      DI.register(FreshModel).as(Model);
      DI.register(PerChildModel).as(Model);
      const child = DI.child();

      const models = child.resolve(Array.ofType(Model));

      expect(models.map((m) => m.constructor)).to.deep.equal([PerChildModel]);
      expect(FreshModel.Created).to.equal(1);
    });

    it('a PerChildContainer element is the child instance', () => {
      DI.register(A).as(Model);
      DI.register(PerChildModel).as(Model);
      const child = DI.child();

      const fromChild = child.resolve(Array.ofType(Model));
      const fromRoot = DI.resolve(Array.ofType(Model));

      expect(fromChild[0]).to.equal(fromRoot[0]);
      expect(fromChild[1]).to.be.instanceOf(PerChildModel);
      expect(fromChild[1]).to.not.equal(fromRoot[1]);
      expect(child.Cache.has(PerChildModel)).to.equal(true);
      expect(child.resolve(Array.ofType(Model))[1]).to.equal(fromChild[1]);
    });

    it('resolves async elements in the owner', async () => {
      DI.register(SlowSvc).as('slow-list');
      const child = DI.child();

      const [fromChild] = await (child.resolve(Array.ofType('slow-list')) as unknown as Promise<SlowSvc[]>);
      const fromRoot = DI.resolve(SlowSvc);

      expect(fromChild).to.be.instanceOf(SlowSvc);
      expect(await fromRoot).to.equal(fromChild);
      expect(SlowSvc.Created).to.equal(1);
    });
  });

  describe('a child registration of a name an ancestor already cached (B29)', () => {
    it('the same class re-registered in a child gets a child instance', () => {
      DI.register(Rbac).as(Model);
      const fromRoot = DI.resolve(Array.ofType(Model))[0];
      const child = DI.child();
      child.register(Rbac).as(Model);

      const chained = (child.resolve(Array.chainOf(Model)) as Model[])[0];
      const listed = child.resolve(Array.ofType(Model))[0];

      expect(chained).to.be.instanceOf(Rbac);
      expect(chained).to.not.equal(fromRoot);
      expect(listed).to.equal(chained);
      expect(DI.resolve(Array.ofType(Model))[0]).to.equal(fromRoot);
    });

    it('a class with the same name re-registered in a child gets a child instance', () => {
      DI.register(Rbac).as(Model);
      const fromRoot = DI.resolve(Array.ofType(Model))[0];
      const ChildRbac = class Rbac extends Model {};
      const child = DI.child();
      child.register(ChildRbac).as(Model);

      const chained = (child.resolve(Array.chainOf(Model)) as Model[])[0];

      expect(chained).to.be.instanceOf(ChildRbac);
      expect(chained).to.not.equal(fromRoot);
    });
  });

  describe('Array.chainOf picks the class the owner registry leads to', () => {
    it('ignores a concrete override in the calling container for every entry', () => {
      DI.register(Rbac).as(Model);
      DI.register(PerChildModel).as(Model);
      const child = DI.child();
      child.register(RbacChild).as(Rbac);
      child.register(PerChildOverride).as(PerChildModel);

      const models = child.resolve(Array.chainOf(Model)) as Model[];

      expect(models.map((m) => m.constructor)).to.deep.equal([Rbac, PerChildModel]);
      expect(child.Cache.has(PerChildModel)).to.equal(true);
      expect(child.Cache.has(Rbac)).to.equal(false);
      expect(models[1]).to.not.equal((DI.resolve(Array.chainOf(Model)) as Model[])[1]);
    });
  });

  describe('a synchronous throw after a pending element', () => {
    it('leaves no unhandled rejection behind', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);

      try {
        DI.register(SlowFailing).as(Model);
        DI.register(Throwing).as(Model);
        DI.register(SlowFailing).as('failing-list');
        DI.register(Throwing).as('failing-list');

        expect(() => DI.resolve(Array.chainOf(Model))).to.throw('Throwing failed');
        DI.clearCache();
        expect(() => DI.resolve(Array.ofType('failing-list'))).to.throw('Throwing failed');

        await new Promise((res) => setTimeout(res, 30));
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }

      expect(unhandled).to.deep.equal([]);
    });
  });

  describe('self records left by resolving an unregistered key', () => {
    it('Array.chainOf lists the self record only while nobody registers the key', () => {
      const child = DI.child();
      const early = child.resolve(Late);

      expect(child.getRegisteredTypes(Array.chainOf(Late))).to.deep.equal([Late]);
      expect((child.resolve(Array.chainOf(Late)) as Late[])[0]).to.equal(early);

      DI.register(LateA).as(Late);

      expect(child.getRegisteredTypes(Array.chainOf(Late))).to.deep.equal([LateA]);
      expect((child.resolve(Array.chainOf(Late)) as Late[]).map((m) => m.constructor)).to.deep.equal([LateA]);
    });

    it('Array.ofType and a single resolve in the child follow the later root registration', () => {
      const child = DI.child();
      const early = child.resolve(Late);
      DI.register(LateA).as(Late);

      const listed = child.resolve(Array.ofType(Late));
      const single = child.resolve(Late);

      expect(listed.map((m) => m.constructor)).to.deep.equal([LateA]);
      expect(single).to.be.instanceOf(LateA);
      expect(single).to.equal(DI.resolve(Late));
      expect(listed[0]).to.equal(single);
      expect(early).to.not.equal(single);
      expect(child.getRegisteredTypes(Late, false)).to.deep.equal([Late]);
    });

    it('clear() resets the implicit records', () => {
      DI.resolve(Plain);
      const registry = DI.RootContainer.Registry as unknown as { implicitKeys: Set<string> };
      expect(registry.implicitKeys.has('Plain')).to.equal(true);

      DI.clear();

      expect(registry.implicitKeys.size).to.equal(0);
      DI.register(Plain).asSelf();
      expect(DI.RootContainer.Registry.ownsRegistration(Plain)).to.equal(true);
    });
  });

  describe('unchanged behaviour', () => {
    it('PerChildContainer keeps one instance per container', () => {
      DI.register(PerChildSvc).asSelf();
      const child = DI.child();
      const child2 = DI.child();

      const inRoot = DI.resolve(PerChildSvc);
      const inChild = child.resolve(PerChildSvc);
      const inChild2 = child2.resolve(PerChildSvc);

      expect(inChild).to.not.equal(inRoot);
      expect(inChild2).to.not.equal(inRoot);
      expect(inChild).to.not.equal(inChild2);
      expect(child.resolve(PerChildSvc)).to.equal(inChild);
      expect(child.Cache.has(PerChildSvc)).to.equal(true);
      expect(child.getRegisteredTypes(PerChildSvc, false)).to.equal(null);
    });

    it('NewInstance is never cached', () => {
      DI.register(Fresh).asSelf();
      const child = DI.child();

      expect(child.resolve(Fresh)).to.not.equal(child.resolve(Fresh));
      expect(child.Cache.has(Fresh)).to.equal(false);
      expect(DI.RootContainer.Cache.has(Fresh)).to.equal(false);
    });

    it('a factory runs on every resolve with the resolving container', () => {
      const seen: IContainer[] = [];
      DI.register((c: IContainer) => {
        seen.push(c);
        return {};
      }).as('owner-factory');
      const child = DI.child();

      expect(child.resolve('owner-factory')).to.not.equal(child.resolve('owner-factory'));
      expect(seen).to.deep.equal([child, child]);
    });

    it('a type registered nowhere is created in the resolving container and recorded there', () => {
      const child = DI.child();

      const fromChild = child.resolve(Plain);
      const fromRoot = DI.resolve(Plain);

      expect(fromChild).to.not.equal(fromRoot);
      expect(child.Cache.has(Plain)).to.equal(true);
      expect(child.getRegisteredTypes(Plain, false)).to.deep.equal([Plain]);
      expect(child.Registry.ownsRegistration(Plain)).to.equal(false);
      expect(child.resolve(Plain)).to.equal(fromChild);
    });

    it('a root resolve of an unregistered type does not make root its owner', () => {
      DI.register(RootStore).as(Store);
      const fromRoot = DI.resolve(PlainConsumer);
      DI.clearCache();
      const child = DI.child();
      child.register(ChildStore).as(Store);

      const fromChild = child.resolve(PlainConsumer);

      expect(DI.RootContainer.getRegisteredTypes(PlainConsumer, false)).to.deep.equal([PlainConsumer]);
      expect(fromRoot.store).to.be.instanceOf(RootStore);
      expect(fromChild.store).to.be.instanceOf(ChildStore);
      expect(child.Cache.has(PlainConsumer)).to.equal(true);
    });

    it('an explicit registration over a recorded key makes the container the owner', () => {
      DI.resolve(Plain);
      expect(DI.RootContainer.Registry.ownsRegistration(Plain)).to.equal(false);

      DI.register(Plain).asSelf();
      const child = DI.child();

      expect(DI.RootContainer.Registry.ownsRegistration(Plain)).to.equal(true);
      expect(child.resolve(Plain)).to.equal(DI.resolve(Plain));
      expect(child.Cache.has(Plain)).to.equal(false);
    });

    it('a root-resolved unregistered singleton is reused by children', () => {
      const fromRoot = DI.resolve(Plain);
      const child = DI.child();

      expect(child.resolve(Plain)).to.equal(fromRoot);
      expect(child.child().resolve(Plain)).to.equal(fromRoot);
    });
  });

  // Services rely on this: their resolve() holds no "already resolved" guard.
  describe('an AsyncService instance runs resolve() once', () => {
    class Counted extends AsyncService {
      public static Calls = 0;

      public async resolve(): Promise<void> {
        Counted.Calls++;
        await new Promise((res) => setTimeout(res, 5));
        await super.resolve();
      }
    }
    class CountedImpl extends Counted {}

    @PerChildInstance()
    class PerChildCounted extends AsyncService {
      public static Calls = 0;

      public async resolve(): Promise<void> {
        PerChildCounted.Calls++;
        await new Promise((res) => setTimeout(res, 5));
        await super.resolve();
      }
    }

    beforeEach(() => {
      Counted.Calls = 0;
      PerChildCounted.Calls = 0;
    });

    it('a singleton, over concurrent and repeated resolves through every key and container', async () => {
      DI.register(CountedImpl).as(Counted);
      DI.register(CountedImpl).asSelf();
      const child = DI.child();

      const first = await Promise.all([DI.resolve(Counted), DI.resolve(CountedImpl), child.resolve(Counted), child.resolve(Array.chainOf(Counted))]);
      await DI.resolve(Counted);
      await child.resolve(CountedImpl);
      await DI.resolve(Array.ofType(Counted));

      expect(Counted.Calls).to.equal(1);
      expect(first[1]).to.equal(first[0]);
      expect(first[2]).to.equal(first[0]);
    });

    it('a PerChildContainer service, once in every container', async () => {
      DI.register(PerChildCounted).asSelf();
      const child = DI.child();

      await Promise.all([DI.resolve(PerChildCounted), DI.resolve(PerChildCounted), child.resolve(PerChildCounted), child.resolve(PerChildCounted)]);
      await DI.resolve(PerChildCounted);
      await child.resolve(PerChildCounted);

      expect(PerChildCounted.Calls).to.equal(2);
    });
  });
});
