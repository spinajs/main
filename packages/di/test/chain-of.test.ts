import 'mocha';
import { expect } from 'chai';

import { AsyncService, Autoinject, ChainArray, Container, DI, Inject, Injectable, isTypedArray, getTypeName, _resolve } from '../src/index.js';

class Model {}
class Rbac extends Model {}
class Abac extends Model {}
class FsAbac extends Model {}

class AsyncModel extends AsyncService {}
class AsyncRbac extends AsyncModel {}

function rootAndChild() {
  DI.register(Rbac).as(Model);
  DI.register(Abac).as(Model);
  const child = DI.child();
  child.register(FsAbac).as(Model);
  return child;
}

describe('Array.chainOf', () => {
  beforeEach(() => {
    DI.clear();
  });

  it('is a typed array of the type it is built for', () => {
    const chain = Array.chainOf(Model);

    expect(chain).to.be.instanceOf(ChainArray);
    expect(isTypedArray(chain)).to.equal(true);
    expect(chain.Type).to.equal(Model);
    expect(getTypeName(chain)).to.equal('Model');
  });

  it('resolve merges the registrations of the whole lineage', () => {
    const child = rootAndChild();

    const models = child.resolve(Array.chainOf(Model)) as Model[];

    expect(models.map((m) => m.constructor)).to.deep.equal([Rbac, Abac, FsAbac]);
    expect(child.resolve(Array.ofType(Model)).map((m) => m.constructor)).to.deep.equal([FsAbac]);
  });

  it('DI.resolve and _resolve use the root container', () => {
    rootAndChild();

    expect((DI.resolve(Array.chainOf(Model)) as Model[]).map((m) => m.constructor)).to.deep.equal([Rbac, Abac]);
    expect((_resolve(Array.chainOf(Model))() as Model[]).map((m) => m.constructor)).to.deep.equal([Rbac, Abac]);
  });

  it('getRegisteredTypes lists the merged registrations, in resolve order', () => {
    const child = rootAndChild();
    const factory = () => new Rbac();
    child.register(factory).as(Model);

    expect(child.getRegisteredTypes(Array.chainOf(Model))).to.deep.equal([Rbac, Abac, FsAbac, factory]);
    expect(child.getRegisteredTypes(Array.chainOf(Model), false)).to.deep.equal([Rbac, Abac, FsAbac, factory]);
    expect(DI.getRegisteredTypes(Array.chainOf(Model))).to.deep.equal([Rbac, Abac]);
  });

  it('takes string keys', () => {
    DI.register(Rbac).as('chain-model');
    const child = DI.child();
    child.register(Abac).as('chain-model');

    expect((child.resolve(Array.chainOf<Model>('chain-model')) as Model[]).map((m) => m.constructor)).to.deep.equal([Rbac, Abac]);
  });

  it('nothing registered gives empty lists', () => {
    class Unknown {}

    expect(DI.child().getRegisteredTypes(Array.chainOf(Unknown))).to.deep.equal([]);
    expect(DI.child().resolve(Array.chainOf(Unknown))).to.deep.equal([]);
  });

  it('the strict check throws when nothing in the lineage registers the type', () => {
    class Unknown {}
    const child = rootAndChild();

    expect(() => child.resolve(Array.chainOf(Unknown), true)).to.throw('Type Unknown is not registered at container');
    expect(() => child.resolve(Array.chainOf(Unknown), [], true)).to.throw('Type Unknown is not registered at container');
    expect(child.resolve(Array.chainOf(Model), true)).to.have.length(3);
  });

  it('returns a promise over an async base type', async () => {
    DI.register(AsyncRbac).as(AsyncModel);

    const result = DI.child().resolve(Array.chainOf(AsyncModel));

    expect(result).to.be.instanceOf(Promise);
    expect((await result).map((m) => m.constructor)).to.deep.equal([AsyncRbac]);
  });

  it('get and isResolved refuse a chain', () => {
    const child = rootAndChild() as Container;

    expect(() => child.get(Array.chainOf(Model))).to.throw(/Array.chainOf/);
    expect(() => child.isResolved(Array.chainOf(Model))).to.throw(/Array.chainOf/);
  });

  it('@Autoinject(Array.chainOf(T)) injects the chain of the resolving container', () => {
    @Injectable()
    class Consumer {
      @Autoinject(Array.chainOf(Model))
      public models: Model[];
    }

    const child = rootAndChild();
    child.register(Consumer).asSelf();

    const consumer = child.resolve(Consumer);

    expect(consumer.models.map((m) => m.constructor)).to.deep.equal([Rbac, Abac, FsAbac]);
  });

  it('@Autoinject(Array.chainOf(T), { mapFunc }) maps the chain', () => {
    @Injectable()
    class Consumer {
      @Autoinject(Array.chainOf(Model), { mapFunc: (m: Model) => m.constructor.name })
      public models: Map<string, Model>;
    }

    const child = rootAndChild();
    child.register(Consumer).asSelf();

    expect([...child.resolve(Consumer).models.keys()]).to.deep.equal(['Rbac', 'Abac', 'FsAbac']);
  });

  it('@Inject(Array.chainOf(T)) passes the chain to the constructor', () => {
    @Inject(Array.chainOf(Model))
    class Consumer {
      constructor(public models: Model[]) {}
    }

    const child = rootAndChild();
    child.register(Consumer).asSelf();

    expect(child.resolve(Consumer).models.map((m) => m.constructor)).to.deep.equal([Rbac, Abac, FsAbac]);
  });

  it('@Inject does not treat Array.ofType(T) and Array.chainOf(T) as duplicates', () => {
    @Inject(Array.ofType(Model), Array.chainOf(Model))
    class Consumer {
      constructor(public own: Model[], public chain: Model[]) {}
    }

    const child = rootAndChild();
    child.register(Consumer).asSelf();
    const consumer = child.resolve(Consumer);

    expect(consumer.own.map((m) => m.constructor)).to.deep.equal([FsAbac]);
    expect(consumer.chain.map((m) => m.constructor)).to.deep.equal([Rbac, Abac, FsAbac]);
  });
});
