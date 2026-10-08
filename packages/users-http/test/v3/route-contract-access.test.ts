import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { parsePermission } from '@spinajs/authz';
import { accessDescriptorOf, ACCESS_CLASS } from '@spinajs/authz-http';
import type { IAccessRule } from '@spinajs/authz-http';
import { ACL_CONTROLLER_DESCRIPTOR, Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy } from '@spinajs/authn-http';
import { CONTROLLED_DESCRIPTOR_SYMBOL, IControllerDescriptor, IRoute, RouteType } from '@spinajs/http';

import { Users } from '../../src/admin/controllers/Users/Users.js';
import { Security } from '../../src/admin/controllers/Users/Security.js';
import { Profile } from '../../src/admin/controllers/Users/Profile.js';
import { TestConfiguration } from '../admin-common.js';

const controllerDescriptor = (instance: object): IControllerDescriptor => Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, instance) as IControllerDescriptor;

const routesOf = (instance: object): IRoute[] => [...controllerDescriptor(instance).Routes.values()];

/** The rule that guards a route: its own `@Access`, else the class's. */
const ruleOf = (instance: object, route: IRoute): IAccessRule | undefined => {
  const d = accessDescriptorOf(instance);
  return d?.Access.get(String(route.Method)) ?? d?.Access.get(ACCESS_CLASS);
};

const isAnonymous = (instance: object, route: IRoute): boolean => {
  const d = accessDescriptorOf(instance);
  return !!d && (d.Anonymous.has(String(route.Method)) || d.Anonymous.has(ACCESS_CLASS));
};

/**
 * The route descriptors the http and authz-http decorators produce for the admin controllers: the layer the
 * handler-level suites call past. No server is started.
 */
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
    it('every route of Users, Security and Profile carries @Access, none allows anonymous callers', () => {
      const unguarded: string[] = [];

      for (const { name, instance } of controllers) {
        for (const route of routesOf(instance)) {
          if (!ruleOf(instance, route) || isAnonymous(instance, route)) {
            unguarded.push(`${name}.${String(route.Method)}`);
          }
        }
      }

      expect(unguarded, 'routes without @Access are open to every logged-in user; anonymous admin routes are never meant').to.deep.eq([]);
    });

    it('every @Access names the users type', () => {
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
    it('write routes keep the any-case: one plain permission, no owner-only variant', () => {
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

    /** The permission of each route: the 2.x verb (readAny → read, createAny → create, ...) on the `users` type. */
    const PERMISSIONS: Record<string, string> = {
      'Users.list': 'users:read',
      'Users.assignableRoles': 'users:read',
      'Users.getSingleUser': 'users:read',
      'Users.getByLogin': 'users:read',
      'Users.addUser': 'users:create',
      'Users.updateUser': 'users:update',
      'Users.removeUser': 'users:delete',
      'Users.restoreUser': 'users:delete',
      'Security.activateUser': 'users:update',
      'Security.deactivateUser': 'users:delete',
      'Security.banUser': 'users:delete',
      'Security.unbanUser': 'users:update',
      'Security.listSessions': 'users:read',
      'Security.revokeSession': 'users:update',
      'Profile.getUserProfile': 'users:read',
    };

    it('every admin route checks one users permission, by the verb it had in 2.x', () => {
      const seen: Record<string, string> = {};

      for (const { name, instance } of controllers) {
        for (const route of routesOf(instance)) {
          seen[`${name}.${String(route.Method)}`] = ruleOf(instance, route)!.permissions.join(',');
        }
      }

      expect(seen).to.deep.eq(PERMISSIONS);
    });

    // In the @Access group (AND); a separate @Policy group would be an alternative to @Access (OR).
    it('the session routes also need a session caller that is not impersonating, as authn-http credential admin routes', () => {
      const security = controllers.find((c) => c.name === 'Security')!.instance;

      for (const method of ['listSessions', 'revokeSession']) {
        const route = controllerDescriptor(security).Routes.get(method)!;
        expect(ruleOf(security, route)!.options.also, method).to.deep.eq([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy]);
        expect(route.Policies, method).to.have.length(1);
      }
    });

    it('no admin route carries the 2.x @Permission or @Resource any more', () => {
      for (const { name, instance } of controllers) {
        expect(Reflect.getMetadata(ACL_CONTROLLER_DESCRIPTOR, instance), name).to.eq(undefined);
      }
    });
  });

  describe('http verbs', () => {
    /** Reading is the only thing GET is allowed to do here. */
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
