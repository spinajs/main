import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AccessControl } from 'accesscontrol';
import { DI } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { User } from '../src/models/User.js';
import type { IRbacAsyncStorage } from '../src/interfaces.js';
import { PermissionService, ResourceRules, usePermission, probeGrant, type PermissionVerb } from '../src/permission-service.js';

chai.use(chaiAsPromised);

const GRANTS = {
  admin: { TestRes: { 'create:any': ['*'], 'update:any': ['*'] }, Widget: { 'create:any': ['*'], 'update:any': ['*'] } },
  member: { TestRes: { 'create:own': ['*'], 'update:own': ['*'] }, Widget: { 'update:own': ['*'] } },
  viewer: { TestRes: { 'read:own': ['*'] }, Widget: { 'read:own': ['*'] } },
};

class CustomNoPermission extends Forbidden {}

/** Public wrappers over the protected surface — the test subject IS the base mechanics. */
class TestPermission extends PermissionService {
  protected readonly Resource = 'TestRes';

  public userOf(user?: User) {
    return this.user(user);
  }
  public rolesOf(user: User) {
    return this.effectiveRoles(user);
  }
  public scopeOf(user: User, verb: PermissionVerb) {
    return this.grantScope(user, verb);
  }
  public assert(verb: PermissionVerb, user?: User) {
    return this.assertGrant(verb, user);
  }
  public runAs<T>(user: User, fn: () => T | Promise<T>) {
    return this.withUser(user, fn);
  }
}

class CustomErrorPermission extends TestPermission {
  protected override noPermissionError(user: User, verb: PermissionVerb): Error {
    return new CustomNoPermission(`custom ${verb} refusal for ${user.Id}`);
  }
}

/** Detached instance — the User model needs a bootstrapped ORM connection to construct. */
function fakeUser(id: number, roles: string[]): User {
  const user = Object.create(User.prototype) as User;
  (user as { Id: number }).Id = id;
  (user as { Role: string[] }).Role = roles;
  return user;
}

