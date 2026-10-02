import 'mocha';
import { expect } from 'chai';

import { AsyncService, DI, IContainer, PerChildInstance } from '../src/index.js';

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

    const models = child.resolveChain(Model) as Model[];

    expect(models).to.have.length(3);
    expect(models[0]).to.be.instanceOf(Rbac);
    expect(models[1]).to.be.instanceOf(Abac);
    expect(models[2]).to.be.instanceOf(FsAbac);
    expect(child.getRegisteredTypesChain(Model)).to.deep.equal([Rbac, Abac, FsAbac]);
  });

  it('root never sees child registrations', () => {
    rootWithRbacAbac();
    const child = DI.child();
    child.register(FsAbac).as(Model);

    const models = DI.resolveChain(Model) as Model[];

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

    const models = child.resolveChain(Model) as Model[];
    expect(models).to.have.length(3);
    expect(models[1]).to.be.instanceOf(ChildAbac);
    expect(models.some((m) => m.constructor === Abac)).to.equal(false);
  });

  it('resolves every type in the container that registered it', () => {
    rootWithRbacAbac();
    const child = DI.child();
    child.register(FsAbac).as(Model);

    const models = child.resolveChain(Model) as Model[];

    expect(DI.get(Rbac)).to.equal(models[0]);
    expect(DI.resolve(Rbac)).to.equal(models[0]);
    expect(DI.get(Abac)).to.equal(models[1]);
    expect(child.Cache.has(Rbac)).to.equal(false);
    expect(child.Cache.has(Abac)).to.equal(false);

    expect(child.Cache.has(FsAbac)).to.equal(true);
    expect(DI.has(FsAbac)).to.equal(false);

    const again = child.resolveChain(Model) as Model[];
    models.forEach((m, i) => expect(again[i]).to.equal(m));
  });

  it('leaves the Array.ofType collection cache alone', () => {
    rootWithRbacAbac();
    const child = DI.child();
    child.register(FsAbac).as(Model);

    child.resolveChain(Model);

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
    expect(child.getRegisteredTypesChain(Model)).to.deep.equal([Rbac, Abac, FsAbac]);
  });

  it('merges string and Array.ofType keys like class keys', () => {
    DI.register(Rbac).as('chain-model');
    DI.register(Rbac).as(Model);
    const child = DI.child();
    child.register(Abac).as('chain-model');
    child.register(Abac).as(Model);

    expect(child.getRegisteredTypesChain('chain-model')).to.deep.equal([Rbac, Abac]);
    expect(child.getRegisteredTypesChain(Array.ofType(Model))).to.deep.equal([Rbac, Abac]);
  });

  it('a level whose own list is empty contributes nothing and hides nothing', () => {
    rootWithRbacAbac();
    const child = DI.child();
    child.register(FsAbac).as(Model);
    child.unregister(FsAbac);

    expect(child.getRegisteredTypes(Model, false)).to.deep.equal([]);
    expect(child.resolve(Array.ofType(Model))).to.deep.equal([]);

    expect(child.getRegisteredTypesChain(Model)).to.deep.equal([Rbac, Abac]);
    const models = child.resolveChain(Model) as Model[];
    expect(models.map((m) => m.constructor)).to.deep.equal([Rbac, Abac]);
  });

  it('follows a concrete override without growing the service list', () => {
    DI.register(Rbac).as(Model);
    DI.register(RbacV2).as(Rbac);
    const child = DI.child();

    const first = child.resolveChain(Model) as Model[];
    const second = child.resolveChain(Model) as Model[];

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

    const inRoot = (DI.resolveChain(Model) as Model[])[0];
    const inChild1 = (child1.resolveChain(Model) as Model[])[0];
    const inChild2 = (child2.resolveChain(Model) as Model[])[0];

    expect(inRoot).to.be.instanceOf(PerChildModel);
    expect(inChild1).to.be.instanceOf(PerChildModel);
    expect(inChild2).to.be.instanceOf(PerChildModel);
    expect(inChild1).to.not.equal(inRoot);
    expect(inChild2).to.not.equal(inRoot);
    expect(inChild1).to.not.equal(inChild2);
    expect((child1.resolveChain(Model) as Model[])[0]).to.equal(inChild1);
    expect(child1.hasRegistered(PerChildModel, false)).to.equal(false);
    expect(child1.getRegisteredTypes(Model, false)).to.equal(null);
  });

  it('merges three levels', () => {
    DI.register(Rbac).as(Model);
    const child = DI.child();
    child.register(Abac).as(Model);
    const grandchild = child.child();
    grandchild.register(FsAbac).as(Model);

    expect(grandchild.getRegisteredTypesChain(Model)).to.deep.equal([Rbac, Abac, FsAbac]);
    expect(child.getRegisteredTypesChain(Model)).to.deep.equal([Rbac, Abac]);

    const models = grandchild.resolveChain(Model) as Model[];
    expect(models.map((m) => m.constructor)).to.deep.equal([Rbac, Abac, FsAbac]);
    expect(child.Cache.has(Abac)).to.equal(true);
    expect(grandchild.Cache.has(Abac)).to.equal(false);
    expect(grandchild.Cache.has(FsAbac)).to.equal(true);
  });

  it('returns a promise when an element is an async service', async () => {
    DI.register(Rbac).as(Model);
    const child = DI.child();
    child.register(AsyncAbac).as(Model);

    const result = child.resolveChain(Model);
    expect(result).to.be.instanceOf(Promise);

    const models = await result;
    expect(models).to.have.length(2);
    expect(models[0]).to.be.instanceOf(Rbac);
    expect(models[1]).to.be.instanceOf(AsyncAbac);
    expect((models[1] as unknown as AsyncAbac).Resolved).to.equal(true);

    const cached = child.resolveChain(Model);
    expect(cached).to.be.instanceOf(Promise);
    expect((await cached)[1]).to.equal(models[1]);
  });

  it('always returns a promise for an AsyncService base, even for an empty chain', async () => {
    const result = DI.resolveChain(AsyncService);

    expect(result).to.be.instanceOf(Promise);
    expect(await result).to.deep.equal([]);
  });

  it('rejects when an async element fails', async () => {
    DI.register(Rbac).as(Model);
    DI.register(FailingAsync).as(Model);

    const result = DI.resolveChain(Model);

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

    expect(DI.resolveChain(Model)).to.be.an('array');
  });

  it('returns an empty array for an empty chain', () => {
    const child = DI.child();

    expect(child.getRegisteredTypesChain(NothingRegistered)).to.deep.equal([]);
    expect(child.Registry.getTypesChain(NothingRegistered)).to.deep.equal([]);
    expect(child.resolveChain(NothingRegistered)).to.deep.equal([]);
    expect(DI.resolveChain(NothingRegistered)).to.deep.equal([]);
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

    const models = child.resolveChain(Model) as unknown as Array<{ from: string }>;

    expect(models.map((m) => m.from)).to.deep.equal(['root', 'child']);
    expect(seen).to.have.length(2);
    expect(seen[0]).to.equal(DI.RootContainer);
    expect(seen[1]).to.equal(child);
  });

  it('does not register anything into the child', () => {
    rootWithRbacAbac();
    const child = DI.child();
    child.register(FsAbac).as(Model);

    child.resolveChain(Model);

    expect(child.hasRegistered(Rbac, false)).to.equal(false);
    expect(child.hasRegistered(Abac, false)).to.equal(false);
    expect(child.hasRegistered(FsAbac, false)).to.equal(false);
    expect(child.getRegisteredTypes(Model, false)).to.deep.equal([FsAbac]);
    expect(DI.RootContainer.hasRegistered(Rbac, false)).to.equal(false);
    expect(DI.RootContainer.getRegisteredTypes(Model, false)).to.deep.equal([Rbac, Abac]);
  });
});
