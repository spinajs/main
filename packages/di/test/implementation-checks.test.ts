import 'mocha';
import { expect } from 'chai';

import { DI, Container, Service, NewInstance, hasImplementation } from '../src/index.js';
import type { IContainer } from '../src/index.js';

abstract class RoleSource {
  public rolesOf(): string[] {
    return [];
  }
}
class RbacRoleSource extends RoleSource {}
class OtherRoleSource extends RoleSource {}

abstract class Failing {
  constructor() {
    throw new Error('cannot build');
  }
}

abstract class Hook {}
class HookA extends Hook {}

describe('implementation checks', () => {
  beforeEach(() => {
    DI.clear();
  });

  describe('a resolve of an unregistered class records nothing', () => {
    it('a bare resolve leaves check, hasRegistered and getRegisteredTypes false or empty', () => {
      DI.resolve(RoleSource);

      expect(DI.check(RoleSource)).to.eq(false);
      expect(DI.RootContainer.hasRegistered(RoleSource)).to.eq(false);
      expect(DI.getRegisteredTypes(RoleSource)).to.eq(null);
      expect(DI.RootContainer.resolveOptional(RoleSource)).to.eq(undefined);
    });

    it('a failed resolve leaves nothing registered', () => {
      expect(() => DI.resolve(Failing)).to.throw('cannot build');

      expect(DI.check(Failing)).to.eq(false);
      expect(DI.RootContainer.resolveOptional(Failing)).to.eq(undefined);
    });

    it('a bare resolve in a child records nothing there', () => {
      const child = DI.child();
      child.resolve(RoleSource);

      expect(child.hasRegistered(RoleSource, false)).to.eq(false);
      expect(child.getRegisteredTypes(RoleSource, false)).to.eq(null);
    });

    it('a later registration is the only implementation seen', () => {
      DI.resolve(RoleSource);
      DI.register(RbacRoleSource).as(RoleSource);
      DI.uncache(RoleSource);

      expect(DI.getRegisteredTypes(RoleSource)).to.deep.eq([RbacRoleSource]);
      expect(DI.RootContainer.resolveOptional(RoleSource)).to.be.instanceOf(RbacRoleSource);
    });

    it('the bare instance stays out of Array.ofType and Array.chainOf', () => {
      DI.resolve(Hook);

      expect(DI.resolve(Array.ofType(Hook))).to.deep.eq([]);
      expect(DI.resolve(Array.chainOf(Hook))).to.deep.eq([]);
      expect(DI.getRegisteredTypes(Array.chainOf(Hook))).to.deep.eq([]);

      DI.register(HookA).as(Hook);

      expect(DI.resolve(Array.ofType(Hook)).map((h) => h.constructor)).to.deep.eq([HookA]);
      expect((DI.resolve(Array.chainOf(Hook)) as Hook[]).map((h) => h.constructor)).to.deep.eq([HookA]);
    });

    it('a bare singleton is still reused by later resolves', () => {
      const first = DI.resolve(RoleSource);

      expect(DI.resolve(RoleSource)).to.equal(first);
      expect(DI.get(RoleSource)).to.equal(first);
    });

    it('a class registered as itself after a bare resolve joins Array.ofType with its singleton', () => {
      class Plain {}
      const bare = DI.resolve(Plain);
      DI.register(Plain).asSelf();

      expect(DI.resolve(Array.ofType(Plain))).to.deep.eq([bare]);
    });

    it('an unregistered string key resolves to null and stays unregistered', () => {
      expect(DI.resolve('TokenProfilePolicy')).to.eq(null);
      expect(DI.check('TokenProfilePolicy')).to.eq(false);
    });
  });

  describe('hasImplementation', () => {
    it('is false while nothing is registered, also after a bare resolve', () => {
      DI.resolve(RoleSource);

      expect(DI.hasImplementation(RoleSource)).to.eq(false);
      expect(hasImplementation(RoleSource)).to.eq(false);
      expect(DI.RootContainer.hasImplementation(RoleSource)).to.eq(false);
    });

    it('does not count the class registered as itself', () => {
      DI.register(RoleSource).asSelf();

      expect(DI.check(RoleSource)).to.eq(true);
      expect(DI.hasImplementation(RoleSource)).to.eq(false);

      DI.register(RbacRoleSource).as(RoleSource);
      expect(DI.hasImplementation(RoleSource)).to.eq(true);
    });

    it('counts a factory and a string key', () => {
      DI.register(() => new OtherRoleSource()).as(RoleSource);
      DI.register(RbacRoleSource).as('RoleSourceByName');

      expect(DI.hasImplementation(RoleSource)).to.eq(true);
      expect(DI.hasImplementation('RoleSourceByName')).to.eq(true);
      expect(DI.hasImplementation('Unknown')).to.eq(false);
    });

    it('looks into the parent unless told not to', () => {
      DI.register(RbacRoleSource).as(RoleSource);
      const child = DI.child();

      expect(child.hasImplementation(RoleSource)).to.eq(true);
      expect(child.hasImplementation(RoleSource, false)).to.eq(false);
    });

    it('turns false again once the implementation is unregistered', () => {
      DI.register(RbacRoleSource).as(RoleSource);
      DI.unregister(RbacRoleSource);

      expect(DI.hasImplementation(RoleSource)).to.eq(false);
    });
  });

  describe('isCached', () => {
    it('is true for an instance this container holds', () => {
      DI.register(RbacRoleSource).as(RoleSource);
      const instance = DI.resolve(RoleSource);

      expect(DI.RootContainer.isCached(instance)).to.eq(true);
      expect(DI.RootContainer.isCached(new RbacRoleSource())).to.eq(false);
    });

    it('a NewInstance class is never cached', () => {
      @NewInstance()
      class Fresh {}

      expect(DI.RootContainer.isCached(DI.resolve(Fresh))).to.eq(false);
    });

    it('looks into ancestors only when asked', () => {
      const instance = DI.resolve(RbacRoleSource);
      const child = DI.child();

      expect(child.isCached(instance)).to.eq(false);
      expect(child.isCached(instance, true)).to.eq(true);
    });

    it('is true for a plain value added to the cache', () => {
      const value = { name: 'value' };
      DI.register(value).asValue('some-value');

      expect(DI.RootContainer.isCached(value)).to.eq(true);
    });
  });

  describe('unregister by identity', () => {
    it('removes the one factory, not every factory sharing its name', () => {
      const a = () => new RbacRoleSource();
      const b = () => new OtherRoleSource();
      DI.register(a).as(RoleSource);
      DI.register(b).as(RoleSource);

      DI.RootContainer.Registry.unregister(RoleSource, a);

      expect(DI.getRegisteredTypes(RoleSource)).to.deep.eq([b]);
    });

    it('leaves the implementation under other keys', () => {
      DI.register(RbacRoleSource).as(RoleSource);
      DI.register(RbacRoleSource).as('ByName');

      DI.unregister(RoleSource, RbacRoleSource);

      expect(DI.check(RoleSource)).to.eq(false);
      expect(DI.getRegisteredTypes('ByName')).to.deep.eq([RbacRoleSource]);
    });

    it('drops the key with its last entry, so a child falls back to the parent', () => {
      DI.register(RbacRoleSource).as(RoleSource);
      const child = DI.child();
      const factory = () => new OtherRoleSource();
      child.register(factory).as(RoleSource);

      child.unregister(RoleSource, factory);

      expect(child.hasRegistered(RoleSource, false)).to.eq(false);
      expect(child.resolve(RoleSource)).to.be.instanceOf(RbacRoleSource);
    });

    it('ignores an implementation that is not registered under the key', () => {
      DI.register(RbacRoleSource).as(RoleSource);

      DI.unregister(RoleSource, OtherRoleSource);

      expect(DI.getRegisteredTypes(RoleSource)).to.deep.eq([RbacRoleSource]);
    });
  });

  describe('dispose of plain owners', () => {
    class Model {
      public disposed = 0;
      public dispose() {
        this.disposed++;
      }
    }

    class Svc extends Service {
      public disposed = 0;
      public async dispose() {
        this.disposed++;
      }
    }

    abstract class ModelBase {}
    class ModelImpl extends Model implements ModelBase {}

    it('leaves plain dispose() owners alone by default', async () => {
      const child = DI.child();
      const model = child.resolve(Model);

      await child.dispose();

      expect(model.disposed).to.eq(0);
    });

    it('disposes each plain owner once, Services as before, the container not again', async () => {
      const child = DI.child();
      child.register(ModelImpl).as(ModelBase);
      const model = child.resolve(Model);
      const listed = child.resolve(Array.ofType(ModelBase))[0] as ModelImpl;
      const svc = child.resolve(Svc);

      await child.dispose({ plainOwners: true });

      expect(model.disposed).to.eq(1);
      expect(listed.disposed).to.eq(1);
      expect(svc.disposed).to.eq(1);
    });

    it('passes the option to child containers', async () => {
      const child = DI.child();
      const grandChild = child.child();
      const model = grandChild.resolve(Model);

      await child.dispose({ plainOwners: true });

      expect(model.disposed).to.eq(1);
    });

    it('leaves instances owned by the parent alone', async () => {
      const model = DI.resolve(Model);
      const child = DI.child();
      expect(child.resolve(Model)).to.equal(model);

      await child.dispose({ plainOwners: true });

      expect(model.disposed).to.eq(0);
    });
  });

  describe('typing', () => {
    it('hasRegistered, hasImplementation, resolveOptional and check take an abstract class without a cast', () => {
      const c: IContainer = new Container();
      const token: abstract new (...args: never[]) => RoleSource = RoleSource;

      expect(c.hasRegistered(RoleSource)).to.eq(false);
      expect(c.hasRegistered(token)).to.eq(false);
      expect(c.hasImplementation(token)).to.eq(false);
      expect(DI.check(token)).to.eq(false);
      const optional: RoleSource | undefined = c.resolveOptional(RoleSource);
      expect(optional).to.eq(undefined);
    });
  });
});