describe('PermissionService', () => {
  let service: TestPermission;
  let store: AsyncLocalStorage<IRbacAsyncStorage>;

  before(() => {
    DI.register(new AccessControl()).asValue('AccessControl', true);
    store = DI.resolve(AsyncLocalStorage);
  });

  beforeEach(() => {
    DI.get<AccessControl>('AccessControl')!.setGrants(GRANTS);
    service = new TestPermission();
  });

  describe('acting user resolution', () => {
    it('an explicit user wins over the ambient one', () => {
      store.run({ User: fakeUser(7, ['member']) }, () => {
        expect(service.userOf(fakeUser(8, ['admin'])).Id).to.equal(8);
      });
    });

    it('falls back to the AsyncLocalStorage user', () => {
      store.run({ User: fakeUser(7, ['member']) }, () => {
        expect(service.userOf().Id).to.equal(7);
      });
    });

    it('throws when there is no user anywhere', () => {
      expect(() => service.userOf()).to.throw(Forbidden);
    });
  });

  describe('effective roles', () => {
    it('answers the full role list outside any context', () => {
      expect(service.rolesOf(fakeUser(1, ['member', 'admin']))).to.eql(['member', 'admin']);
    });

    it("ActiveRole narrows the store's own user to that single role", () => {
      const ambient = fakeUser(7, ['member', 'admin']);
      store.run({ User: ambient, ActiveRole: 'member' }, () => {
        expect(service.rolesOf(ambient)).to.eql(['member']);
      });
    });

    it('ActiveRole does NOT narrow a different user', () => {
      store.run({ User: fakeUser(7, ['member']), ActiveRole: 'member' }, () => {
        expect(service.rolesOf(fakeUser(8, ['admin']))).to.eql(['admin']);
      });
    });
  });

  describe('grant scope projection', () => {
    it('projects any, own and none', () => {
      expect(service.scopeOf(fakeUser(1, ['admin']), 'create')).to.equal('any');
      expect(service.scopeOf(fakeUser(1, ['member']), 'create')).to.equal('own');
      expect(service.scopeOf(fakeUser(1, ['viewer']), 'create')).to.equal('none');
    });

    it('any wins over own across a multi-role list', () => {
      expect(service.scopeOf(fakeUser(1, ['member', 'admin']), 'update')).to.equal('any');
    });

    it('an unknown role counts as none instead of leaking AccessControlError', () => {
      expect(service.scopeOf(fakeUser(1, ['ghost']), 'create')).to.equal('none');
    });

    it('projects through the ActiveRole narrowing for the ambient user', () => {
      const ambient = fakeUser(7, ['member', 'admin']);
      store.run({ User: ambient, ActiveRole: 'member' }, () => {
        expect(service.scopeOf(ambient, 'update')).to.equal('own');
      });
    });
  });

  describe('assertGrant', () => {
    it('answers the acting user and scope on a grant', () => {
      const { user, scope } = service.assert('create', fakeUser(1, ['member']));
      expect(user.Id).to.equal(1);
      expect(scope).to.equal('own');
    });

    it('throws Forbidden naming verb and resource when there is no grant', () => {
      expect(() => service.assert('delete', fakeUser(1, ['viewer']))).to.throw(Forbidden, /delete.*TestRes/);
    });

    it('a subclass error factory replaces the default error', () => {
      const custom = new CustomErrorPermission();
      expect(() => custom.assert('delete', fakeUser(1, ['viewer']))).to.throw(CustomNoPermission);
    });
  });

  describe('withUser', () => {
    it('a different user impersonates: User swapped, ActiveRole cleared, other store keys kept', async () => {
      await store.run({ User: fakeUser(7, ['member']), ActiveRole: 'member', Session: { fake: true } as never }, async () => {
        await service.runAs(fakeUser(8, ['admin']), () => {
          const inner = store.getStore()!;
          expect(inner.User!.Id).to.equal(8);
          expect(inner.ActiveRole).to.equal(undefined);
          expect(inner.Session).to.not.equal(undefined);
        });
      });
    });

    it("the store's own user reuses the ambient store untouched", async () => {
      const ambient = fakeUser(7, ['member']);
      await store.run({ User: ambient, ActiveRole: 'member' }, async () => {
        await service.runAs(ambient, () => {
          const inner = store.getStore()!;
          expect(inner.User!.Id).to.equal(7);
          expect(inner.ActiveRole).to.equal('member');
        });
      });
    });

    it('runs outside any ambient context too, and answers the callback result', async () => {
      await expect(service.runAs(fakeUser(1, ['admin']), async () => 42)).to.eventually.equal(42);
    });
  });

  describe('usePermission', () => {
    it('answers the DI-cached instance of the requested service', () => {
      const a = usePermission(TestPermission);
      const b = usePermission(TestPermission);

      expect(a).to.be.instanceOf(TestPermission);
      expect(a).to.equal(b);
    });

    it('refuses a class that is not a PermissionService', () => {
      class NotAPermission {}
      expect(() => usePermission(NotAPermission as never)).to.throw(/only PermissionService/);
    });
  });

  describe('probeGrant', () => {
    it('answers the accesscontrol Permission for a granted role and null for an unknown one', () => {
      expect(probeGrant(['admin'], 'createAny', 'TestRes')?.granted).to.equal(true);
      expect(probeGrant(['viewer'], 'createAny', 'TestRes')?.granted).to.equal(false);
      expect(probeGrant(['ghost'], 'createAny', 'TestRes')).to.equal(null);
    });
  });

  describe('class-based Resource', () => {
    /** Any class qualifies as a resource — this one is not a model, just a plain class. */
    class Widget {
      constructor(public id: number) {}
    }

    class Renamed {
      constructor(public id: number) {}
    }

    class WidgetPermission extends ResourceRules<Widget> {
      protected readonly Resource = Widget;
      public owned = new Set<number>();

      protected owns(_user: User, subject: Widget): boolean {
        return this.owned.has(subject.id);
      }
    }

    class RenamedPermission extends ResourceRules<Renamed> {
      protected readonly Resource = Renamed;
      protected owns(): boolean {
        return true;
      }
    }

    let widgets: WidgetPermission;

    beforeEach(() => {
      widgets = new WidgetPermission();
    });

    it("the class NAME is the grant key — no string restated, no metadata lookup", async () => {
      await widgets.assert('create', undefined, fakeUser(1, ['admin']));
    });

    it('a resource class unknown to the grants fails loud, not closed', async () => {
      // 'Renamed' appears in no grants map — the class-rename failure mode. Silent fail-closed
      // would refuse with the domain 403; the contract is a named programming error instead.
      await expect(new RenamedPermission().assert('update', new Renamed(1), fakeUser(1, ['admin']))).to.be.rejectedWith(/resource 'Renamed'.*not present/);
    });

    describe('assert', () => {
      it('any scope passes with or without a subject, never consulting owns()', async () => {
        const admin = fakeUser(1, ['admin']);
        await widgets.assert('update', new Widget(999), admin);
        await widgets.assert('create', undefined, admin);
      });

      it('none scope refuses with noPermissionError', async () => {
        await expect(widgets.assert('update', new Widget(1), fakeUser(1, ['ghost']))).to.be.rejectedWith(Forbidden, /no update grant/);
      });

      it('own scope passes when owns() answers true', async () => {
        widgets.owned = new Set([5]);
        await widgets.assert('update', new Widget(5), fakeUser(1, ['member']));
      });

      it('own scope refuses when owns() answers false', async () => {
        await expect(widgets.assert('update', new Widget(5), fakeUser(1, ['member']))).to.be.rejectedWith(Forbidden, /does not own/);
      });

      it('own scope refuses a missing subject — ownership of nothing is undecidable', async () => {
        await expect(widgets.assert('update', undefined, fakeUser(1, ['member']))).to.be.rejectedWith(Forbidden, /does not own/);
      });
    });
  });
});
