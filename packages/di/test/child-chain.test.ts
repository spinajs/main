import 'mocha';
import { expect } from 'chai';

import { AsyncService, Autoinject, Container, DI, IContainer, Inject, PerChildInstance, SyncService } from '../src/index.js';

class Model {}
class Rbac extends Model {}
class Abac extends Model {}
class FsAbac extends Model {}
class NothingRegistered {}
class RbacV2 extends Rbac {}

@PerChildInstance()
class PerChildModel extends Model {}

class FailingAsync extends AsyncService {
  public async resolve(): Promise<void> {
    throw new Error('FailingAsync failed');
  }
}

class AsyncAbac extends AsyncService {
  public async resolve(): Promise<void> {
    await new Promise((res) => setTimeout(res, 5));
    await super.resolve();
  }
}

function rootWithRbacAbac() {
  DI.register(Rbac).as(Model);
  DI.register(Abac).as(Model);
}

describe('child-chain (B29 DI part)', () => {
  beforeEach(() => {
    DI.clear();
  });

  it('Array.ofType keeps child-replaces-parent semantics', () => {
    rootWithRbacAbac();
    const child = DI.child();
    child.register(FsAbac).as(Model);

    const models = child.resolve(Array.ofType(Model));

    expect(models).to.have.length(1);
    expect(models[0]).to.be.instanceOf(FsAbac);
  });

  it('merges parent and child registrations, ancestors first', () => {
    rootWithRbacAbac();
    const child = DI.child();
    child.register(FsAbac).as(Model);

    const models = child.resolve(Array.chainOf(Model)) as Model[];

    expect(models).to.have.length(3);
    expect(models[0]).to.be.instanceOf(Rbac);
    expect(models[1]).to.be.instanceOf(Abac);
    expect(models[2]).to.be.instanceOf(FsAbac);
    expect(child.getRegisteredTypes(Array.chainOf(Model))).to.deep.equal([Rbac, Abac, FsAbac]);
  });

  it('root never sees child registrations', () => {
    rootWithRbacAbac();
    const child = DI.child();
    child.register(FsAbac).as(Model);

    const models = DI.resolve(Array.chainOf(Model)) as Model[];

    expect(models).to.have.length(2);
    expect(models[0]).to.be.instanceOf(Rbac);
    expect(models[1]).to.be.instanceOf(Abac);
  });

  it('reports the owner container of every chain entry', () => {
    rootWithRbacAbac();
    const child = DI.child();
    child.register(FsAbac).as(Model);

    const chain = child.Registry.getTypesChain(Model);

    expect(chain.map((e) => e.type)).to.deep.equal([Rbac, Abac, FsAbac]);
    expect(chain[0].container).to.equal(DI.RootContainer);
    expect(chain[1].container).to.equal(DI.RootContainer);
    expect(chain[2].container).to.equal(child);
  });

  it('a child class with the name of a parent class replaces it in place', () => {
    rootWithRbacAbac();
    const ChildAbac = class Abac extends Model {};
    const child = DI.child();
    child.register(FsAbac).as(Model);
    child.register(ChildAbac).as(Model);

    const chain = child.Registry.getTypesChain(Model);
    expect(chain.map((e) => e.type)).to.deep.equal([Rbac, ChildAbac, FsAbac]);
    expect(chain[1].container).to.equal(child);

    const models = child.resolve(Array.chainOf(Model)) as Model[];
    expect(models).to.have.length(3);
    expect(models[1]).to.be.instanceOf(ChildAbac);
    expect(models.some((m) => m.constructor === Abac)).to.equal(false);
  });

  it('resolves every type in the container that registered it', () => {
    rootWithRbacAbac();
    const child = DI.child();
    child.register(FsAbac).as(Model);

    const models = child.resolve(Array.chainOf(Model)) as Model[];

    expect(DI.get(Rbac)).to.equal(models[0]);
    expect(DI.resolve(Rbac)).to.equal(models[0]);
    expect(DI.get(Abac)).to.equal(models[1]);
    expect(child.Cache.has(Rbac)).to.equal(false);
    expect(child.Cache.has(Abac)).to.equal(false);

    expect(child.Cache.has(FsAbac)).to.equal(true);
    expect(DI.has(FsAbac)).to.equal(false);

    const again = child.resolve(Array.chainOf(Model)) as Model[];
    models.forEach((m, i) => expect(again[i]).to.equal(m));
  });

  it('leaves the Array.ofType collection cache alone', () => {
    rootWithRbacAbac();
    const child = DI.child();
    child.register(FsAbac).as(Model);

    child.resolve(Array.chainOf(Model));

    expect(DI.RootContainer.Cache.has(Array.ofType(Model))).to.equal(false);
    expect(child.Cache.has(Array.ofType(Model))).to.equal(false);

    const childModels = child.resolve(Array.ofType(Model));
    expect(childModels).to.have.length(1);
    expect(childModels[0]).to.be.instanceOf(FsAbac);

    const rootModels = DI.resolve(Array.ofType(Model));
    expect(rootModels).to.have.length(2);
  });

  it('a grandchild override by name skips the middle level', () => {
    rootWithRbacAbac();
    const child = DI.child();
    child.register(FsAbac).as(Model);
    const grandchild = child.child();
    const GrandchildAbac = class Abac extends Model {};
    grandchild.register(GrandchildAbac).as(Model);

    const chain = grandchild.Registry.getTypesChain(Model);
    expect(chain.map((e) => e.type)).to.deep.equal([Rbac, GrandchildAbac, FsAbac]);
    expect(chain[1].container).to.equal(grandchild);
    expect(chain[2].container).to.equal(child);
    expect(child.getRegisteredTypes(Array.chainOf(Model))).to.deep.equal([Rbac, Abac, FsAbac]);
  });

  it('merges string keys like class keys', () => {
    DI.register(Rbac).as('chain-model');
    DI.register(Rbac).as(Model);
    const child = DI.child();
    child.register(Abac).as('chain-model');
    child.register(Abac).as(Model);

    expect(child.getRegisteredTypes(Array.chainOf('chain-model'))).to.deep.equal([Rbac, Abac]);
    expect(child.getRegisteredTypes(Array.chainOf(Model))).to.deep.equal([Rbac, Abac]);
  });

  it('a level whose own list is empty contributes nothing and hides nothing', () => {
    rootWithRbacAbac();
    const child = DI.child();
    child.register(FsAbac).as(Model);
    child.unregister(FsAbac);

    expect(child.getRegisteredTypes(Model, false)).to.deep.equal([]);
    expect(child.resolve(Array.ofType(Model))).to.deep.equal([]);

    expect(child.getRegisteredTypes(Array.chainOf(Model))).to.deep.equal([Rbac, Abac]);
    const models = child.resolve(Array.chainOf(Model)) as Model[];
    expect(models.map((m) => m.constructor)).to.deep.equal([Rbac, Abac]);
  });

  it('follows a concrete override without growing the service list', () => {
    DI.register(Rbac).as(Model);
    DI.register(RbacV2).as(Rbac);
    const child = DI.child();

    const first = child.resolve(Array.chainOf(Model)) as Model[];
    const second = child.resolve(Array.chainOf(Model)) as Model[];

    expect(first).to.have.length(1);
    expect(first[0]).to.be.instanceOf(RbacV2);
    expect(second).to.have.length(1);
    expect(second[0]).to.equal(first[0]);
    expect(DI.RootContainer.getRegisteredTypes(Model, false)).to.deep.equal([Rbac]);
    expect(DI.RootContainer.getRegisteredTypes(Rbac, false)).to.deep.equal([RbacV2]);
  });

  it('resolves a PerChildContainer entry in the calling container', () => {
    DI.register(PerChildModel).as(Model);
    const child1 = DI.child();
    const child2 = DI.child();

    const inRoot = (DI.resolve(Array.chainOf(Model)) as Model[])[0];
    const inChild1 = (child1.resolve(Array.chainOf(Model)) as Model[])[0];
    const inChild2 = (child2.resolve(Array.chainOf(Model)) as Model[])[0];

    expect(inRoot).to.be.instanceOf(PerChildModel);
    expect(inChild1).to.be.instanceOf(PerChildModel);
    expect(inChild2).to.be.instanceOf(PerChildModel);
    expect(inChild1).to.not.equal(inRoot);
    expect(inChild2).to.not.equal(inRoot);
    expect(inChild1).to.not.equal(inChild2);
    expect((child1.resolve(Array.chainOf(Model)) as Model[])[0]).to.equal(inChild1);
    expect(child1.hasRegistered(PerChildModel, false)).to.equal(false);
    expect(child1.getRegisteredTypes(Model, false)).to.equal(null);
  });

  it('merges three levels', () => {
    DI.register(Rbac).as(Model);
    const child = DI.child();
    child.register(Abac).as(Model);
    const grandchild = child.child();
    grandchild.register(FsAbac).as(Model);

    expect(grandchild.getRegisteredTypes(Array.chainOf(Model))).to.deep.equal([Rbac, Abac, FsAbac]);
    expect(child.getRegisteredTypes(Array.chainOf(Model))).to.deep.equal([Rbac, Abac]);

    const models = grandchild.resolve(Array.chainOf(Model)) as Model[];
    expect(models.map((m) => m.constructor)).to.deep.equal([Rbac, Abac, FsAbac]);
    expect(child.Cache.has(Abac)).to.equal(true);
    expect(grandchild.Cache.has(Abac)).to.equal(false);
    expect(grandchild.Cache.has(FsAbac)).to.equal(true);
  });

  it('returns a promise when an element is an async service', async () => {
    DI.register(Rbac).as(Model);
    const child = DI.child();
    child.register(AsyncAbac).as(Model);

    const result = child.resolve(Array.chainOf(Model));
    expect(result).to.be.instanceOf(Promise);

    const models = await result;
    expect(models).to.have.length(2);
    expect(models[0]).to.be.instanceOf(Rbac);
    expect(models[1]).to.be.instanceOf(AsyncAbac);
    expect((models[1] as unknown as AsyncAbac).Resolved).to.equal(true);

    const cached = child.resolve(Array.chainOf(Model));
    expect(cached).to.be.instanceOf(Promise);
    expect((await cached)[1]).to.equal(models[1]);
  });

  it('always returns a promise for an AsyncService base, even for an empty chain', async () => {
    const result = DI.resolve(Array.chainOf(AsyncService));

    expect(result).to.be.instanceOf(Promise);
    expect(await result).to.deep.equal([]);
  });

  it('rejects when an async element fails', async () => {
    DI.register(Rbac).as(Model);
    DI.register(FailingAsync).as(Model);

    const result = DI.resolve(Array.chainOf(Model));

    expect(result).to.be.instanceOf(Promise);
    let error: Error | undefined;
    try {
      await result;
    } catch (err) {
      error = err as Error;
    }
    expect(error?.message).to.equal('FailingAsync failed');
  });

  it('returns a plain array when no element is async', () => {
    rootWithRbacAbac();

    expect(DI.resolve(Array.chainOf(Model))).to.be.an('array');
  });

  it('returns an empty array for an empty chain', () => {
    const child = DI.child();

    expect(child.getRegisteredTypes(Array.chainOf(NothingRegistered))).to.deep.equal([]);
    expect(child.Registry.getTypesChain(NothingRegistered)).to.deep.equal([]);
    expect(child.resolve(Array.chainOf(NothingRegistered))).to.deep.equal([]);
    expect(DI.resolve(Array.chainOf(NothingRegistered))).to.deep.equal([]);
  });

  it('keeps factories from every level, each called with its owner', () => {
    const seen: IContainer[] = [];
    DI.register((c: IContainer) => {
      seen.push(c);
      return { from: 'root' };
    }).as(Model);
    const child = DI.child();
    child.register((c: IContainer) => {
      seen.push(c);
      return { from: 'child' };
    }).as(Model);

    const models = child.resolve(Array.chainOf(Model)) as unknown as Array<{ from: string }>;

    expect(models.map((m) => m.from)).to.deep.equal(['root', 'child']);
    expect(seen).to.have.length(2);
    expect(seen[0]).to.equal(DI.RootContainer);
    expect(seen[1]).to.equal(child);
  });

  it('does not register anything into the child', () => {
    rootWithRbacAbac();
    const child = DI.child();
    child.register(FsAbac).as(Model);

    child.resolve(Array.chainOf(Model));

    expect(child.hasRegistered(Rbac, false)).to.equal(false);
    expect(child.hasRegistered(Abac, false)).to.equal(false);
    expect(child.hasRegistered(FsAbac, false)).to.equal(false);
    expect(child.getRegisteredTypes(Model, false)).to.deep.equal([FsAbac]);
    expect(DI.RootContainer.hasRegistered(Rbac, false)).to.equal(false);
    expect(DI.RootContainer.getRegisteredTypes(Model, false)).to.deep.equal([Rbac, Abac]);
  });

  it('a child replaces by name a root class that is also registered as self', () => {
    DI.register(Abac).as(Model);
    DI.register(Abac).asSelf();
    const ChildAbac = class Abac extends Model {};
    const child = DI.child();
    child.register(ChildAbac).as(Model);

    const chained = child.resolve(Array.chainOf(Model)) as Model[];
    const listed = child.resolve(Array.ofType(Model));

    expect(chained.map((m) => m.constructor)).to.deep.equal([ChildAbac]);
    expect(listed[0]).to.equal(chained[0]);
    expect(child.get(ChildAbac, false)).to.equal(chained[0]);
    expect((DI.resolve(Array.chainOf(Model)) as Model[])[0].constructor).to.equal(Abac);
  });

  it('a child replaces by name a root class that root has already resolved', () => {
    DI.register(Abac).as(Model);
    const fromRoot = DI.resolve(Abac);
    const ChildAbac = class Abac extends Model {};
    const child = DI.child();
    child.register(ChildAbac).as(Model);

    const chained = child.resolve(Array.chainOf(Model)) as Model[];

    expect(chained.map((m) => m.constructor)).to.deep.equal([ChildAbac]);
    expect(chained[0]).to.not.equal(fromRoot);
    expect(child.resolve(Array.ofType(Model))[0]).to.equal(chained[0]);
  });

  it('disposing a domain child disposes only what the child created', async () => {
    const disposed: unknown[] = [];

    class DomainModel extends SyncService {
      public async dispose() {
        disposed.push(this);
      }
    }

    class ModelConfig extends SyncService {
      public async dispose() {
        disposed.push(this);
      }
    }

    @Inject(ModelConfig)
    class RbacModel extends DomainModel {
      constructor(public config: ModelConfig) {
        super();
      }
    }

    @Inject(ModelConfig)
    class AbacModel extends DomainModel {
      constructor(public config: ModelConfig) {
        super();
      }
    }

    class FakeModel extends DomainModel {}
    const ChildRbacModel = class RbacModel extends DomainModel {};

    @PerChildInstance()
    class AuthzService extends SyncService {
      @Autoinject()
      public container: Container;

      public models: DomainModel[];

      public resolve() {
        this.models = this.container.resolve(Array.chainOf(DomainModel)) as DomainModel[];
        super.resolve();
      }

      public async dispose() {
        disposed.push(this);
      }
    }

    DI.register(RbacModel).as(DomainModel);
    DI.register(RbacModel).asSelf();
    DI.register(AbacModel).as(DomainModel);
    DI.register(AbacModel).asSelf();

    const rootService = DI.resolve(AuthzService);
    const rootRegistry = [...(DI.RootContainer.Registry as unknown as { registry: Map<string, unknown[]> }).registry.entries()].map(([k, v]) => [k, [...v]]);
    const rootCache = (DI.RootContainer as Container).getCacheStats().entries;
    const rootChildren = (DI.RootContainer as Container).getCacheStats().childrenCount;

    const child = DI.child();
    child.register(FakeModel).as(DomainModel);
    child.register(ChildRbacModel).as(DomainModel);
    const childService = child.resolve(AuthzService);

    expect(childService).to.not.equal(rootService);
    expect(childService.container).to.equal(child);
    expect(childService.models.map((m) => m.constructor)).to.deep.equal([ChildRbacModel, AbacModel, FakeModel]);
    expect(childService.models[1]).to.equal(rootService.models[1]);
    expect(rootService.models.map((m) => m.constructor)).to.deep.equal([RbacModel, AbacModel]);

    await child.dispose();

    expect(disposed).to.have.members([childService, childService.models[0], childService.models[2]]);
    expect(disposed).to.have.length(3);
    expect((DI.RootContainer as Container).getCacheStats().entries).to.deep.equal(rootCache);
    expect((DI.RootContainer as Container).getCacheStats().childrenCount).to.equal(rootChildren);
    expect([...(DI.RootContainer.Registry as unknown as { registry: Map<string, unknown[]> }).registry.entries()].map(([k, v]) => [k, [...v]])).to.deep.equal(rootRegistry);
    expect(DI.resolve(AuthzService)).to.equal(rootService);
    expect(DI.resolve(Array.chainOf(DomainModel))).to.deep.equal(rootService.models);
    (DI.resolve(Array.chainOf(DomainModel)) as DomainModel[]).forEach((m, i) => expect(m).to.equal(rootService.models[i]));
    expect((rootService.models[0] as RbacModel).config).to.equal((rootService.models[1] as AbacModel).config);
  });
});
