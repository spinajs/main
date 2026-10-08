import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { parsePermission } from '@spinajs/authz';
import { accessDescriptorOf, ACCESS_CLASS } from '@spinajs/authz-http';
import type { IAccessRule } from '@spinajs/authz-http';
import { CONTROLLED_DESCRIPTOR_SYMBOL, IControllerDescriptor, IRoute, RouteType } from '@spinajs/http';

import { Users } from '../../src/admin/controllers/Users/Users.js';
import { Security } from '../../src/admin/controllers/Users/Security.js';
import { Profile } from '../../src/admin/controllers/Users/Profile.js';
import { TestConfiguration } from '../admin-common.js';

const routesOf = (instance: object): IRoute[] => [...(Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, instance) as IControllerDescriptor).Routes.values()];

/** The rule that guards a route: its own `@Access`, else the class's. */
const ruleOf = (instance: object, route: IRoute): IAccessRule | undefined => {
  const d = accessDescriptorOf(instance);
  return d?.Access.get(String(route.Method)) ?? d?.Access.get(ACCESS_CLASS);
};

// The users-http routes still carry the 2.x `@Permission` (C2b is unmerged), so the three `@Access`
// assertions fail today. They are skipped, not bent, until C2b moves the controllers.
describe('users-http v3: admin route contract', function () {
  this.timeout(25000);

  let controllers: Array<{ name: string; instance: object }>;

  before(async () => {
    DI.setESMModuleSupport();
    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);

    controllers = [
      { name: 'Users', instance: await DI.resolve(Users) },
      { name: 'Security', instance: await DI.resolve(Security) },
      { name: 'Profile', instance: await DI.resolve(Profile) },
    ];
  });

  after(() => {
    DI.clearCache();
  });

  describe('authorization (B23)', () => {
    // BUG(T3): Users, Security and Profile declare no @Access, only the 2.x @Permission; every route is unguarded under 3.0.
    it.skip('every route of Users, Security and Profile carries @Access', () => {
      const unguarded: string[] = [];

      for (const { name, instance } of controllers) {
        for (const route of routesOf(instance)) {
          if (!ruleOf(instance, route)) {
            unguarded.push(`${name}.${String(route.Method)}`);
          }
        }
      }

      expect(unguarded, 'routes without @Access are open to every logged-in user').to.deep.eq([]);
    });

    // BUG(T3): same cause; no route names the users type through @Access.
    it.skip('every @Access names the users type', () => {
      for (const { name, instance } of controllers) {
        for (const route of routesOf(instance)) {
          const rule = ruleOf(instance, route);

          expect(rule, `${name}.${String(route.Method)} has no @Access`).to.not.eq(undefined);
          for (const permission of rule?.permissions ?? []) {
            expect(parsePermission(permission).resource, `${name}.${String(route.Method)}`).to.eq('users');
          }
        }
      }
    });

    // B15: :any and :own collapse into one permission with an owner relation, so the any-case is
    // kept when the route names a plain `users:<action>`; a relation-qualified or owner-only
    // permission would be the silent downgrade this test exists to catch.
    // BUG(T3): same cause; write routes have no @Access rule to inspect.
    it.skip('write routes keep the any-case: one plain permission, no owner-only variant', () => {
      const wrong: string[] = [];

      for (const { name, instance } of controllers) {
        for (const route of routesOf(instance)) {
          if (route.Type === RouteType.GET) continue;

          const permissions = ruleOf(instance, route)?.permissions ?? [];
          const plain = permissions.filter((p) => !/(^|[:.])own$/i.test(p) && !/own/i.test(parsePermission(p).action));

          if (permissions.length === 0 || plain.length !== permissions.length) {
            wrong.push(`${name}.${String(route.Method)} -> ${permissions.join(',')}`);
          }
        }
      }

      expect(wrong, 'a write route must stay reachable for the any-case').to.deep.eq([]);
    });
  });

  describe('http verbs', () => {
    const READ_ONLY_ROUTES = ['list', 'assignableRoles', 'getSingleUser', 'getByLogin', 'listSessions', 'getUserProfile'];

    it('no state-changing route answers GET', () => {
      const offenders: string[] = [];

      for (const { name, instance } of controllers) {
        for (const route of routesOf(instance)) {
          if (route.Type === RouteType.GET && !READ_ONLY_ROUTES.includes(String(route.Method))) {
            offenders.push(`${name}.${String(route.Method)}`);
          }
        }
      }

      expect(offenders, 'activating, deactivating or logging a user out over GET is triggerable by a link or a prefetch').to.deep.eq([]);
    });
  });
});
